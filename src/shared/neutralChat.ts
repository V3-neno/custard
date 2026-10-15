import type { Conversation, Mode } from './chat'
import { isMode } from './chat'
import type { Provider } from './providers'

// A stored chat in Custard's own format, the same whichever provider wrote
// each message (Workstream B; see docs/proposals/neutral-chat-format-b1.md).
// Every chat file carries `format` and `version`; a file without them (or
// with a version this build doesn't know, or that can't be read) is an old
// chat: listed in History, never opened or read as a chat (see store.ts).
//
// Each message keeps one index, so the fields beside `messages` that point
// into it by index (notices, compactions, attachments, ...) keep their
// meaning.

export const CHAT_FORMAT = 'custard-chat'
export const CHAT_VERSION = 1

export type StoredChat = Conversation

// Which provider and model wrote an assistant message.
export type Writer = { provider: Provider; model: string }

export type UserMessage = { role: 'user'; parts: UserPart[] }

export type AssistantMessage = {
  role: 'assistant'
  parts: AssistantPart[]
  // Missing only where it isn't known.
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

// The messages Custard writes itself (the provider's replies come from the
// adapters: fromClaudeReply, fromResponsesReply).

// What the user typed. Sent as a plain string.
export const userMessage = (text: string): UserMessage => ({
  role: 'user',
  parts: [{ type: 'text', text }]
})

// A round's tool results, one per call in order, and Custard's note after a
// stopped round.
export const toolResults = (
  results: { callId: string; text: string; isError: boolean }[],
  note?: string
): UserMessage => ({
  role: 'user',
  parts: [
    ...results.map((r): UserPart => ({ type: 'tool_result', ...r })),
    ...(note ? [{ type: 'note' as const, text: note }] : [])
  ]
})

// The text that had streamed when a reply was cut off.
export const partialReply = (text: string, by?: Writer): AssistantMessage => ({
  role: 'assistant',
  parts: [{ type: 'text', text }],
  ...(by ? { by } : {}),
  partial: true
})

// Reading messages.

export const isToolResults = (m: Message | undefined): boolean =>
  !!m && m.role === 'user' && m.parts.some((p) => p.type === 'tool_result')

// The tool calls in a message, in order.
export const toolCalls = (m: Message): { id: string; name: string; input: unknown }[] =>
  m.role === 'assistant'
    ? m.parts.flatMap((p) =>
        p.type === 'tool_call' ? [{ id: p.id, name: p.name, input: p.input }] : []
      )
    : []

// A message's readable text: its text parts (and Custard's note), joined
// with `sep`. Every other part counts as an empty string, so the result is
// what joining the stored blocks' text gave before B3.
export const textOf = (m: Message, sep = '\n'): string =>
  (m.parts as (UserPart | AssistantPart)[])
    .map((p) => (p.type === 'text' || p.type === 'note' ? p.text : ''))
    .join(sep)

// Checking a chat file.

// Why a file in the chats folder isn't a chat this build opens:
// - old: saved by an earlier Custard (no `format`);
// - newer: this format at a version this build doesn't know;
// - unreadable: not JSON, or not a chat at all.
export type OldReason = 'old' | 'newer' | 'unreadable'

// An old chat as History and the window see it: only its title, mode and
// date are read from the file.
export type OldChat = { id: string; mode: Mode; title: string; updatedAt: number; old: OldReason }

// What conversations:get returned: an old chat rather than a chat.
export const isOldChat = (x: Conversation | OldChat | null): x is OldChat =>
  !!x && !!x.old && !('messages' in x)

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null
const isString = (x: unknown): x is string => typeof x === 'string'

const USER_PARTS = new Set(['text', 'tool_result', 'note'])
const ASSISTANT_PARTS = new Set(['text', 'tool_call', 'thinking', 'fallback', 'compaction'])

function isPart(p: unknown, role: 'user' | 'assistant'): boolean {
  if (!isObject(p) || !isString(p.type)) return false
  if (!(role === 'user' ? USER_PARTS : ASSISTANT_PARTS).has(p.type)) return false
  switch (p.type) {
    case 'text':
    case 'note':
    case 'thinking':
      return isString(p.text)
    case 'tool_result':
      return isString(p.callId) && isString(p.text) && typeof p.isError === 'boolean'
    case 'tool_call':
      return isString(p.id) && isString(p.name)
    case 'fallback':
      return isString(p.from) && isString(p.to)
    default:
      return true
  }
}

function isMessage(m: unknown): boolean {
  if (!isObject(m) || (m.role !== 'user' && m.role !== 'assistant')) return false
  const role = m.role
  if (!Array.isArray(m.parts) || !m.parts.every((p) => isPart(p, role))) return false
  if (role === 'assistant' && m.raw !== undefined)
    return isObject(m.raw) && isString(m.raw.provider) && Array.isArray(m.raw.blocks)
  return true
}

// Whether a parsed chat file is a chat in this format, at a version this
// build reads, with every message in a shape the app can show and send.
export function isStoredChat(x: unknown): x is StoredChat {
  return (
    isObject(x) &&
    x.format === CHAT_FORMAT &&
    x.version === CHAT_VERSION &&
    isString(x.id) &&
    isString(x.title) &&
    (x.mode === undefined || isMode(x.mode)) &&
    typeof x.createdAt === 'number' &&
    typeof x.updatedAt === 'number' &&
    Array.isArray(x.messages) &&
    x.messages.every(isMessage)
  )
}

// Why a parsed file isn't a chat this build opens (null: it is one).
export function oldReason(x: unknown): OldReason | null {
  if (isStoredChat(x)) return null
  if (isObject(x) && x.format === CHAT_FORMAT)
    return x.version === CHAT_VERSION ? 'unreadable' : 'newer'
  return isObject(x) && Array.isArray(x.messages) ? 'old' : 'unreadable'
}

// What the old-chat view says, by reason.
export const OLD_CHAT_TEXT: Record<OldReason, string> = {
  old: "This chat was saved by an earlier Custard and can't be opened. Delete it to remove it.",
  newer:
    "This chat was saved by a newer Custard than this one and can't be opened here. Delete it to remove it.",
  unreadable: "This chat's file can't be read, so it can't be opened. Delete it to remove it."
}

// Why anything that would read an old chat as a chat (send, Continue, a
// reference, the model picker) refuses.
export const OLD_CHAT_REFUSAL =
  "That chat was saved in a format this Custard can't open, so nothing was done with it."
