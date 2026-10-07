import type {
  BetaContentBlock,
  BetaMessageParam
} from '@anthropic-ai/sdk/resources/beta/messages/messages'
import type {
  ResponseCompactionItem,
  ResponseInputItem
} from 'openai/resources/responses/responses'
import type { Conversation } from '../shared/chat'
import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { isContextError, limitsFor } from './context'

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

// Only a definite "this model doesn't take compaction": a 400 (rejected
// before anything ran) naming the compaction setting and saying it is
// unsupported. Timeouts, 5xx, rate limits, context-length errors and any
// error once a reply has started are not this, and are never retried here.
const NAMES_COMPACTION = /context_management|context-management|compact/i
const UNSUPPORTED =
  /not supported|unsupported|does not support|unknown parameter|unrecognized|extra inputs are not permitted|not permitted|not available|invalid beta/i
export function isCompactionRejected(err: unknown): boolean {
  if (isContextError(err)) return false
  if (err instanceof Anthropic.APIError)
    return err.status === 400 && NAMES_COMPACTION.test(err.message) && UNSUPPORTED.test(err.message)
  if (err instanceof OpenAI.APIError)
    return (
      err.status === 400 &&
      (err.param === 'context_management' || NAMES_COMPACTION.test(err.message)) &&
      (err.code === 'unsupported_parameter' || UNSUPPORTED.test(err.message))
    )
  return false
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
// `after`, which the API drops everything before. A block with no content is
// a compaction that failed (the API treats it as a no-op), so it isn't shown
// as one.
export function recordClaudeCompaction(
  c: Conversation,
  content: BetaContentBlock[],
  model: string,
  now = Date.now()
): boolean {
  if (!content.some((b) => b.type === 'compaction' && typeof b.content === 'string' && b.content))
    return false
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
