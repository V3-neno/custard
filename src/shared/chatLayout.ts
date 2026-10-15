import type { Attachment } from './attachments'
import type {
  ActionRecord,
  ChatReference,
  Compaction,
  Conversation,
  Notice,
  WebSource,
  WorkspaceProposal
} from './chat'
import { isToolResults, textOf, type Message } from './neutralChat'

// What MessageView shows for one stored message, in order. Kept apart from
// the component so every part type is tested (chatLayout.test.ts). Shared
// only so the main-process index tests can read records as the window does.
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

// Where the chat's records keyed by message index show in the window. Each
// stored message keeps its index (one message per index, as before B3), so
// these are read exactly as before; they are kept here to be tested.
type Placed = Pick<
  Conversation,
  | 'messages'
  | 'actions'
  | 'sources'
  | 'proposals'
  | 'notices'
  | 'compactions'
  | 'attachments'
  | 'references'
>

// Each tool call's outcome. Chats saved before outcomes were recorded only
// know which calls failed.
export function callOutcomes(c: Placed | null): Record<string, ActionRecord> {
  const all: Record<string, ActionRecord> = { ...(c?.actions ?? {}) }
  for (const m of c?.messages ?? [])
    if (m.role === 'user')
      for (const b of m.parts)
        if (b.type === 'tool_result' && b.isError && !all[b.callId])
          all[b.callId] = { name: '', label: '', write: false, status: 'failed', key: '' }
  return all
}

// Each turn's last message (the one before the next thing the user wrote),
// mapped to the index of the turn's first message.
export function turnEnds(messages: Message[]): Map<number, number> {
  const out = new Map<number, number>()
  let start = -1
  messages.forEach((m, i) => {
    if (m.role === 'user' && !isToolResults(m)) start = i
    const next = messages[i + 1]
    const ends = !next || (next.role === 'user' && !isToolResults(next))
    if (ends && start >= 0) out.set(i, start)
  })
  return out
}

// Where each turn ends, mapped to its sources and its answer text.
export function turnSources(
  c: Placed | null
): Map<number, { sources: WebSource[]; answer: string }> {
  const out = new Map<number, { sources: WebSource[]; answer: string }>()
  const msgs = c?.messages ?? []
  const all = c?.sources ?? []
  if (!all.length) return out
  for (const [end, start] of turnEnds(msgs)) {
    const sources = all.filter((s) => s.turn === start)
    if (!sources.length) continue
    const answer = msgs
      .slice(start, end + 1)
      .filter((x) => x.role === 'assistant')
      .flatMap((x) => x.parts.flatMap((b) => (b.type === 'text' ? [b.text] : [])))
      .join('\n')
    out.set(end, { sources, answer })
  }
  return out
}

// Hub chat offers to enter a workspace, shown where their turn ends.
export function turnProposals(c: Placed | null): Map<number, WorkspaceProposal[]> {
  const out = new Map<number, WorkspaceProposal[]>()
  const all = c?.proposals ?? []
  if (!all.length) return out
  for (const [end, start] of turnEnds(c?.messages ?? [])) {
    const here = all.filter((p) => p.turn === start)
    if (here.length) out.set(end, here)
  }
  return out
}

// What shows with message i: the compaction line before it, the files and
// references sent with it, and the notices after it.
export function atMessage(
  c: Placed,
  i: number
): {
  compaction: Compaction | undefined
  files: Attachment[]
  references: ChatReference[]
  notices: Notice[]
} {
  return {
    compaction: (c.compactions ?? []).filter((k) => k.after === i).slice(-1)[0],
    files: (c.attachments ?? []).filter((a) => a.message === i),
    references: (c.references ?? []).filter((r) => r.message === i),
    notices: (c.notices ?? []).filter((n) => n.after === i + 1)
  }
}
