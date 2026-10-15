import fs from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { capabilities } from '../shared/adapter'
import { chatModels, defaultChatSettings, effortChoices, shownEffort } from '../shared/chat'
import {
  efforts,
  builtInProfiles,
  profileOf,
  providerEffort,
  sentLevel,
  shownLevel,
  type EffortSpec,
  type ModelProfile
} from '../shared/models'
import { PRICES } from '../shared/pricing'
import { providerIds, providers } from '../shared/providers'
import { kindRefusal } from './attachments/request'
import { CONTEXT_LIMITS } from './context'
import { HANDOFF_MODELS } from './handoff'
import { SUMMARY_MODELS } from './memory/summarize'

// Workstream A, Phase A2: one profile per built-in model, and the old tables
// as views of it.

const profiles = builtInProfiles as readonly ModelProfile[]
const ids = profiles.map((m) => m.id)

// The tables as they were written before the profiles (a8ec2e7).
const OLD_CHAT_MODELS = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5', provider: 'claude', effort: true, fallbacks: true },
  {
    id: 'claude-sonnet-5-5',
    label: 'Sonnet 5.5',
    provider: 'claude',
    effort: true,
    fallbacks: true
  },
  {
    id: 'claude-haiku-4-5',
    label: 'Haiku 4.5',
    provider: 'claude',
    effort: false,
    fallbacks: false
  },
  { id: 'gpt-6-astra', label: 'GPT-6 Astra', provider: 'openai', effort: true, fallbacks: false },
  { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', provider: 'openai', effort: true, fallbacks: false },
  { id: 'gpt-6-luna', label: 'GPT-6 Luna', provider: 'openai', effort: true, fallbacks: false },
  {
    id: 'deepseek-v4-pro',
    label: 'DeepSeek V4 Pro',
    provider: 'deepseek',
    effort: true,
    fallbacks: false
  },
  {
    id: 'deepseek-flash',
    label: 'DeepSeek Flash',
    provider: 'deepseek',
    effort: true,
    fallbacks: false
  }
]
const OLD_CONTEXT_LIMITS = {
  'claude-opus-5-5': { window: 1_000_000, maxOutput: 128_000, compaction: true },
  'claude-sonnet-5-5': { window: 1_000_000, maxOutput: 128_000, compaction: true },
  'claude-haiku-4-5': { window: 200_000, maxOutput: 64_000, compaction: false },
  'gpt-6-astra': { window: 1_050_000, maxOutput: 128_000, compaction: true },
  'gpt-6.1-sol': { window: 1_050_000, maxOutput: 128_000, compaction: true },
  'gpt-6-luna': { window: 1_050_000, maxOutput: 128_000, compaction: true },
  'deepseek-flash': { window: 1_000_000, maxOutput: 384_000, compaction: false },
  'deepseek-v4-pro': { window: 1_000_000, maxOutput: 384_000, compaction: false }
}
const OLD_PRICES = {
  'claude-opus-5-5': { input: 4, cacheWrite: 5, cacheRead: 0.2, output: 20 },
  'claude-sonnet-5-5': { input: 2, cacheWrite: 2.5, cacheRead: 0.1, output: 10 },
  'claude-haiku-4-5': { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 },
  'gpt-6-astra': {
    input: 10,
    cacheWrite: 10,
    cacheRead: 1,
    output: 50,
    long: { over: 270_000, input: 20, cacheWrite: 20, cacheRead: 2, output: 75 }
  },
  'gpt-6.1-sol': {
    input: 2,
    cacheWrite: 2,
    cacheRead: 0.1,
    output: 10,
    long: { over: 270_000, input: 4, cacheWrite: 4, cacheRead: 0.2, output: 15 }
  },
  'gpt-6-luna': {
    input: 0.1,
    cacheWrite: 0.1,
    cacheRead: 0.01,
    output: 0.5,
    long: { over: 270_000, input: 0.2, cacheWrite: 0.2, cacheRead: 0.02, output: 0.75 }
  },
  'deepseek-flash': { input: 0.3, cacheWrite: 0.3, cacheRead: 0.006, output: 1.2 },
  'deepseek-v4-pro': { input: 1.32, cacheWrite: 1.32, cacheRead: 0.044, output: 3.96 }
}
// The hosted search tool claudeSearchTool picked by id pattern, the
// web_search flag each Responses provider had, and the model the old
// image rule singled out (DeepSeek images) or gave the small tier (Haiku).
const OLD_SEARCH = {
  'claude-opus-5-5': 'claude-20260209',
  'claude-sonnet-5-5': 'claude-20260209',
  'claude-haiku-4-5': 'claude-20250305',
  'gpt-6-astra': 'responses',
  'gpt-6.1-sol': 'responses',
  'gpt-6-luna': 'responses',
  'deepseek-v4-pro': false,
  'deepseek-flash': false
}
const OLD_LIVE = { 'deepseek-flash': ['vision', 'json_schema'] }

