import type { Conversation } from '../../src/shared/chat'
import {
  CHAT_FORMAT,
  CHAT_VERSION,
  toolResults,
  type AssistantMessage,
  type AssistantPart,
  type UserMessage,
  type Writer
} from '../../src/shared/neutralChat'

// Test-only shorthands for stored chats in Custard's format (B3). The app's
// own builders (userMessage, toolResults, partialReply) are in
// shared/neutralChat.ts; replies come from the adapters' converters.

export { userMessage as user, partialReply as partial } from '../../src/shared/neutralChat'

// A chat with the fields every stored chat has, and these.
export const chat = (fields: Partial<Conversation> = {}): Conversation => ({
  format: CHAT_FORMAT,
  version: CHAT_VERSION,
  id: 'c1',
  mode: 'chat',
  title: 't',
  createdAt: 0,
  updatedAt: 0,
  messages: [],
  ...fields
})

export const assistant = (parts: AssistantPart[], by?: Writer): AssistantMessage => ({
  role: 'assistant',
  parts,
  ...(by ? { by } : {})
})

// An assistant message of text only.
export const said = (text: string, by?: Writer): AssistantMessage =>
  assistant([{ type: 'text', text }], by)

// An assistant message of tool calls only.
export const calls = (...list: { id: string; name: string; input?: unknown }[]): AssistantMessage =>
  assistant(list.map((c) => ({ type: 'tool_call', id: c.id, name: c.name, input: c.input ?? {} })))

// One tool result as its own message.
export const result = (callId: string, text: string, isError = false): UserMessage =>
  toolResults([{ callId, text, isError }])
