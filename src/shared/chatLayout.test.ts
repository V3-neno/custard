import { describe, expect, it } from 'vitest'
import { messageItems, turnEnds } from './chatLayout'
import { partialReply, toolResults, userMessage, type Message } from './neutralChat'

// B3: what the window shows for each part type. The records keyed by message
// index are tested in main/indexFields.test.ts.

describe('messageItems', () => {
  it('a user message shows its text; tool results show nothing', () => {
    expect(messageItems(userMessage('Hi'))).toEqual([{ kind: 'user', text: 'Hi' }])
    expect(messageItems(toolResults([{ callId: 'a', text: 'x', isError: false }], 'note'))).toEqual(
      []
    )
  })

  it('every assistant part type, in order', () => {
    const m: Message = {
      role: 'assistant',
      by: { provider: 'claude', model: 'claude-opus-5-5' },
      parts: [
        { type: 'thinking', text: 'Let me see.' },
        { type: 'thinking', text: '', redacted: true },
        { type: 'fallback', from: 'claude-opus-5-5', to: 'claude-sonnet-5-5' },
        { type: 'compaction' },
        { type: 'tool_call', id: 't1', name: 'vault_read', input: { path: 'a.md' } },
        { type: 'text', text: 'Done.' }
      ]
    }
    expect(messageItems(m)).toEqual([
      { kind: 'thinking', text: 'Let me see.' },
      // Redacted thinking has nothing to show; a compaction shows as the
      // chat's compaction line, not in the message.
      { kind: 'fallback', to: 'claude-sonnet-5-5' },
      { kind: 'tool', id: 't1', name: 'vault_read', input: { path: 'a.md' } },
      { kind: 'text', text: 'Done.' }
    ])
  })

  it('a cut-off reply shows its text', () => {
    expect(messageItems(partialReply('I was'))).toEqual([{ kind: 'text', text: 'I was' }])
  })
})

describe('turnEnds', () => {
  it('a turn runs from what the user typed to the message before the next', () => {
    const said: Message = { role: 'assistant', parts: [{ type: 'text', text: 'x' }] }
    const msgs: Message[] = [
      userMessage('a'),
      said,
      toolResults([{ callId: 't', text: '', isError: false }]),
      said,
      userMessage('b'),
      said
    ]
    expect([...turnEnds(msgs)]).toEqual([
      [3, 0],
      [5, 4]
    ])
  })
})
