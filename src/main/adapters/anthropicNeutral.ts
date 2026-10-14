import type {
  BetaContentBlockParam,
  BetaMessageParam
} from '@anthropic-ai/sdk/resources/beta/messages/messages'
import type { AssistantMessage, AssistantPart, Message } from '../../shared/neutralChat'
import { withFiles } from '../attachments/request'
import { claudeHistory } from '../compaction'
import { withoutUnavailableTools } from '../history'

// Custard's neutral chat format (shared/neutralChat.ts) to and from Claude's
// Messages API. Pure functions; nothing in the app calls them until B3.

// The text and tool calls of an assistant message as Claude blocks: what
// `parts` rebuild when there is no `raw` (or it is another provider's).
function partBlocks(parts: AssistantPart[]): BetaContentBlockParam[] {
  return parts.flatMap((p): BetaContentBlockParam[] =>
    p.type === 'text'
      ? [{ type: 'text', text: p.text }]
      : p.type === 'tool_call'
        ? [{ type: 'tool_use', id: p.id, name: p.name, input: p.input }]
        : []
  )
}

// One message as Claude's API takes it, before the per-request changes. A
// user message that is only text, and a cut-off reply, go as plain strings,
// exactly as they are stored today. Claude's own replies go back as the
// blocks it returned.
export function toClaudeMessage(m: Message): BetaMessageParam {
  if (m.role === 'user') {
    const [only] = m.parts
    if (m.parts.length === 1 && only.type === 'text') return { role: 'user', content: only.text }
    return {
      role: 'user',
      content: m.parts.map((p): BetaContentBlockParam =>
        p.type === 'tool_result'
          ? { type: 'tool_result', tool_use_id: p.callId, content: p.text, is_error: p.isError }
          : { type: 'text', text: p.text }
      )
    }
  }
  if (m.partial)
    return {
      role: 'assistant',
      content: m.parts.map((p) => (p.type === 'text' ? p.text : '')).join('')
    }
  if (m.raw?.provider === 'claude')
    return { role: 'assistant', content: m.raw.blocks as BetaContentBlockParam[] }
  return { role: 'assistant', content: partBlocks(m.parts) }
}

// The history for one Claude request: each message converted, then the
// changes made for this request only, as today (files in front of their
// message, calls to tools not offered now as text, compaction blocks only
// for a model that compacts). The stored chat is never changed.
export function toClaudeHistory(
  messages: Message[],
  opts: {
    model: string
    files?: Map<number, BetaContentBlockParam[]>
    available: Set<string>
  }
): BetaMessageParam[] {
  return claudeHistory(
    withoutUnavailableTools(
      withFiles(messages.map(toClaudeMessage), opts.files ?? new Map()),
      opts.available
    ),
    opts.model
  )
}

type ReplyBlock = { type: string; [k: string]: unknown }

// A Claude reply (the blocks Custard keeps, see echoableContent) as a neutral
// assistant message. `raw` is kept only when the blocks differ from what the
// parts rebuild: thinking, compaction and fallback blocks, or any field the
// API added (such as `citations`).
export function fromClaudeReply(blocks: BetaContentBlockParam[], model: string): AssistantMessage {
  const parts = (blocks as unknown as ReplyBlock[]).flatMap((b): AssistantPart[] => {
    switch (b.type) {
      case 'text':
        return [{ type: 'text', text: b.text as string }]
      case 'tool_use':
        return [{ type: 'tool_call', id: b.id as string, name: b.name as string, input: b.input }]
      case 'thinking':
        return [{ type: 'thinking', text: b.thinking as string }]
      case 'redacted_thinking':
        return [{ type: 'thinking', text: '', redacted: true }]
      case 'compaction':
        return [{ type: 'compaction' }]
      case 'fallback': {
        const end = (x: unknown): string => (x as { model?: string } | undefined)?.model ?? ''
        return [{ type: 'fallback', from: end(b.from), to: end(b.to) }]
      }
      default:
        // Kept in `raw` only.
        return []
    }
  })
  const by = { provider: 'claude' as const, model }
  const same = JSON.stringify(partBlocks(parts)) === JSON.stringify(blocks)
  return { role: 'assistant', parts, by, ...(same ? {} : { raw: { ...by, blocks } }) }
}
