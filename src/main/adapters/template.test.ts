import { describe, expect, it } from 'vitest'
import { providerIds } from '../../shared/providers'
import { adapterFor } from './registry'
import { templateAdapter } from './template'

// The template makes no request in these tests; its request code is
// untested (see template.ts).
describe('the provider template', () => {
  const a = templateAdapter('deepseek')

  it('is not registered', () => {
    for (const p of providerIds) expect(adapterFor(p)).not.toBe(a)
  })

  it('lists the profile models without a key, asking nothing', async () => {
    const l = await a.listModels(null)
    expect(l.checkedAt).toBeNull()
    expect(l.models.map((m) => m.id)).toEqual(['deepseek-v4-pro', 'deepseek-flash'])
    expect(l.models.every((m) => m.available === 'unchecked')).toBe(true)
  })

  it('reads capabilities from the local rules', () => {
    expect(a.getCapabilities('deepseek-flash')).toEqual(
      adapterFor('deepseek').getCapabilities('deepseek-flash')
    )
  })

  it('has no search and sends the whole history', async () => {
    const r = await a.webSearch({
      model: 'm',
      apiKey: 'k',
      query: 'q',
      signal: new AbortController().signal
    })
    expect(r.error).toMatch(/isn't available/)
    expect(a.historyStart({ messages: [] } as never, 'm')).toBe(0)
  })
})
