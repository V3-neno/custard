import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { fromClaudeReply } from '../../src/main/adapters/anthropicNeutral'
import type { Message, UserPart, Writer } from '../../src/shared/neutralChat'

// TEST ONLY. Turns a history in today's stored format (Anthropic messages)
// into the neutral format, so tests can check that the neutral converters
// send exactly what today's code sends. It is not migration code: the app
// never imports it (it lives outside src/), and old chats are never converted
// (B1 decision: they get a notice). It accepts only the shapes Custard
// actually stores and throws on anything else, so a test can't pass on a
// shape it silently reshaped.

export class NotStoredShape extends Error {}

type Block = { type: string; [k: string]: unknown }

// `by`: who wrote each assistant message, where the test knows. The stored
// format doesn't say, so without it a Claude reply is attributed to
// 'unknown'; only its `raw.provider` (Claude) matters for what is sent.
export function legacyToNeutral(
  messages: BetaMessageParam[],
  by?: (index: number) => Writer | undefined
): Message[] {
  return messages.map((m, i): Message => {
    if (m.role === 'user') {
      // A message the user typed.
      if (typeof m.content === 'string')
        return { role: 'user', parts: [{ type: 'text', text: m.content }] }
      // A round's tool results, then possibly Custard's note.
      const blocks = m.content as unknown as Block[]
      const parts = blocks.map((b, j): UserPart => {
        if (b.type === 'tool_result') {
          if (typeof b.content !== 'string' || typeof b.is_error !== 'boolean')
            throw new NotStoredShape(`message ${i}: tool_result not as TurnLog writes it`)
          const keys = Object.keys(b).join(',')
          if (keys !== 'type,tool_use_id,content,is_error')
            throw new NotStoredShape(`message ${i}: tool_result keys ${keys}`)
          return {
            type: 'tool_result',
            callId: b.tool_use_id as string,
            text: b.content,
            isError: b.is_error
          }
        }
        if (b.type === 'text' && j === blocks.length - 1 && Object.keys(b).length === 2)
          return { type: 'note', text: b.text as string }
        throw new NotStoredShape(`message ${i}: user block ${b.type} at ${j}`)
      })
      return { role: 'user', parts }
    }
    // A reply cut off by Stop or a crash.
    if (typeof m.content === 'string')
      return {
        role: 'assistant',
        partial: true,
        parts: [{ type: 'text', text: m.content }],
        ...(by?.(i) ? { by: by(i) } : {})
      }
    const reply = fromClaudeReply(m.content, by?.(i)?.model ?? 'unknown')
    const writer = by?.(i)
    // A reply from a Responses provider is only text and tool calls, so it
    // has no `raw`; one that has raw blocks can only be Claude's.
    if (writer && writer.provider !== 'claude' && reply.raw)
      throw new NotStoredShape(`message ${i}: ${writer.provider} reply with Claude-only blocks`)
    if (writer)
      return {
        ...reply,
        by: writer,
        ...(reply.raw ? { raw: { ...writer, blocks: reply.raw.blocks } } : {})
      }
    delete reply.by
    return reply
  })
}
