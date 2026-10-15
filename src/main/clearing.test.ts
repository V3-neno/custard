import { describe, expect, it } from 'vitest'
import type { ActionRecord, Conversation } from '../shared/chat'
import type { Message } from '../shared/neutralChat'
import { CLEAR_LIMITS, clearableTokens, keepFrom, nextMark, withClearedResults } from './clearing'

const big = (n = 30_000): string => 'x'.repeat(n)
const action = (
  status: ActionRecord['status'] = 'completed',
  label = 'Read a page'
): ActionRecord => ({
  name: 'web_read',
  label,
  write: false,
  status,
  key: 'k'
})

// One turn: the user's message, a tool call, its result, the answer.
function turn(id: string, result: string, opts: { error?: boolean } = {}): Message[] {
  return [
    { role: 'user', parts: [{ type: 'text', text: `question ${id}` }] },
    {
      role: 'assistant',
      parts: [{ type: 'tool_call', id, name: 'web_read', input: { url: `https://x/${id}` } }]
    },
    {
      role: 'user',
      parts: [{ type: 'tool_result', callId: id, text: result, isError: !!opts.error }]
    },
    { role: 'assistant', parts: [{ type: 'text', text: `answer ${id}` }] }
  ]
}

const chat = (
  n: number,
  size = 30_000
): { messages: Message[]; actions: Conversation['actions'] } => {
  const messages: Message[] = []
  const actions: Conversation['actions'] = {}
  for (let i = 0; i < n; i++) {
    messages.push(...turn(`t${i}`, big(size)))
    actions[`t${i}`] = action()
  }
  // The message that starts the new turn.
  messages.push({ role: 'user', parts: [{ type: 'text', text: 'next question' }] })
  return { messages, actions }
}

const resultOf = (m: Message): string => {
  const b = (m.parts as { type: string; text?: string }[]).find((x) => x.type === 'tool_result')
  return String(b?.text)
}

describe('where clearing may reach', () => {
  it('keeps the newest turns, counting the one just starting', () => {
    const { messages } = chat(5)
    // Turns start at 0, 4, 8, 12, 16 and the new one at 20; with three kept,
    // the mark can reach the turn at 12.
    expect(CLEAR_LIMITS.keepTurns).toBe(3)
    expect(keepFrom(messages)).toBe(12)
  })

  it('reaches nothing in a short chat', () => {
    expect(keepFrom(chat(1).messages)).toBe(0)
  })

  it('counts only results that may be cleared', () => {
    const { messages, actions } = chat(3)
    expect(clearableTokens(messages, actions, 0, 8)).toBe(20_000)
    // A small result, an error and an unknown outcome are never cleared.
    const small = [
      ...turn('s', big(500)),
      ...turn('e', big(), { error: true }),
      ...turn('u', big())
    ]
    const acts = { s: action(), e: action('failed'), u: action('unknown') }
    expect(clearableTokens(small, acts, 0, small.length)).toBe(0)
  })
})

describe('when the mark moves', () => {
  const base = (
    over: Partial<Parameters<typeof nextMark>[0]> = {}
  ): Parameters<typeof nextMark>[0] => {
    const { messages, actions } = chat(5)
    return {
      messages,
      actions,
      cleared: 0,
      sentFrom: 0,
      cacheMiss: false,
      history: 60_000,
      trigger: 150_000,
      ...over
    }
  }

  it('stays put while the cache is warm and the chat is far from compaction', () => {
    expect(nextMark(base())).toBeNull()
  })

  it('moves when the request misses the cache anyway', () => {
    expect(nextMark(base({ cacheMiss: true }))).toBe(12)
  })

  it('moves near compaction when much can go', () => {
    expect(nextMark(base({ history: 130_000 }))).toBe(12)
    // Near compaction but too little to clear.
    const { messages, actions } = chat(5, 3_000)
    expect(nextMark(base({ messages, actions, history: 130_000 }))).toBeNull()
  })

  it('never moves back, and skips a jump that clears too little', () => {
    expect(nextMark(base({ cleared: 12, cacheMiss: true }))).toBeNull()
    const { messages, actions } = chat(5, 2_500)
    expect(nextMark(base({ messages, actions, cacheMiss: true, cleared: 8 }))).toBeNull()
  })

  it('counts only what is sent after the newest compaction', () => {
    expect(nextMark(base({ cacheMiss: true, sentFrom: 11 }))).toBeNull()
  })
})

describe('what is sent', () => {
  it('replaces big results before the mark with a stub and keeps the rest', () => {
    const { messages, actions } = chat(5)
    const sent = withClearedResults(messages, actions, 12)
    const stub = resultOf(sent[2])
    expect(stub).toContain('Custard cleared this result')
    expect(stub).toContain('Read a page (web_read), 30,000 characters, it ran')
    expect(stub.length).toBeLessThan(300)
    expect(resultOf(sent[14])).toBe(big())
    // Saved messages are not changed, and the same input gives the same stub.
    expect(resultOf(messages[2])).toBe(big())
    expect(withClearedResults(messages, actions, 12)).toEqual(sent)
    // The tool call / result pairing is kept.
    expect((sent[2].parts as { callId: string }[])[0].callId).toBe('t0')
  })

  it('leaves the history alone without a mark', () => {
    const { messages, actions } = chat(3)
    expect(withClearedResults(messages, actions, undefined)).toBe(messages)
    expect(withClearedResults(messages, actions, 0)).toBe(messages)
  })

  it('keeps errors, unknown outcomes and small results', () => {
    const msgs = [...turn('e', big(), { error: true }), ...turn('u', big()), ...turn('s', big(100))]
    const acts = { e: action('failed'), u: action('unknown'), s: action() }
    expect(withClearedResults(msgs, acts, msgs.length)).toBe(msgs)
  })
})
