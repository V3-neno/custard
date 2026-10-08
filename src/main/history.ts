import type {
  BetaContentBlockParam,
  BetaMessageParam
} from '@anthropic-ai/sdk/resources/beta/messages/messages'

// Earlier calls to tools that aren't offered now (a disabled or removed
// plugin, a workspace tool from another mode) are sent as plain text. The
// APIs require a definition for every tool named in the history, and keeping
// a disabled plugin's definition would invite the model to call it again.
// The stored conversation is not changed.

const MAX_CHARS = 2000

const clip = (s: string): string => (s.length > MAX_CHARS ? `${s.slice(0, MAX_CHARS)}…` : s)

export function withoutUnavailableTools(
  messages: BetaMessageParam[],
  available: Set<string>
): BetaMessageParam[] {
  const stale = new Set<string>()
  for (const m of messages)
    if (typeof m.content !== 'string')
      for (const b of m.content)
        if (b.type === 'tool_use' && !available.has(b.name)) stale.add(b.id)
  if (!stale.size) return messages
  return messages.map((m) => {
    if (typeof m.content === 'string') return m
    const content = m.content.map((b): BetaContentBlockParam => {
      if (b.type === 'tool_use' && stale.has(b.id))
        return {
          type: 'text',
          text: `[Earlier call to ${b.name}, which is not available now: ${clip(JSON.stringify(b.input))}]`
        }
      if (b.type === 'tool_result' && stale.has(b.tool_use_id)) {
        const text =
          typeof b.content === 'string'
            ? b.content
            : (b.content ?? []).map((c) => (c.type === 'text' ? c.text : '')).join('')
        return {
          type: 'text',
          text: `[Result of that earlier call${b.is_error ? ' (error)' : ''}: ${clip(text)}]`
        }
      }
      return b
    })
    return { ...m, content }
  })
}
