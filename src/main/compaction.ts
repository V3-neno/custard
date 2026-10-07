import type {
  BetaContentBlock,
  BetaMessageParam
} from '@anthropic-ai/sdk/resources/beta/messages/messages'
import type {
  ResponseCompactionItem,
  ResponseInputItem
} from 'openai/resources/responses/responses'
import type { Conversation } from '../shared/chat'
import { limitsFor } from './context'

// Provider compaction: the provider summarizes everything before a point and
// later requests send that summary instead. Custard keeps every message as it
// was (the chat shows them all and the action records never change); only
// what is sent shrinks. Each provider's compaction stays with that provider.

// Models that turned compaction down in this session (a 400 naming it), so
// the next request goes without it instead of failing again.
const refused = new Set<string>()
export const compactionRefused = (model: string): void => void refused.add(model)
export const usesCompaction = (model: string): boolean =>
  limitsFor(model).compaction && !refused.has(model)

// A 400 that names the compaction setting: the model or account doesn't take it.
export const isCompactionRejected = (err: unknown): boolean => {
  const e = err as { status?: number; message?: string }
  return e?.status === 400 && /compact|context_management|context-management/i.test(e.message ?? '')
}

// Claude history for one model. Compaction blocks go only to a model that
// compacts; any other model gets the full history without them (the blocks
// are model output, so leaving them out is not a rewrite of what the user
// or a tool said). A message left with nothing in it is dropped.
export function claudeHistory(messages: BetaMessageParam[], model: string): BetaMessageParam[] {
  if (usesCompaction(model)) return messages
  let changed = false
  const out = messages.flatMap((m) => {
    if (typeof m.content === 'string' || !m.content.some((b) => b.type === 'compaction')) return [m]
    changed = true
    const content = m.content.filter((b) => b.type !== 'compaction')
    return content.length ? [{ ...m, content }] : []
  })
  return changed ? out : messages
}

// Records a Claude compaction: the block stays in the assistant message at
// `after`, which the API drops everything before.
export function recordClaudeCompaction(
  c: Conversation,
  content: BetaContentBlock[],
  model: string,
  now = Date.now()
): boolean {
  if (!content.some((b) => b.type === 'compaction')) return false
  ;(c.compactions ??= []).push({ after: c.messages.length, at: now, provider: 'claude', model })
  return true
}

// Records an OpenAI compaction item. It stands for everything sent before
// it, so it is placed before the assistant message the same response adds.
export function recordOpenAICompaction(
  c: Conversation,
  item: ResponseCompactionItem,
  model: string,
  now = Date.now()
): void {
  ;(c.compactions ??= []).push({
    after: c.messages.length,
    at: now,
    provider: 'openai',
    model,
    item: { id: item.id, encrypted_content: item.encrypted_content }
  })
}

// Where an OpenAI request starts: the newest compaction item from this same
// model, then the messages after it. Items from another model are not sent
// (whether one model accepts another's is not documented).
export function openaiStart(
  c: Conversation,
  model: string
): { item: ResponseInputItem | null; from: number } {
  if (!usesCompaction(model)) return { item: null, from: 0 }
  const k = [...(c.compactions ?? [])]
    .reverse()
    .find(
      (x) => x.provider === 'openai' && x.model === model && x.item && x.after <= c.messages.length
    )
  return k?.item
    ? { item: { type: 'compaction', ...k.item }, from: k.after }
    : { item: null, from: 0 }
}

// Within a turn: after output with a compaction item is appended, items
// before the newest one can be left out (OpenAI's compaction guide).
export function dropBeforeCompaction(input: ResponseInputItem[]): ResponseInputItem[] {
  const i = input.map((x) => x.type).lastIndexOf('compaction')
  return i > 0 ? input.slice(i) : input
}
