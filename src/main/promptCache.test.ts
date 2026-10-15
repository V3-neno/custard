import { describe, expect, it } from 'vitest'
import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import type { PromptSnapshot } from '../shared/chat'
import {
  bumpMemoryEpoch,
  CACHE_TTL_MS,
  chooseDeferred,
  contextBefore,
  hashFixed,
  memoryEpoch,
  newContext,
  refreshReason,
  withMessageContext
} from './promptCache'

const vault = (memory: string[], extra = '', day = '2026-10-15'): string =>
  [
    "The user's Obsidian vault is connected.",
    extra,
    `Today's date is ${day} (Thursday). The user's time zone is Europe/Stockholm.`,
    `<memory>\n${memory.join('\n')}\n</memory>`
  ]
    .filter(Boolean)
    .join('\n\n')

const T = 1_000_000
const snap = (over: Partial<PromptSnapshot> = {}): PromptSnapshot => ({
  at: T,
  model: 'claude-opus-5-5',
  fixed: 'f1',
  memory: true,
  epoch: memoryEpoch(),
  deferred: [vault(['- likes tea']), '- chat A'],
  ...over
})
const next = (over: Partial<Parameters<typeof refreshReason>[1]> = {}) => ({
  model: 'claude-opus-5-5',
  fixed: 'f1',
  memory: true,
  deferred: [vault(['- likes tea']), '- chat A'],
  ...over
})

describe('deferred prompt parts', () => {
  it('builds them fresh for a chat with no snapshot', () => {
    expect(refreshReason(undefined, next(), T)).toBe('new')
  })

  it('keeps sending the old ones while the cache is warm and only things were added', () => {
    const prev = snap()
    const n = next({
      deferred: [
        vault(['- likes tea', '- moved to Malmö'], 'Remembered from earlier chats:\n- new capture'),
        '- chat B\n- chat A'
      ]
    })
    const c = chooseDeferred(prev, n, T + 60_000)
    expect(c.reason).toBeNull()
    expect(c.deferred).toEqual(prev.deferred)
    // The snapshot keeps what was sent, so the next message matches too.
    expect(c.snapshot.deferred).toEqual(prev.deferred)
  })

  it('takes the new ones once the cache has gone cold', () => {
    const n = next({ deferred: [vault(['- likes tea', '- new']), '- chat B'] })
    const c = chooseDeferred(snap(), n, T + CACHE_TTL_MS + 1)
    expect(c.reason).toBe('cold')
    expect(c.deferred).toEqual(n.deferred)
  })

  it('takes the new ones when the rest of the request changed anyway', () => {
    expect(refreshReason(snap(), next({ fixed: 'f2' }), T + 1000)).toBe('changed')
    expect(refreshReason(snap(), next({ model: 'claude-sonnet-5-5' }), T + 1000)).toBe('model')
  })

  it('drops memory at once when it is turned off for the chat', () => {
    expect(refreshReason(snap(), next({ memory: false }), T + 1000)).toBe('memory')
  })

  it('drops forgotten notes at once', () => {
    const prev = snap()
    bumpMemoryEpoch()
    expect(refreshReason(prev, next(), T + 1000)).toBe('forgotten')
  })

  it('moves to a new day at once', () => {
    const n = next({ deferred: [vault(['- likes tea'], '', '2026-10-16'), '- chat A'] })
    expect(refreshReason(snap(), n, T + 1000)).toBe('day')
  })

  it('drops a line the user took out of Memory.md at once', () => {
    const n = next({ deferred: [vault([]), '- chat A'] })
    expect(refreshReason(snap(), n, T + 1000)).toBe('removed')
  })

  it('rebuilds when a part appears or goes', () => {
    expect(refreshReason(snap(), next({ deferred: [vault(['- likes tea']), ''] }), T + 1)).toBe(
      'shape'
    )
    expect(refreshReason(snap(), next({ deferred: [vault(['- likes tea'])] }), T + 1)).toBe('shape')
  })

  it('treats a clock that went back as cold', () => {
    expect(refreshReason(snap(), next(), T - 1)).toBe('cold')
  })

  it('hashes the fixed part by content', () => {
    expect(hashFixed([['a', 'b'], []])).toBe(hashFixed([['a', 'b'], []]))
    expect(hashFixed([['a', 'b'], []])).not.toBe(hashFixed([['a', 'c'], []]))
  })
})

describe('context sent with a message', () => {
  it("adds a plugin's notes only when they aren't in the chat already", () => {
    const first = newContext([], 0, [{ plugin: 'spotify', text: 'notes v1' }])
    expect(first).toEqual([{ at: 0, plugin: 'spotify', text: 'notes v1' }])
    expect(newContext(first, 2, [{ plugin: 'spotify', text: 'notes v1' }])).toEqual([])
    expect(newContext(first, 2, [{ plugin: 'spotify', text: 'notes v2' }])).toEqual([
      { at: 2, plugin: 'spotify', text: 'notes v2' }
    ])
    expect(newContext(first, 2, [{ plugin: 'hue', text: 'h' }])).toEqual([
      { at: 2, plugin: 'hue', text: 'h' }
    ])
  })

  it('compares against the newest notes for the plugin', () => {
    const have = [
      { at: 4, plugin: 'spotify', text: 'v2' },
      { at: 0, plugin: 'spotify', text: 'v1' }
    ]
    expect(newContext(have, 6, [{ plugin: 'spotify', text: 'v2' }])).toEqual([])
    expect(newContext(have, 6, [{ plugin: 'spotify', text: 'v1' }])).toHaveLength(1)
  })

  it('sends it in front of its message, every time, without changing the saved one', () => {
    const messages: BetaMessageParam[] = [
      { role: 'user', content: 'play something' },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      { role: 'user', content: 'thanks' }
    ]
    const ctx = [{ at: 0, plugin: 'spotify', text: '<plugin-notes plugin="Spotify">' }]
    const sent = withMessageContext(messages, ctx)
    expect(messages[0].content).toBe('play something')
    const first = sent[0].content as { type: string; text: string }[]
    expect(first).toHaveLength(2)
    expect(first[0].text).toContain("the user didn't write it")
    expect(first[0].text).toContain('<plugin-notes plugin="Spotify">')
    expect(first[1]).toEqual({ type: 'text', text: 'play something' })
    expect(sent[1]).toBe(messages[1])
    expect(sent[2]).toBe(messages[2])
    expect(withMessageContext(messages, ctx)).toEqual(sent)
  })

  it('puts it before attached files and never adds an empty text block', () => {
    const messages: BetaMessageParam[] = [
      {
        role: 'user',
        content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x' } }]
      },
      { role: 'user', content: '  ' }
    ]
    const ctx = [
      { at: 0, plugin: 'a', text: 'A' },
      { at: 1, plugin: 'b', text: 'B' }
    ]
    const sent = withMessageContext(messages, ctx)
    const withFile = sent[0].content as { type: string }[]
    expect(withFile.map((b) => b.type)).toEqual(['text', 'image'])
    expect(sent[1].content).toHaveLength(1)
  })

  it('is left alone without context', () => {
    const messages: BetaMessageParam[] = [{ role: 'user', content: 'hi' }]
    expect(withMessageContext(messages, undefined)).toBe(messages)
  })

  it('goes with a turn that is taken back', () => {
    const have = [
      { at: 0, plugin: 'a', text: 'A' },
      { at: 4, plugin: 'b', text: 'B' }
    ]
    expect(contextBefore(have, 4)).toEqual([{ at: 0, plugin: 'a', text: 'A' }])
    expect(contextBefore(undefined, 4)).toEqual([])
  })
})
