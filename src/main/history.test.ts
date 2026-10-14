import { describe, expect, it } from 'vitest'
import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { withoutUnavailableTools } from './history'

const history: BetaMessageParam[] = [
  { role: 'user', content: 'queue songs' },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: 'On it.' },
      {
        type: 'tool_use',
        id: 't1',
        name: 'spotify__add_to_queue',
        input: { uris: ['spotify:track:x'] }
      },
      { type: 'tool_use', id: 't2', name: 'vault_read', input: { path: 'a.md' } }
    ]
  },
  {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 't1', content: 'All 1 tracks were accepted' },
      { type: 'tool_result', tool_use_id: 't2', content: 'note' }
    ]
  }
]

describe('withoutUnavailableTools', () => {
  it('turns calls to unavailable tools into text and keeps the rest', () => {
    const out = withoutUnavailableTools(history, new Set(['vault_read']))
    const a = out[1].content as { type: string; text?: string; name?: string }[]
    expect(a.map((b) => b.type)).toEqual(['text', 'text', 'tool_use'])
    expect(a[1].text).toContain('spotify__add_to_queue')
    const u = out[2].content as { type: string; text?: string }[]
    expect(u.map((b) => b.type)).toEqual(['text', 'tool_result'])
    expect(JSON.stringify(out)).not.toMatch(/"name":"spotify__add_to_queue"/)
  })

  it('returns the same history when every tool is available', () => {
    expect(withoutUnavailableTools(history, new Set(['vault_read', 'spotify__add_to_queue']))).toBe(
      history
    )
  })
})

// Phase 6: switching a chat from Opus 5.5 to DeepSeek Flash mid-chat. Opus
// searched the web; DeepSeek has no web search in Custard, so that call goes
// to DeepSeek as text while web_read, which both have, stays a call.
describe('switching model mid-chat', () => {
  it("turns the new model's missing tools into text", async () => {
    const { webTools } = await import('./web')
    const names = (id: string, provider: 'claude' | 'deepseek'): Set<string> =>
      new Set(webTools({ id, provider }).tools.map((t) => t.name))
    expect(names('claude-opus-5-5', 'claude').has('web_search')).toBe(true)
    const deepseek = names('deepseek-flash', 'deepseek')
    expect(deepseek.has('web_search')).toBe(false)
    const chat: BetaMessageParam[] = [
      { role: 'user', content: 'news?' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 's', name: 'web_search', input: { query: 'news' } },
          { type: 'tool_use', id: 'r', name: 'web_read', input: { url: 'https://a.example' } }
        ]
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 's', content: 'Results.' },
          { type: 'tool_result', tool_use_id: 'r', content: 'Page.' }
        ]
      }
    ]
    const sent = withoutUnavailableTools(chat, deepseek)
    expect(sent[1].content).toEqual([
      {
        type: 'text',
        text: '[Earlier call to web_search, which is not available now: {"query":"news"}]'
      },
      { type: 'tool_use', id: 'r', name: 'web_read', input: { url: 'https://a.example' } }
    ])
    expect(sent[2].content).toEqual([
      { type: 'text', text: '[Result of that earlier call: Results.]' },
      { type: 'tool_result', tool_use_id: 'r', content: 'Page.' }
    ])
  })
})
