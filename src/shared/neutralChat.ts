import type { Conversation } from './chat'
import type { Provider } from './providers'

// A stored chat in Custard's own format, the same whichever provider wrote
// each message (Workstream B; see docs/proposals/neutral-chat-format-b1.md).
// Nothing in the app reads or writes this yet: chats are still stored in
// Anthropic's message format (Conversation.messages) until B3 switches over.
//
// Each message keeps one index, as today, so the fields beside `messages`
// that point into it by index (notices, compactions, attachments, ...) mean
// the same thing in both formats.

export const CHAT_FORMAT = 'custard-chat'
export const CHAT_VERSION = 1

export type StoredChat = Omit<Conversation, 'messages'> & {
  format: typeof CHAT_FORMAT
  version: typeof CHAT_VERSION
  messages: Message[]
}

// Which provider and model wrote an assistant message.
export type Writer = { provider: Provider; model: string }

export type UserMessage = { role: 'user'; parts: UserPart[] }

export type AssistantMessage = {
  role: 'assistant'
  parts: AssistantPart[]
  // Missing only where it isn't known: a message Custard wrote itself.
  by?: Writer
  // Cut off by Stop or a crash: the text that had streamed, sent as a plain
  // string.
  partial?: true
  // The provider's own blocks, exactly as returned, kept only when they
  // differ from what `parts` would rebuild (thinking, compaction, fallback,
  // fields only the writer reads). Sent back only to `raw.provider`; every
  // other provider is sent `parts`.
  raw?: Writer & { blocks: unknown[] }
}

export type Message = UserMessage | AssistantMessage

export type UserPart =
  | { type: 'text'; text: string }
  | { type: 'tool_result'; callId: string; text: string; isError: boolean }
  // Custard's own note after a stopped round ("[Custard: ...]").
  | { type: 'note'; text: string }

export type AssistantPart =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  // Display copies of blocks only the writer can read: never sent as parts.
  // A redacted block has no readable text.
  | { type: 'thinking'; text: string; redacted?: true }
  | { type: 'fallback'; from: string; to: string }
  | { type: 'compaction' }

// Whether a parsed chat file is in this format, at a version this build
// reads. Written for B4; nothing calls it yet.
export function isStoredChat(x: unknown): x is StoredChat {
  if (typeof x !== 'object' || x === null) return false
  const c = x as { format?: unknown; version?: unknown; id?: unknown; messages?: unknown }
  return (
    c.format === CHAT_FORMAT &&
    c.version === CHAT_VERSION &&
    typeof c.id === 'string' &&
    Array.isArray(c.messages)
  )
}
