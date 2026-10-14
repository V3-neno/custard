import { readFileSync, renameSync, writeFileSync } from 'fs'
import type { ChatUsage, Conversation, UsageMonth } from '../shared/chat'
import { costOf, noUsage, type TokenUsage } from '../shared/pricing'

// What Custard's model calls used and cost: per chat (on the chat itself) and
// per month (in one small file in app data), so the chat can show its cost
// and Settings can hold a monthly budget. Costs are estimates from the
// published rates in shared/pricing; the provider's bill is what counts.

export type Totals = { cost: number; calls: number; unpriced: number }
type Ledger = { months: Record<string, Totals> }
const KEEP_MONTHS = 24

const month = (t: number): string => {
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

type ClaudeTokens = {
  input_tokens?: number | null
  output_tokens?: number | null
  cache_creation_input_tokens?: number | null
  cache_read_input_tokens?: number | null
}
type ClaudeUsage =
  | (ClaudeTokens & {
      server_tool_use?: { web_search_requests?: number | null } | null
      // Set when the request ran more than one step on the server
      // (compaction, a refusal fallback): each step's own tokens, which the
      // top-level counts don't all include.
      iterations?: (ClaudeTokens & { model?: string | null })[] | null
    })
  | null
  | undefined

const claudeTokens = (u: ClaudeTokens | null | undefined): TokenUsage => ({
  input: u?.input_tokens ?? 0,
  cacheWrite: u?.cache_creation_input_tokens ?? 0,
  cacheRead: u?.cache_read_input_tokens ?? 0,
  output: u?.output_tokens ?? 0,
  webSearches: 0
})

// Claude's `usage` block, one part per model that ran (a fallback answers as
// another model, priced as that one). input_tokens excludes what was read
// from or written to the cache.
export function claudeParts(u: ClaudeUsage, model: string): { model: string; usage: TokenUsage }[] {
  const searches = u?.server_tool_use?.web_search_requests ?? 0
  const steps = u?.iterations?.length
    ? u.iterations.map((i) => ({ model: i.model || model, usage: claudeTokens(i) }))
    : [{ model, usage: claudeTokens(u) }]
  steps[steps.length - 1].usage.webSearches = searches
  return steps
}

// All of a Claude call's usage as one figure, for calls to a single model.
export const fromClaude = (u: ClaudeUsage): TokenUsage =>
  claudeParts(u, '').reduce((sum, p) => addUsage(sum, p.usage), noUsage())

// OpenAI's Responses `usage`: input_tokens includes the cached part, and
// output_tokens includes reasoning. Web searches are counted from the
// response's web_search_call items.
export function fromOpenAI(
  u:
    | {
        input_tokens?: number | null
        output_tokens?: number | null
        input_tokens_details?: { cached_tokens?: number | null } | null
      }
    | null
    | undefined,
  webSearches = 0
): TokenUsage {
  const cached = u?.input_tokens_details?.cached_tokens ?? 0
  return {
    input: Math.max(0, (u?.input_tokens ?? 0) - cached),
    cacheWrite: 0,
    cacheRead: cached,
    output: u?.output_tokens ?? 0,
    webSearches
  }
}

export const addUsage = (a: TokenUsage, b: TokenUsage): TokenUsage => ({
  input: a.input + b.input,
  cacheWrite: a.cacheWrite + b.cacheWrite,
  cacheRead: a.cacheRead + b.cacheRead,
  output: a.output + b.output,
  webSearches: a.webSearches + b.webSearches
})

const isEmpty = (u: TokenUsage): boolean =>
  !u.input && !u.cacheWrite && !u.cacheRead && !u.output && !u.webSearches

// A positive number of dollars up to a million, or null.
export function normalizeBudget(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 1_000_000
    ? Math.round(v * 100) / 100
    : null
}

export class UsageLedger {
  constructor(
    private file: string,
    private now: () => number = Date.now
  ) {}

  private read(): Ledger {
    try {
      const l = JSON.parse(readFileSync(this.file, 'utf8')) as Ledger
      return l && typeof l.months === 'object' && l.months ? l : { months: {} }
    } catch {
      return { months: {} }
    }
  }

  // Adds one call to this month. Returns its cost (null: unknown price).
  add(model: string, u: TokenUsage): number | null {
    const cost = costOf(model, u)
    const l = this.read()
    const key = month(this.now())
    const m = l.months[key] ?? { cost: 0, calls: 0, unpriced: 0 }
    m.calls++
    if (cost === null) m.unpriced++
    else m.cost += cost
    l.months[key] = m
    for (const old of Object.keys(l.months).sort().slice(0, -KEEP_MONTHS)) delete l.months[old]
    try {
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify(l))
      renameSync(tmp, this.file)
    } catch (err) {
      console.error('Usage:', err)
    }
    return cost
  }

  thisMonth(budget: number | null): UsageMonth {
    const key = month(this.now())
    return {
      month: key,
      ...(this.read().months[key] ?? { cost: 0, calls: 0, unpriced: 0 }),
      budget
    }
  }
}

// Adds a call to a chat's own totals. The caller saves the chat.
export function chargeChat(c: Conversation, u: TokenUsage, cost: number | null): void {
  const prev: ChatUsage = c.usage ?? { ...noUsage(), cost: 0, calls: 0, unpriced: 0 }
  c.usage = {
    ...addUsage(prev, u),
    cost: prev.cost + (cost ?? 0),
    calls: prev.calls + 1,
    unpriced: prev.unpriced + (cost === null ? 1 : 0)
  }
}

export type Charge = (chat: Conversation | string | null, model: string, u: TokenUsage) => void

// The app's charge function: the ledger, plus the chat when there is one. A
// chat given as an object (a turn in progress) is changed in place and saved
// with the turn; one given by id is changed and saved now.
export function charger(
  ledger: UsageLedger,
  update: (id: string, change: (c: Conversation) => void) => unknown
): Charge {
  return (chat, model, u) => {
    try {
      if (isEmpty(u)) return
      const cost = ledger.add(model, u)
      if (chat === null) return
      if (typeof chat === 'string') update(chat, (c) => chargeChat(c, u, cost))
      else chargeChat(chat, u, cost)
    } catch (err) {
      console.error('Usage:', err)
    }
  }
}
