import { describe, expect, it } from 'vitest'
import type { ModelCheck } from '../../shared/adapter'
import { chatModels } from '../../shared/chat'
import type { Provider } from '../../shared/providers'
import { availabilityFrom } from './checks'

// Which models a chat can use, from the saved keys and the last Save/Refresh
// check only: working this out never asks a provider.
const check = (result: ModelCheck['result'], available: string[] = []): ModelCheck => ({
  result,
  checkedAt: 1,
  models: chatModels().map((m) => ({
    id: m.id,
    label: m.label,
    available: available.includes(m.id),
    source: 'profile' as const
  }))
})
const of = (
  keys: Provider[],
  checks: Partial<Record<Provider, ModelCheck>> = {}
): Record<string, string> =>
  Object.fromEntries(
    availabilityFrom(
      (p) => keys.includes(p),
      (p) => checks[p] ?? null
    ).map((a) => [a.id, a.available ? 'ok' : a.reason!])
  )

describe('model availability', () => {
  it('a provider without a key: every model says no-key', () => {
    const a = of(['claude'])
    expect(a['claude-opus-5-5']).toBe('ok')
    expect(a['gpt-6-astra']).toBe('no-key')
    expect(a['deepseek-flash']).toBe('no-key')
  })

  it('no keys at all: nothing can be used', () => {
    expect(Object.values(of([])).every((r) => r === 'no-key')).toBe(true)
  })

  it('a key the provider rejected: every model says rejected', () => {
    const a = of(['openai'], { openai: check('auth') })
    expect(
      chatModels()
        .filter((m) => m.provider === 'openai')
        .map((m) => a[m.id])
    ).toEqual(['rejected', 'rejected', 'rejected'])
    expect(of(['openai'], { openai: check('permission') })['gpt-6-luna']).toBe('rejected')
  })

  it("a model the last check didn't list as available: removed", () => {
    const a = of(['claude'], { claude: check('ok', ['claude-opus-5-5']) })
    expect(a['claude-opus-5-5']).toBe('ok')
    expect(a['claude-sonnet-5-5']).toBe('removed')
  })

  it("a check that couldn't reach the provider, or none yet, changes nothing", () => {
    expect(of(['deepseek'], { deepseek: check('network') })['deepseek-flash']).toBe('ok')
    expect(of(['deepseek'])['deepseek-v4-pro']).toBe('ok')
  })
})
