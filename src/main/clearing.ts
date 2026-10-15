import type {
  BetaContentBlockParam,
  BetaMessageParam
} from '@anthropic-ai/sdk/resources/beta/messages/messages'
import type { ActionRecord, Conversation } from '../shared/chat'

// Clearing old tool results: the cheap step before compaction. Pages, notes
// and plugin output the model read a few turns ago are usually spent, but
// every request sends them again. Custard replaces each such result with a
// one-line stub saying what it was and how it ended; the saved chat keeps
// it in full and the action record keeps its outcome.
//
// What is cleared is everything before a mark (Conversation.cleared) that
// only moves forward, in jumps, and only at the start of a turn. Between
// jumps the requests start the same way, so the provider's prompt cache
// keeps hitting (see promptCache). A jump changes the history, so the next
// request is billed in full once; it is made:
// - when that request would miss the cache anyway (cold, or something
//   before the messages changed), and enough can be cleared to be worth it;
// - or when the chat is nearing compaction and much can be cleared, since
//   clearing costs no model call and loses less than a summary.
// Results from the newest turns, small results, errors and actions with an
// unknown outcome are never cleared.

export const CLEAR_LIMITS = {
  // Results from this many of the newest turns are kept, counting the one
  // just starting: it and the two before it.
  keepTurns: 3,
  // Smaller results are kept: they cost little and often say how something
  // ended.
  minResultChars: 2_000,
  // Least worth clearing, in estimated tokens, when the cache misses anyway.
  minWhenFree: 5_000,
  // Near compaction (this share of the trigger), clear when at least this
  // much can go.
  near: 0.8,
  minWhenNear: 20_000
}

// Custard's estimate elsewhere (context.estimateTokens): 3 characters a token.
const tokens = (chars: number): number => Math.ceil(chars / 3)

type Message = BetaMessageParam
type ToolResult = Extract<BetaContentBlockParam, { type: 'tool_result' }>

const isToolResults = (m: Message): boolean =>
  typeof m.content !== 'string' && m.content.some((b) => b.type === 'tool_result')

// A message the user typed (not tool results).
const typed = (m: Message): boolean => m.role === 'user' && !isToolResults(m)

const resultChars = (b: ToolResult): number =>
  typeof b.content === 'string' ? b.content.length : JSON.stringify(b.content ?? '').length

// Whether a result may be replaced by a stub.
function clearable(b: ToolResult, action: ActionRecord | undefined): boolean {
  if (b.is_error || !action) return false
  // Only settled actions whose outcome is known.
  if (!['completed', 'failed', 'not-run'].includes(action.status)) return false
  return resultChars(b) >= CLEAR_LIMITS.minResultChars
}

// Where clearing may reach: the start of the turn `keepTurns` turns back.
// Everything from there on is kept. 0 when the chat has fewer turns.
export function keepFrom(messages: Message[], keepTurns = CLEAR_LIMITS.keepTurns): number {
  let seen = 0
  for (let i = messages.length - 1; i >= 0; i--)
    if (typed(messages[i]) && ++seen === keepTurns) return i
  return 0
}

// Estimated tokens a mark at `to` would clear that aren't cleared yet,
// counting only what is sent (from the newest compaction on).
export function clearableTokens(
  messages: Message[],
  actions: Conversation['actions'],
  from: number,
  to: number
): number {
  let chars = 0
  for (let i = Math.max(0, from); i < Math.min(to, messages.length); i++) {
    const m = messages[i]
    if (typeof m.content === 'string') continue
    for (const b of m.content)
      if (b.type === 'tool_result' && clearable(b, actions?.[b.tool_use_id]))
        chars += resultChars(b)
  }
  return tokens(chars)
}

// Where the mark moves this turn, or null to leave it.
export function nextMark(o: {
  messages: Message[]
  actions: Conversation['actions']
  // The current mark (0 for none).
  cleared: number
  // Where what is sent starts (the newest compaction, or 0).
  sentFrom: number
  // The next request misses the provider's cache anyway.
  cacheMiss: boolean
  // Estimated tokens of the history as sent now.
  history: number
  // The model's compaction trigger (context.compactTrigger).
  trigger: number
}): number | null {
  const to = keepFrom(o.messages)
  if (to <= o.cleared) return null
  const gain = clearableTokens(o.messages, o.actions, Math.max(o.cleared, o.sentFrom), to)
  if (o.cacheMiss && gain >= CLEAR_LIMITS.minWhenFree) return to
  if (o.history >= o.trigger * CLEAR_LIMITS.near && gain >= CLEAR_LIMITS.minWhenNear) return to
  return null
}

const OUTCOME: Record<ActionRecord['status'], string> = {
  completed: 'it ran',
  failed: 'it failed',
  'not-run': 'it did not run',
  unknown: 'outcome unknown',
  pending: 'pending',
  running: 'running'
}

// The history as sent: big results before the mark become stubs. The saved
// messages are not changed. The stub depends only on what is saved, so it is
// the same in every request.
export function withClearedResults(
  messages: Message[],
  actions: Conversation['actions'],
  before: number | undefined
): Message[] {
  if (!before) return messages
  let changed = false
  const out = messages.map((m, i) => {
    if (i >= before || typeof m.content === 'string' || !isToolResults(m)) return m
    let touched = false
    const content = m.content.map((b): BetaContentBlockParam => {
      if (b.type !== 'tool_result') return b
      const a = actions?.[b.tool_use_id]
      if (!a || !clearable(b, a)) return b
      touched = true
      return {
        type: 'tool_result',
        tool_use_id: b.tool_use_id,
        content: `[Custard cleared this result to save room: ${a.label} (${a.name}), ${resultChars(b).toLocaleString('en-US')} characters, ${OUTCOME[a.status]}. The chat's record keeps its outcome. Call the tool again if you need what it returned.]`
      }
    })
    if (!touched) return m
    changed = true
    return { ...m, content }
  })
  return changed ? out : messages
}
