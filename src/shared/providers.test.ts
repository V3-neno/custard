import { describe, expect, it } from 'vitest'
import { chatModels, introduce } from './chat'
import { PRICES } from './pricing'
import { CONTEXT_LIMITS } from '../main/context'
import { isProvider, providerIds, providerNames, providers, responsesFeatures } from './providers'

// Every provider is one entry; whatever else a provider needs is checked here
// so a new entry can't be half added.

describe('providers', () => {
  it('lists Claude then OpenAI, with their names', () => {
    expect(providerIds).toEqual(['claude', 'openai'])
    expect(providerNames).toEqual({ claude: 'Claude', openai: 'OpenAI' })
  })

  it('knows only its own provider names (they become file names)', () => {
    expect(isProvider('claude')).toBe(true)
    expect(isProvider('openai')).toBe(true)
    for (const bad of ['__proto__', 'constructor', 'toString', '../x', '', null, 1])
      expect(isProvider(bad)).toBe(false)
  })

  it('has models, prices and context limits for every provider and its summary model', () => {
    for (const p of providerIds) {
      const models = chatModels.filter((m) => m.provider === p)
      expect(models.length).toBeGreaterThan(0)
      for (const m of [...models.map((x) => x.id), providers[p].summaryModel]) {
        expect(PRICES[m], m).toBeDefined()
        expect(CONTEXT_LIMITS[m], m).toBeDefined()
      }
    }
  })

  it('keeps OpenAI on every Responses feature it had', () => {
    expect(providers.openai.api).toBe('responses')
    expect(responsesFeatures('openai')).toEqual({
      reasoningSummary: true,
      encryptedReasoning: true,
      tokenCount: true,
      webSearch: true
    })
    expect(providers.claude.api).toBe('anthropic')
  })

  it('introduces each model as before', () => {
    expect(introduce({ label: 'Opus 5.5', provider: 'claude' })).toBe('You are Claude')
    expect(introduce({ label: 'GPT-6 Astra', provider: 'openai' })).toBe(
      'You are GPT-6 Astra, an OpenAI model'
    )
  })
})
