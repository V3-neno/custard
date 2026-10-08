import type { Continuation, ContinueResult, Conversation } from '../shared/chat'
import {
  actionLedger,
  carriedFiles,
  carriedUnknown,
  handoffEvidence,
  type HandoffSummarizer,
  type HandoffSummary
} from './handoff'

// Continue in a new chat. The original is read, never written: its messages,
// actions and memory stay exactly as they were. Nothing is created until the
// summary is ready (or the user chose to go on without one), so a failed
// summary or a restart in the middle leaves only the original.

const EARLIER_LEDGER = 6_000

// Short, without the provider's raw error body.
function describe(err: unknown): string {
  const e = err as { status?: number; name?: string; message?: string }
  if (e?.name === 'AbortError') return 'it was stopped.'
  if (typeof e?.status === 'number') return `the provider returned an error (${e.status}).`
  return err instanceof Error ? err.message : String(err)
}

export type ContinueDeps = {
  load: (id: string) => Conversation | null
  create: (mode: Conversation['mode'], title: string) => Conversation
  save: (c: Conversation) => void
  // For the provider the original was last sent to; null without a key.
  summarizer: (original: Conversation) => HandoffSummarizer | null
  now?: () => number
}

export async function continueChat(
  deps: ContinueDeps,
  id: string,
  opts: { withoutSummary?: boolean; signal?: AbortSignal } = {}
): Promise<ContinueResult> {
  const original = deps.load(id)
  if (!original) return { ok: false, error: "That chat couldn't be found.", canSkipSummary: false }
  const ledger = actionLedger(original)
  let summary: HandoffSummary | null = null
  if (!opts.withoutSummary) {
    const summarize = deps.summarizer(original)
    if (!summarize)
      return {
        ok: false,
        error: 'There is no API key to write the summary with.',
        canSkipSummary: true
      }
    try {
      summary = await summarize(handoffEvidence(original, ledger.text), opts.signal)
    } catch (err) {
      return {
        ok: false,
        error: `Couldn't write the summary: ${describe(err)}`,
        canSkipSummary: true
      }
    }
  }
  // A chat that was itself a continuation passes on the record before it.
  const earlier = original.continuedFrom
    ? `\n\nFrom the chat before that ("${original.continuedFrom.from.title}"):\n${original.continuedFrom.ledger.slice(0, EARLIER_LEDGER)}`
    : ''
  const from: Continuation = {
    from: { id: original.id, title: original.title },
    summary,
    ledger: ledger.text + earlier,
    counts: ledger.counts,
    unknown: carriedUnknown(original),
    ...carriedFiles(original),
    at: deps.now?.() ?? Date.now()
  }
  const next = deps.create(original.mode, `${original.title} (continued)`)
  next.continuedFrom = from
  if (original.workspace) next.workspace = original.workspace
  // Not remembering the original carries over; continuing is not permission
  // to remember what it said.
  const m = original.memory
  if (m?.temporary) next.memory = { off: true, temporary: true, watermark: 0 }
  else if (m?.off || m?.forgotten) next.memory = { off: true, watermark: 0 }
  deps.save(next)
  return { ok: true, conversation: next }
}

// A chat's continuations, and theirs, for Forget.
export function continuationsOf(all: Conversation[], id: string): Conversation[] {
  const out: Conversation[] = []
  const walk = (from: string): void => {
    for (const c of all)
      if (c.continuedFrom?.from.id === from && !out.includes(c)) {
        out.push(c)
        walk(c.id)
      }
  }
  walk(id)
  return out
}
