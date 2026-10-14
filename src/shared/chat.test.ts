import { describe, expect, it } from 'vitest'
import {
  chatModels,
  chatSettingsOf,
  deepseekEffort,
  deepseekEfforts,
  effortChoices,
  efforts,
  isChatModel,
  isEffort,
  isMode,
  shownEffort,
  modes,
  type Conversation
} from './chat'

// L17: a mode sent by the renderer is checked before it picks prompts and tools.
describe('isMode', () => {
  it('accepts only the four modes', () => {
    expect(['chat', 'code', 'design', 'skills'].every(isMode)).toBe(true)
    for (const m of ['', 'Code', 'admin', '__proto__', 'toString', undefined, 1])
      expect(isMode(m)).toBe(false)
  })
})

describe('mode bar', () => {
  it('reads Chat, Design, Plugins, Skills; Plugins keeps the id code', () => {
    expect(modes.map((m) => m.label)).toEqual(['Chat', 'Design', 'Plugins', 'Skills'])
    expect(modes.map((m) => m.id)).toEqual(['chat', 'design', 'code', 'skills'])
  })
})

// Phase 6: each chat keeps its own model and effort.
describe('a chat’s model', () => {
  const fallback = { model: 'deepseek-flash', effort: 'low' } as const
  const chat = (extra: Record<string, unknown>): Conversation =>
    ({
      id: 'c',
      mode: 'chat',
      title: '',
      createdAt: 0,
      messages: [],
      ...extra
    }) as unknown as Conversation

  it('is the one saved on the chat', () => {
    expect(chatSettingsOf(chat({ model: 'gpt-6-luna', effort: 'max' }), fallback)).toEqual({
      model: 'gpt-6-luna',
      effort: 'max'
    })
  })

  it('for a chat from before, the model its last request used', () => {
    expect(
      chatSettingsOf(
        chat({
          context: { model: 'claude-sonnet-5-5', tokens: 1, budget: 2, counted: true, warn: false }
        }),
        fallback
      )
    ).toEqual({ model: 'claude-sonnet-5-5', effort: 'low' })
  })

  it('otherwise, and for a new chat, the default; unknown values are ignored', () => {
    expect(chatSettingsOf(null, fallback)).toEqual(fallback)
    expect(chatSettingsOf(chat({ model: 'gpt-4', effort: 'huge' }), fallback)).toEqual(fallback)
  })

  it('knows only the models in the picker', () => {
    expect(chatModels.every((m) => isChatModel(m.id))).toBe(true)
    for (const x of ['', 'gpt-4', 'claude-opus-4', undefined, '__proto__'])
      expect(isChatModel(x)).toBe(false)
    expect(['low', 'medium', 'high', 'xhigh', 'max'].every(isEffort)).toBe(true)
    expect(isEffort('balanced')).toBe(false)
  })
})

describe('DeepSeek effort', () => {
  it('Fast, Balanced, Thorough send low, high, max (the documented values)', () => {
    expect(deepseekEfforts.map((e) => [e.label, e.effort])).toEqual([
      ['Fast', 'low'],
      ['Balanced', 'high'],
      ['Thorough', 'max']
    ])
  })

  it('any other level is Balanced', () => {
    expect(efforts.map(deepseekEffort)).toEqual(['low', 'high', 'high', 'high', 'max'])
  })
})

describe('effort buttons in the model picker', () => {
  it('Claude and OpenAI show every level as it is sent', () => {
    for (const p of ['claude', 'openai'] as const) {
      expect(effortChoices(p).map((e) => [e.label, e.effort])).toEqual([
        ['Low', 'low'],
        ['Medium', 'medium'],
        ['High', 'high'],
        ['X-High', 'xhigh'],
        ['Max', 'max']
      ])
      expect(efforts.map((e) => shownEffort(p, e))).toEqual(efforts)
    }
  })

  it('DeepSeek shows its own three, and any other level as Balanced', () => {
    expect(effortChoices('deepseek')).toBe(deepseekEfforts)
    expect(shownEffort('deepseek', 'medium')).toBe('high')
  })
})
