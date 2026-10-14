import { describe, expect, it } from 'vitest'
import { chatModels, introduce } from './chat'
import { costOf, PRICES } from './pricing'
import { CONTEXT_LIMITS } from '../main/context'
import { isProvider, providerIds, providerNames, providers, responsesFeatures } from './providers'

// Every provider is one entry; whatever else a provider needs is checked here
// so a new entry can't be half added.

describe('providers', () => {
  it('lists Claude, OpenAI then DeepSeek, with their names', () => {
    expect(providerIds).toEqual(['claude', 'openai', 'deepseek'])
    expect(providerNames).toEqual({ claude: 'Claude', openai: 'OpenAI', deepseek: 'DeepSeek' })
  })

  it('knows only its own provider names (they become file names)', () => {
    expect(isProvider('claude')).toBe(true)
    expect(isProvider('openai')).toBe(true)
    expect(isProvider('deepseek')).toBe(true)
    for (const bad of ['__proto__', 'constructor', 'toString', '../x', '', null, 1])
      expect(isProvider(bad)).toBe(false)
  })

  it('has models, prices and context limits for every provider and its summary model', () => {
    for (const p of providerIds) {
      const models = chatModels().filter((m) => m.provider === p)
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
      tokenCount: true
    })
    expect(providers.claude.api).toBe('anthropic')
  })

  it("asks DeepSeek for none of the Responses features it doesn't have", () => {
    expect(providers.deepseek.api).toBe('responses')
    expect(responsesFeatures('deepseek')).toEqual({
      reasoningSummary: false,
      encryptedReasoning: false,
      tokenCount: false
    })
  })

  it('prices DeepSeek at its peak rates', () => {
    // 1M fresh input, 1M cached, 1M output on Flash: 0.30 + 0.006 + 1.20.
    expect(
      costOf('deepseek-flash', {
        input: 1_000_000,
        cacheWrite: 0,
        cacheRead: 1_000_000,
        output: 1_000_000,
        webSearches: 0
      })
    ).toBeCloseTo(1.506, 6)
  })

  it('introduces each model as before', () => {
    expect(introduce({ label: 'Opus 5.5', provider: 'claude' })).toBe('You are Claude')
    expect(introduce({ label: 'GPT-6 Astra', provider: 'openai' })).toBe(
      'You are GPT-6 Astra, an OpenAI model'
    )
    expect(introduce({ label: 'DeepSeek Flash', provider: 'deepseek' })).toBe(
      'You are DeepSeek Flash, a DeepSeek model'
    )
  })
})
