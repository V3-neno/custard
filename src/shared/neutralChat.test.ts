import { describe, expect, it } from 'vitest'
import {
  CHAT_FORMAT,
  CHAT_VERSION,
  isOldChat,
  isStoredChat,
  isToolResults,
  oldReason,
  OLD_CHAT_TEXT,
  partialReply,
  textOf,
  toolCalls,
  toolResults,
  userMessage
} from './neutralChat'

// B3: which files in the chats folder are chats this build opens. Anything
// else is an old chat: listed by title, never read as a chat.

const chat = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  format: CHAT_FORMAT,
  version: CHAT_VERSION,
  id: 'c1',
  mode: 'chat',
  title: 'A chat',
  createdAt: 1,
  updatedAt: 2,
  messages: [
    userMessage('Hi'),
    {
      role: 'assistant',
      by: { provider: 'claude', model: 'claude-opus-5-5' },
      parts: [
        { type: 'thinking', text: 'Hm.' },
        { type: 'thinking', text: '', redacted: true },
        { type: 'fallback', from: 'claude-opus-5-5', to: 'claude-sonnet-5-5' },
        { type: 'compaction' },
        { type: 'text', text: 'Hello.' },
        { type: 'tool_call', id: 't1', name: 'vault_list', input: {} }
      ],
      raw: { provider: 'claude', model: 'claude-opus-5-5', blocks: [] }
    },
    toolResults([{ callId: 't1', text: 'a.md', isError: false }], '[Custard: Stopped.]'),
    partialReply('I was', { provider: 'openai', model: 'gpt-6-astra' })
  ],
  ...extra
})

describe('isStoredChat and oldReason', () => {
  it('a chat in this format and version, with every part type, is a chat', () => {
    expect(isStoredChat(chat())).toBe(true)
    expect(oldReason(chat())).toBeNull()
    // Mode is optional (chats from before modes are Chat).
    expect(isStoredChat(chat({ mode: undefined }))).toBe(true)
  })

  it('a file with no format is old: an earlier Custard saved it', () => {
    const old = {
      id: 'c1',
      title: 'Before',
      createdAt: 1,
      updatedAt: 2,
      messages: [{ role: 'user', content: 'Hi' }]
    }
    expect(isStoredChat(old)).toBe(false)
    expect(oldReason(old)).toBe('old')
  })

  it('an unknown version is from a newer Custard', () => {
    expect(isStoredChat(chat({ version: 2 }))).toBe(false)
    expect(oldReason(chat({ version: 2 }))).toBe('newer')
    expect(oldReason(chat({ version: '1' }))).toBe('newer')
  })

  it('not JSON (the store passes undefined), or valid JSON that is not a chat, is unreadable', () => {
    for (const x of [undefined, null, 3, 'text', [], {}, { title: 'x' }, { messages: 'no' }])
      expect(oldReason(x)).toBe('unreadable')
  })

  it('this format with fields missing or wrong is unreadable, never half loaded', () => {
    const broken: Record<string, unknown>[] = [
      chat({ id: undefined }),
      chat({ title: 3 }),
      chat({ mode: 'video' }),
      chat({ createdAt: undefined }),
      chat({ updatedAt: '2' }),
      chat({ messages: undefined }),
      chat({ messages: [{ role: 'system', parts: [] }] }),
      chat({ messages: [{ role: 'user', content: 'Hi' }] }),
      chat({ messages: [{ role: 'user', parts: [{ type: 'tool_call', id: 'x', name: 'y' }] }] }),
      chat({ messages: [{ role: 'user', parts: [{ type: 'text' }] }] }),
      chat({
        messages: [{ role: 'user', parts: [{ type: 'tool_result', callId: 'x', text: '' }] }]
      }),
      chat({ messages: [{ role: 'assistant', parts: [{ type: 'tool_result' }] }] }),
      chat({ messages: [{ role: 'assistant', parts: [{ type: 'tool_call', id: 'x' }] }] }),
      chat({ messages: [{ role: 'assistant', parts: [{ type: 'fallback', to: 'x' }] }] }),
      chat({ messages: [{ role: 'assistant', parts: [{ type: 'image' }] }] }),
      chat({ messages: [{ role: 'assistant', parts: [], raw: { blocks: [] } }] }),
      chat({ messages: [{ role: 'assistant', parts: [], raw: { provider: 'claude' } }] })
    ]
    for (const [i, x] of broken.entries()) {
      expect(isStoredChat(x), `case ${i}`).toBe(false)
      expect(oldReason(x), `case ${i}`).toBe('unreadable')
    }
  })

  it('a directory of many old chats and one new one: only the new one is a chat', () => {
    const files = [
      ...Array.from({ length: 40 }, (_, i) => ({
        id: `old-${i}`,
        title: `Old ${i}`,
        messages: [{ role: 'user', content: `m${i}` }]
      })),
      chat({ id: 'new-one' }),
      chat({ id: 'later', version: 7 }),
      'not json'
    ]
    const chats = files.filter(isStoredChat)
    expect(chats.map((c) => c.id)).toEqual(['new-one'])
    expect(files.map(oldReason).filter((r) => r === 'old')).toHaveLength(40)
  })

  it('an old chat as the window gets it is told apart from a chat', () => {
    expect(isOldChat({ id: 'x', mode: 'chat', title: 't', updatedAt: 0, old: 'old' })).toBe(true)
    expect(isOldChat(chat() as never)).toBe(false)
    expect(isOldChat(null)).toBe(false)
    expect(Object.keys(OLD_CHAT_TEXT).sort()).toEqual(['newer', 'old', 'unreadable'])
  })
})

describe('reading neutral messages', () => {
  it('text, tool calls and tool results', () => {
    const [u, a, r, p] = chat().messages as never[]
    expect(textOf(u)).toBe('Hi')
    // Only text parts count; the rest are empty strings, as before B3.
    expect(textOf(a)).toBe('\n\n\n\nHello.\n')
    expect(textOf(r)).toBe('\n[Custard: Stopped.]')
    expect(textOf(p)).toBe('I was')
    expect(toolCalls(a)).toEqual([{ id: 't1', name: 'vault_list', input: {} }])
    expect(toolCalls(u)).toEqual([])
    expect(isToolResults(r)).toBe(true)
    expect(isToolResults(u)).toBe(false)
    expect(isToolResults(a)).toBe(false)
    expect(isToolResults(undefined)).toBe(false)
  })
})
