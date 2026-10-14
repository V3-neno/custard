import type { BetaContentBlockParam } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import type {
  ResponseInputContent,
  ResponseInputItem,
  ResponseOutputItem
} from 'openai/resources/responses/responses'
import type { AssistantMessage, AssistantPart, Message } from '../../shared/neutralChat'
import type { Provider } from '../../shared/providers'
import { filePart, toBlocks } from '../openai'

// Custard's neutral chat format (shared/neutralChat.ts) to and from the
// OpenAI Responses API (OpenAI and DeepSeek). Pure functions; nothing in the
// app calls them until B3. Only `parts` are ever sent: `raw` belongs to the
// provider that wrote it, and Responses replies have none.

// The same words history.ts uses for a call to a tool that isn't offered now.
const MAX_CHARS = 2000
const clip = (s: string): string => (s.length > MAX_CHARS ? `${s.slice(0, MAX_CHARS)}…` : s)
const staleCall = (name: string, input: unknown): string =>
  `[Earlier call to ${name}, which is not available now: ${clip(JSON.stringify(input))}]`
const staleResult = (text: string, isError: boolean): string =>
  `[Result of that earlier call${isError ? ' (error)' : ''}: ${clip(text)}]`

// One piece of a user message on its way out.
type Piece =
  | { kind: 'text'; text: string }
  | { kind: 'file'; block: BetaContentBlockParam }
  | { kind: 'result'; callId: string; text: string; isError: boolean }

const isFile = (b: BetaContentBlockParam): boolean => b.type === 'image' || b.type === 'document'

// The Responses input for one request: the history from `from` on (where the
// model's own compaction item takes over; the caller puts the item first),
// with this request's files in front of their messages and calls to tools
// not offered now as text, as today.
export function toResponsesInput(
  messages: Message[],
  opts: {
    files?: Map<number, BetaContentBlockParam[]>
    available: Set<string>
    from?: number
  }
): ResponseInputItem[] {
  const stale = new Set<string>()
  for (const m of messages)
    if (m.role === 'assistant')
      for (const p of m.parts)
        if (p.type === 'tool_call' && !opts.available.has(p.name)) stale.add(p.id)

  const items: ResponseInputItem[] = []
  for (const [i, m] of messages.entries()) {
    if (i < (opts.from ?? 0)) continue
    if (m.role === 'assistant') {
      if (m.partial) {
        items.push({ role: 'assistant', content: textOf(m.parts) })
        continue
      }
      for (const p of m.parts) {
        if (p.type === 'text') items.push({ role: 'assistant', content: p.text })
        else if (p.type === 'tool_call')
          items.push(
            stale.has(p.id)
              ? { role: 'assistant', content: staleCall(p.name, p.input) }
              : {
                  type: 'function_call',
                  call_id: p.id,
                  name: p.name,
                  arguments: JSON.stringify(p.input)
                }
          )
      }
      continue
    }

    const own: Piece[] = m.parts.map((p) =>
      p.type === 'tool_result'
        ? { kind: 'result', callId: p.callId, text: p.text, isError: p.isError }
        : { kind: 'text', text: p.text }
    )
    const files = opts.files?.get(i)
    // A message with files: the files, then its text if it has any.
    const pieces: Piece[] = files
      ? [
          ...files.map((b): Piece =>
            b.type === 'text' ? { kind: 'text', text: b.text } : { kind: 'file', block: b }
          ),
          ...(m.parts.length === 1 && m.parts[0].type === 'text'
            ? m.parts[0].text.trim()
              ? own
              : []
            : own)
        ]
      : own
    const sent = pieces.map((x): Piece =>
      x.kind === 'result' && stale.has(x.callId)
        ? { kind: 'text', text: staleResult(x.text, x.isError) }
        : x
    )
    // With files: one message holding the files and the text.
    if (sent.some((x) => x.kind === 'file' && isFile(x.block))) {
      const content: ResponseInputContent[] = []
      for (const x of sent) {
        const part =
          x.kind === 'text'
            ? { type: 'input_text' as const, text: x.text }
            : x.kind === 'file'
              ? filePart(x.block)
              : null
        if (part) content.push(part)
      }
      items.push({ role: 'user', content })
      continue
    }
    for (const x of sent)
      if (x.kind === 'text') items.push({ role: 'user', content: x.text })
      else if (x.kind === 'result')
        items.push({ type: 'function_call_output', call_id: x.callId, output: x.text })
  }
  return items
}

const textOf = (parts: AssistantPart[]): string =>
  parts.map((p) => (p.type === 'text' ? p.text : '')).join('')

// A Responses reply as a neutral assistant message: its text (a refusal is
// kept as text) and its tool calls. Arguments that aren't valid JSON are kept
// as given (see MALFORMED_ARGUMENTS). Reasoning and compaction items are not
// part of the message, as today.
export function fromResponsesReply(
  output: ResponseOutputItem[],
  provider: Provider,
  model: string
): AssistantMessage {
  const parts = toBlocks(output).flatMap((b): AssistantPart[] =>
    b.type === 'text'
      ? [{ type: 'text', text: b.text }]
      : b.type === 'tool_use'
        ? [{ type: 'tool_call', id: b.id, name: b.name, input: b.input }]
        : []
  )
  return { role: 'assistant', parts, by: { provider, model } }
}
