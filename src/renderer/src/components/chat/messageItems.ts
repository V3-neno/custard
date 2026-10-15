import { isToolResults, textOf, type Message } from '../../../../shared/neutralChat'

// What MessageView shows for one stored message, in order. Kept apart from
// the component so every part type is tested (messageItems.test.ts).
export type MessageItem =
  | { kind: 'user'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'fallback'; to: string }
  | { kind: 'tool'; id: string; name: string; input: unknown }
  | { kind: 'text'; text: string }

export function messageItems(m: Message): MessageItem[] {
  if (m.role === 'user')
    // Tool results are sent as user messages but aren't something the user
    // wrote.
    return isToolResults(m) ? [] : [{ kind: 'user', text: textOf(m) }]
  return m.parts.flatMap((p): MessageItem[] => {
    switch (p.type) {
      // Redacted thinking has nothing to read.
      case 'thinking':
        return p.redacted ? [] : [{ kind: 'thinking', text: p.text }]
      case 'fallback':
        return [{ kind: 'fallback', to: p.to }]
      case 'tool_call':
        return [{ kind: 'tool', id: p.id, name: p.name, input: p.input }]
      case 'text':
        return [{ kind: 'text', text: p.text }]
      // Shown from the chat's compaction record (CompactionLine), not here.
      case 'compaction':
        return []
    }
  })
}