describe('model profiles', () => {
  it('every built-in model has exactly one profile', () => {
    expect(ids.length).toBe(8)
    expect(new Set(ids).size).toBe(ids.length)
    expect(chatModels().map((m) => m.id)).toEqual(ids)
    for (const id of ids) expect(profiles.filter((m) => m.id === id)).toHaveLength(1)
  })

  it('every model named by id elsewhere has a profile', () => {
    for (const p of providerIds) {
      expect(profileOf(providers[p].summaryModel)?.provider, p).toBe(p)
      expect(SUMMARY_MODELS[p]).toBe(providers[p].summaryModel)
      expect(HANDOFF_MODELS[p]).toBe(providers[p].summaryModel)
    }
    expect(profileOf(defaultChatSettings.model)).toBeDefined()
    // The first model: what a new automation starts on (Settings → Automations).
    expect(profileOf(chatModels()[0].id)).toBe(profiles[0])
    // Each provider has at least one model, and every live capability is real.
    for (const p of providerIds) expect(profiles.some((m) => m.provider === p)).toBe(true)
    for (const m of profiles) for (const c of m.live ?? []) expect(capabilities, m.id).toContain(c)
  })

  it('chatModels(), CONTEXT_LIMITS and PRICES equal the old tables for all 8 models', () => {
    expect(chatModels()).toEqual(OLD_CHAT_MODELS)
    expect(CONTEXT_LIMITS).toEqual(OLD_CONTEXT_LIMITS)
    expect(PRICES).toEqual(OLD_PRICES)
  })

  it('search, image rules and live evidence equal what the code used to decide', () => {
    expect(Object.fromEntries(profiles.map((m) => [m.id, m.search]))).toEqual(OLD_SEARCH)
    expect(Object.fromEntries(profiles.flatMap((m) => (m.live ? [[m.id, m.live]] : [])))).toEqual(
      OLD_LIVE
    )
    for (const m of profiles) {
      expect(m.files.imageTokens, m.id).toBe(
        m.id === 'claude-haiku-4-5'
          ? 'claude-small'
          : m.provider === 'claude'
            ? 'claude'
            : 'patches'
      )
      expect(m.thinking, m.id).toBe(m.provider === 'claude' ? m.effort !== null : true)
    }
  })

  it('what a profile says about files agrees with the attachment rules', () => {
    for (const m of profiles) {
      expect(kindRefusal(m, 'image') === null, m.id).toBe(m.files.images)
      expect(kindRefusal(m, 'pdf') === null, m.id).toBe(m.files.pdf)
    }
  })

  it("a provider's models share their effort levels (the picker shows one row per provider)", () => {
    for (const p of providerIds) {
      const specs = profiles.filter((m) => m.provider === p && m.effort).map((m) => m.effort)
      for (const s of specs) expect(s).toEqual(providerEffort(p))
    }
  })
})

describe('effort as data', () => {
  it("DeepSeek's Fast, Balanced and Thorough store and send low, high and max, from its profiles", () => {
    for (const id of ['deepseek-v4-pro', 'deepseek-flash']) {
      const spec = profileOf(id)!.effort!
      expect(spec.levels.map((l) => [l.label, l.value, l.send])).toEqual([
        ['Fast', 'low', 'low'],
        ['Balanced', 'high', 'high'],
        ['Thorough', 'max', 'max']
      ])
      expect(spec.otherwise).toBe('high')
      expect(efforts.map((e) => sentLevel(spec, e))).toEqual(['low', 'high', 'high', 'high', 'max'])
    }
  })

  it('the mapping follows the data, not a provider name', () => {
    const spec: EffortSpec = {
      levels: [
        { value: 'low', label: 'Quick', settingsLabel: 'Quick', send: 'medium' },
        { value: 'max', label: 'Deep', settingsLabel: 'Deep', send: 'xhigh' }
      ],
      otherwise: 'max'
    }
    expect(efforts.map((e) => shownLevel(spec, e))).toEqual(['low', 'max', 'max', 'max', 'max'])
    expect(efforts.map((e) => sentLevel(spec, e))).toEqual([
      'medium',
      'xhigh',
      'xhigh',
      'xhigh',
      'xhigh'
    ])
    expect(shownLevel(null, 'xhigh')).toBe('xhigh')
  })

  it('Claude and OpenAI keep every level, with the same labels as before', () => {
    for (const p of ['claude', 'openai'] as const) {
      expect(effortChoices(p).map((e) => e.label)).toEqual([
        'Low',
        'Medium',
        'High',
        'X-High',
        'Max'
      ])
      expect(providerEffort(p)!.levels.map((l) => l.settingsLabel)).toEqual(
        efforts.map((e) => `${e} effort`)
      )
      expect(efforts.map((e) => shownEffort(p, e))).toEqual(efforts)
    }
    expect(providerEffort('deepseek')!.levels.map((l) => l.settingsLabel)).toEqual([
      'Fast',
      'Balanced',
      'Thorough'
    ])
  })

  it('no code outside the profiles branches on DeepSeek by name for effort', () => {
    const files: string[] = []
    const walk = (d: string): void => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) files.push(p)
      }
    }
    walk(join(__dirname, '..'))
    expect(files.length).toBeGreaterThan(50)
    for (const f of files) {
      const text = fs.readFileSync(f, 'utf8')
      expect(/deepseekEfforts?\b/.test(text), f).toBe(false)
      expect(/=== 'deepseek'/.test(text), f).toBe(false)
    }
  })
})
