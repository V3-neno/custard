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
