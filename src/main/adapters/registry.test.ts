import { describe, expect, it } from 'vitest'
import { chatModels } from '../../shared/chat'
import { providerIds, providers } from '../../shared/providers'
import { adapterFor, adapterForModel, allModels } from './registry'

describe('provider adapters', () => {
  it('has one adapter per provider, speaking its API', () => {
    for (const p of providerIds) {
      expect(adapterFor(p).id).toBe(p)
      expect(adapterFor(p).api).toBe(providers[p].api)
    }
    expect(adapterForModel('deepseek-flash').id).toBe('deepseek')
    expect(adapterForModel('gpt-6-luna').id).toBe('openai')
    expect(adapterForModel('claude-opus-5-5').id).toBe('claude')
  })

  it("lists the same models as Custard's fixed list, unchecked, without a key", async () => {
    const listed = await allModels()
    expect(listed.map((m) => [m.id, m.label, m.provider])).toEqual(
      chatModels.map((m) => [m.id, m.label, m.provider])
    )
    expect(listed.every((m) => m.available === 'unchecked' && m.source === 'profile')).toBe(true)
  })

  it('starts the history where each provider can read it', () => {
    const c = {
      id: 'c',
      mode: 'chat' as const,
      title: '',
      createdAt: 0,
      updatedAt: 0,
      messages: []
    }
    for (const p of providerIds) expect(adapterFor(p).historyStart(c, chatModels[0].id)).toBe(0)
  })
})
