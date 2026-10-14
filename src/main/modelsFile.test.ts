import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { builtInProfiles, profileOf, type ModelProfile } from '../shared/models'
import { chatModels, isChatModel } from '../shared/chat'
import { costOf, noUsage } from '../shared/pricing'
import { parseModelsFile, readModelsFile } from './modelsFile'
import { loadModelRegistry } from './modelRegistry'
import { capabilitiesOf, modelInfo } from './adapters/capabilities'
import { limitsFor } from './context'

// Phase A4: the user's models.json. Every rule, with a good and a bad case.

const P = '/data/models.json'
const file = (models: unknown[], extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ version: 1, models, ...extra })
const parse = (models: unknown[]): ReturnType<typeof parseModelsFile> =>
  parseModelsFile(file(models), P)
// The reason one entry was rejected, or null when it loaded.
const why = (entry: unknown): string | null => {
  const r = parse([entry])
  return r.report.rejected[0]?.reason ?? null
}
const one = (entry: unknown): ModelProfile => {
  const r = parse([entry])
  expect(r.report.rejected).toEqual([])
  return r.profiles[0]
}
const v5 = {
  id: 'deepseek-v5-preview',
  provider: 'deepseek',
  label: 'DeepSeek V5 Preview',
  limits: { window: 1_000_000, maxOutput: 384_000 }
}
const usage = { ...noUsage(), input: 1_000_000, output: 1_000_000 }

afterEach(() => {
  loadModelRegistry()
})

describe('the file', () => {
  it('missing or empty: no entries, no error', () => {
    expect(parseModelsFile(null, P)).toEqual({
      profiles: [],
      report: { path: P, status: 'missing', loaded: [], rejected: [] }
    })
    expect(parseModelsFile('  \n', P).report.status).toBe('empty')
    expect(parse([]).report).toEqual({ path: P, status: 'ok', loaded: [], rejected: [] })
  })

  it('a bad file loads nothing, with the reason', () => {
    const bad = (text: string): string | undefined => {
      const r = parseModelsFile(text, P)
      expect(r.profiles).toEqual([])
      expect(r.report.status).toBe('error')
      return r.report.error
    }
    expect(bad('{ "version": 1, "models": [')).toMatch(/^It isn't valid JSON/)
    expect(bad('[]')).toMatch(/must be an object/)
    expect(bad(JSON.stringify({ version: 2, models: [v5] }))).toMatch(/Unknown version 2/)
    expect(bad(JSON.stringify({ models: [v5] }))).toMatch(/Unknown version undefined/)
    expect(bad(file([v5], { keys: 'x' }))).toMatch(/Unknown field "keys" in the file/)
    expect(bad(JSON.stringify({ version: 1, models: {} }))).toMatch(/"models" must be a list/)
    expect(bad(file(Array.from({ length: 201 }, (_, i) => ({ ...v5, id: `m-${i}` }))))).toMatch(
      /At most 200/
    )
  })

  it('reads from disk: missing, unreadable and too large', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'models-'))
    const f = path.join(dir, 'models.json')
    expect(readModelsFile(f).report.status).toBe('missing')
    fs.mkdirSync(f)
    expect(readModelsFile(f).report).toMatchObject({ status: 'error' })
    expect(readModelsFile(f).report.error).toMatch(/couldn't be read/)
    fs.rmdirSync(f)
    fs.writeFileSync(f, ' '.repeat(1_000_001))
    expect(readModelsFile(f).report.error).toBe('It is larger than 1 MB.')
    fs.writeFileSync(f, file([v5]))
    expect(readModelsFile(f).report.loaded.map((m) => m.id)).toEqual([v5.id])
    fs.rmSync(dir, { recursive: true })
  })
})

describe('a new model', () => {
  it('needs only id, provider, label and limits; the rest is off', () => {
    expect(one(v5)).toEqual({
      ...v5,
      compaction: false,
      prices: null,
      thinking: false,
      effort: null,
      fallbacks: false,
      files: { images: false, pdf: false, imageTokens: 'patches' },
      search: false,
      origin: 'file'
    })
    expect(one({ ...v5, provider: 'claude', id: 'claude-x' }).files.imageTokens).toBe('claude')
  })

  it('takes every optional field', () => {
    const m = one({
      id: 'claude-opus-6',
      provider: 'claude',
      label: 'Opus 6',
      limits: { window: 2_000_000, maxOutput: 128_000 },
      prices: { input: 5, cacheWrite: 6, cacheRead: 0.5, output: 25 },
      effort: true,
      files: { images: true, pdf: true },
      search: 'claude-20260209',
      compaction: true,
      thinking: true,
      fallbacks: true
    })
    expect(m.effort).toEqual(profileOf('claude-opus-5-5')!.effort)
    expect(m.files).toEqual({ images: true, pdf: true, imageTokens: 'claude' })
    expect(m.prices).toEqual({ input: 5, cacheWrite: 6, cacheRead: 0.5, output: 25 })
  })

  it('requires id, provider, label and limits', () => {
    expect(why({ ...v5, id: undefined })).toMatch(/"id" is required/)
    expect(why({ ...v5, id: 'Upper-Case' })).toMatch(/lowercase/)
    expect(why({ ...v5, id: 'x'.repeat(81) })).toMatch(/up to 80/)
    expect(why({ ...v5, provider: 'qwen' })).toBe(
      '"provider" must be one of claude, openai, deepseek.'
    )
    expect(why({ ...v5, label: undefined })).toMatch(/"label" is required/)
    expect(why({ ...v5, label: ' ' })).toMatch(/"label" is required/)
    expect(why({ ...v5, label: 'x'.repeat(61) })).toMatch(/1 to 60/)
    expect(why({ ...v5, limits: undefined })).toMatch(/"limits" is required/)
    expect(why({ ...v5, limits: { window: 1_000_000 } })).toMatch(/limits.maxOutput/)
    expect(why('not an object')).toBe('Each model must be an object.')
  })

  it('rejects unknown fields anywhere, and live evidence', () => {
    expect(why({ ...v5, contextWindo: 5 })).toBe('Unknown field "contextWindo".')
    expect(why({ ...v5, apiKey: 'sk-1', baseURL: 'https://x' })).toBe(
      'Unknown fields "apiKey", "baseURL".'
    )
    expect(why({ ...v5, limits: { ...v5.limits, input: 1 } })).toMatch(/"input" in "limits"/)
    expect(why({ ...v5, files: { video: true } })).toMatch(/"video" in "files"/)
    expect(
      why({ ...v5, prices: { input: 1, cacheWrite: 1, cacheRead: 1, output: 1, batch: 1 } })
    ).toMatch(/"batch" in "prices"/)
    expect(why({ ...v5, live: ['vision'] })).toMatch(/"live" isn't allowed/)
  })

  it('checks the bounds', () => {
    const limits = (window: unknown, maxOutput: unknown): string | null =>
      why({ ...v5, limits: { window, maxOutput } })
    expect(limits(1_000, 1)).toBeNull()
    expect(limits(10_000_000, 10_000_000)).toBeNull()
    expect(limits(999, 1)).toMatch(/1,000 to 10,000,000/)
    expect(limits(10_000_001, 1)).toMatch(/1,000 to 10,000,000/)
    expect(limits(1_000.5, 1)).toMatch(/whole number/)
    expect(limits('1000000', 1)).toMatch(/whole number/)
    expect(limits(100_000, 100_001)).toMatch(/at most the window/)
    expect(limits(100_000, 0)).toMatch(/at most the window/)
    const price = (p: unknown): string | null => why({ ...v5, prices: p })
    const rates = { input: 1, cacheWrite: 1, cacheRead: 0.1, output: 2 }
    expect(price(rates)).toBeNull()
    expect(price(null)).toBeNull()
    expect(price({ ...rates, input: -1 })).toMatch(/"prices.input" .* 0 to 1,000/)
    expect(price({ ...rates, output: 1001 })).toMatch(/"prices.output"/)
    expect(price({ ...rates, cacheRead: '0.1' })).toMatch(/"prices.cacheRead"/)
    expect(price({ input: 1 })).toMatch(/"prices.cacheWrite"/)
    expect(price({ ...rates, long: { ...rates, over: 200_000 } })).toBeNull()
    expect(price({ ...rates, long: { ...rates, over: 2_000_000 } })).toMatch(/within the window/)
    expect(price({ ...rates, long: { over: 200_000 } })).toMatch(/"prices.long.input"/)
    expect(price('cheap')).toMatch(/must be an object/)
  })

  it('effort: the provider’s own levels, Custard’s five names only', () => {
    const ds = profileOf('deepseek-flash')!.effort!
    expect(one({ ...v5, effort: true }).effort).toEqual(ds)
    expect(one({ ...v5, effort: false }).effort).toBeNull()
    // Written out in full, the same levels load.
    const full = {
      levels: ds.levels.map(({ value, label, send }) => ({ value, label, send })),
      otherwise: 'high'
    }
    expect(one({ ...v5, effort: full }).effort).toEqual(ds)
    // `send` (or `value`) outside the five names.
    const none = {
      ...full,
      levels: [{ value: 'low', label: 'Fast', send: 'none' }, ...full.levels.slice(1)]
    }
    expect(why({ ...v5, effort: none })).toMatch(/Custard's five level names/)
    const minimal = {
      ...full,
      levels: [{ value: 'minimal', label: 'Fast' }, ...full.levels.slice(1)]
    }
    expect(why({ ...v5, effort: minimal })).toMatch(/Custard's five level names/)
    // `otherwise` not one of the levels.
    expect(why({ ...v5, effort: { ...full, otherwise: 'medium' } })).toMatch(/otherwise/)
    // Different levels from the provider's buttons.
    const relabelled = {
      ...full,
      levels: [{ ...full.levels[0], label: 'Quick' }, ...full.levels.slice(1)]
    }
    expect(why({ ...v5, effort: relabelled })).toMatch(/one set of effort buttons/)
    expect(why({ ...v5, effort: { levels: [], otherwise: 'low' } })).toMatch(/1 to 5 levels/)
    expect(why({ ...v5, effort: { ...full, extra: 1 } })).toMatch(/"extra" in "effort"/)
    expect(why({ ...v5, effort: 'max' })).toMatch(/true, false or an object/)
  })

  it('search, files, fallbacks and flags must fit the provider', () => {
    expect(why({ ...v5, search: 'responses' })).toBeNull()
    expect(why({ ...v5, search: 'claude-20260209' })).toMatch(/Responses API/)
    expect(why({ ...v5, provider: 'claude', id: 'c', search: 'responses' })).toMatch(/Messages API/)
    expect(why({ ...v5, search: true })).toMatch(/"search" must be false or one of responses/)
    expect(why({ ...v5, files: { imageTokens: 'claude' } })).toMatch(/patches/)
    expect(
      why({ ...v5, provider: 'claude', id: 'c', files: { imageTokens: 'claude-small' } })
    ).toBeNull()
    expect(why({ ...v5, files: { images: 'yes' } })).toMatch(/"files.images" must be true or false/)
    expect(why({ ...v5, fallbacks: true })).toBe('"fallbacks" is for Claude models only.')
    expect(why({ ...v5, provider: 'claude', id: 'c', fallbacks: true })).toBeNull()
    expect(why({ ...v5, compaction: 'on' })).toMatch(/"compaction" must be true or false/)
    expect(why({ ...v5, thinking: 1 })).toMatch(/"thinking" must be true or false/)
  })
})

describe('ids', () => {
  it('a duplicated id rejects every entry with it; others still load', () => {
    const r = parse([v5, { ...v5, label: 'Again' }, { ...v5, id: 'deepseek-v5-lite' }])
    expect(r.profiles.map((m) => m.id)).toEqual(['deepseek-v5-lite'])
    expect(r.report.rejected.map((x) => [x.index, x.id])).toEqual([
      [0, v5.id],
      [1, v5.id]
    ])
    expect(r.report.rejected[0].reason).toMatch(/more than once/)
  })

  it("another provider's built-in id is rejected", () => {
    expect(why({ ...v5, id: 'claude-opus-5-5' })).toBe(
      "claude-opus-5-5 is Claude's built-in model, so it can't be a DeepSeek model."
    )
  })

  it("the same provider's built-in id customises it: merged, then checked whole", () => {
    const m = one({
      id: 'claude-opus-5-5',
      provider: 'claude',
      limits: { maxOutput: 64_000 },
      prices: { input: 3 }
    })
    const opus = profileOf('claude-opus-5-5')!
    expect(m).toEqual({
      ...opus,
      limits: { window: 1_000_000, maxOutput: 64_000 },
      prices: { ...opus.prices!, input: 3 },
      origin: 'customised',
      changed: ['limits', 'prices']
    })
    // Same values: loaded as customised, with nothing changed.
    expect(one({ id: 'gpt-6-luna', provider: 'openai', label: 'GPT-6 Luna' }).changed).toEqual([])
    // A merge that breaks a rule rejects the entry; the built-in stays.
    const r = parse([{ id: 'claude-haiku-4-5', provider: 'claude', limits: { window: 50_000 } }])
    expect(r.report.rejected[0].reason).toMatch(/at most the window/)
    loadModelRegistry(() => r.profiles)
    expect(profileOf('claude-haiku-4-5')).toEqual(builtInProfiles[2])
    // Turning a built-in's search off, or its effort.
    expect(
      one({ id: 'gpt-6-astra', provider: 'openai', search: false, effort: false })
    ).toMatchObject({ search: false, effort: null, changed: ['effort', 'search'] })
  })
})

describe('Haiku 4.5 takes no effort', () => {
  // Anthropic's API rejects effort on Haiku 4.5, and summaries and
  // automation steps would send it (automation thinking, Phase 2).
  it('a customisation of Haiku 4.5 that gives it effort is rejected', () => {
    const reason =
      'Haiku 4.5 takes no effort level: Anthropic\'s API rejects one. Leave "effort" out.'
    expect(why({ id: 'claude-haiku-4-5', provider: 'claude', effort: true })).toBe(reason)
    expect(
      why({
        id: 'claude-haiku-4-5',
        provider: 'claude',
        effort: profileOf('claude-opus-5-5')!.effort
      })
    ).toBe(reason)
  })

  it('Haiku 4.5 without effort, other changes, and effort off still load', () => {
    expect(one({ id: 'claude-haiku-4-5', provider: 'claude', effort: false }).effort).toBeNull()
    expect(one({ id: 'claude-haiku-4-5', provider: 'claude', effort: null }).effort).toBeNull()
    expect(one({ id: 'claude-haiku-4-5', provider: 'claude', prices: { input: 2 } })).toMatchObject(
      { effort: null, changed: ['prices'] }
    )
  })

  it('other Claude models still take effort, by id only', () => {
    expect(one({ id: 'claude-sonnet-5-5', provider: 'claude', effort: true }).effort).toEqual(
      profileOf('claude-opus-5-5')!.effort
    )
    // A model added under another id is not known to be Haiku 4.5.
    expect(
      one({
        id: 'claude-haiku-4-5-alias',
        provider: 'claude',
        label: 'Haiku alias',
        limits: { window: 200_000, maxOutput: 64_000 },
        effort: true
      }).effort
    ).not.toBeNull()
  })
})

describe('Haiku 4.5 takes no thinking', () => {
  // Anthropic's API rejects adaptive thinking on Haiku 4.5, and chats,
  // summaries and automation steps would send it (automation thinking,
  // Phase 3).
  const reason =
    'Haiku 4.5 can\'t think the way Custard asks: Anthropic\'s API rejects adaptive thinking on it. Leave "thinking" out.'

  it('a customisation of Haiku 4.5 that turns thinking on is rejected', () => {
    expect(why({ id: 'claude-haiku-4-5', provider: 'claude', thinking: true })).toBe(reason)
    expect(
      why({ id: 'claude-haiku-4-5', provider: 'claude', thinking: true, label: 'Haiku (mine)' })
    ).toBe(reason)
  })

  it('Haiku 4.5 with thinking off or left out still loads', () => {
    expect(one({ id: 'claude-haiku-4-5', provider: 'claude', thinking: false }).thinking).toBe(
      false
    )
    expect(one({ id: 'claude-haiku-4-5', provider: 'claude', label: 'Cheap' })).toMatchObject({
      thinking: false,
      changed: ['label']
    })
  })

  it('other models keep thinking, and the rule goes by id and provider only', () => {
    expect(one({ id: 'claude-sonnet-5-5', provider: 'claude', thinking: true }).thinking).toBe(true)
    expect(
      one({
        id: 'claude-haiku-4-5-alias',
        provider: 'claude',
        label: 'Haiku alias',
        limits: { window: 200_000, maxOutput: 64_000 },
        thinking: true
      }).thinking
    ).toBe(true)
  })
})

describe('the registry with the file', () => {
  it('customised built-ins keep their place; added models follow', () => {
    const r = parse([
      v5,
      { id: 'claude-sonnet-5-5', provider: 'claude', label: 'Sonnet 5.5 (mine)' },
      { id: 'bad', provider: 'deepseek' }
    ])
    expect(r.report.loaded).toEqual([
      { id: v5.id, label: v5.label, provider: 'deepseek', origin: 'file' },
      {
        id: 'claude-sonnet-5-5',
        label: 'Sonnet 5.5 (mine)',
        provider: 'claude',
        origin: 'customised'
      }
    ])
    loadModelRegistry(() => r.profiles)
    expect(chatModels().map((m) => m.id)).toEqual([...builtInProfiles.map((m) => m.id), v5.id])
    expect(chatModels()[1].label).toBe('Sonnet 5.5 (mine)')
    expect(isChatModel(v5.id)).toBe(true)
    // Reload without the file: back to the built-ins, and the added model is gone.
    loadModelRegistry()
    expect(isChatModel(v5.id)).toBe(false)
    expect(chatModels()[1].label).toBe('Sonnet 5.5')
  })

  it('an added model has limits and a price, or is unpriced', () => {
    const priced = { ...v5, prices: { input: 2, cacheWrite: 2, cacheRead: 0.1, output: 8 } }
    loadModelRegistry(() => parse([priced, { ...v5, id: 'deepseek-free' }]).profiles)
    expect(limitsFor(v5.id)).toEqual({ window: 1_000_000, maxOutput: 384_000, compaction: false })
    expect(costOf(v5.id, usage)).toBe(10)
    expect(costOf('deepseek-free', usage)).toBeNull()
    expect(modelInfo('deepseek-free')).toMatchObject({ priced: false, contextWindow: 1_000_000 })
    // A dated id with no profile is still priced as its base, as before.
    expect(costOf('claude-opus-5-5-20261001', usage)).toBe(24)
  })

  it('capabilities from the file are docs, "From your models file"', () => {
    loadModelRegistry(
      () =>
        parse([
          { ...v5, files: { images: true } },
          { id: 'deepseek-flash', provider: 'deepseek', label: 'Flash (mine)' },
          { id: 'deepseek-v4-pro', provider: 'deepseek', files: { images: true } }
        ]).profiles
    )
    const added = capabilitiesOf(v5.id)
    expect(Object.values(added).every((c) => c.evidence === 'docs')).toBe(true)
    expect(added.vision).toEqual({
      supported: true,
      evidence: 'docs',
      note: 'From your models file.'
    })
    expect(added.web_search.note).toBe(
      'Reads pages it is given (web_read) but cannot search. From your models file.'
    )
    // A new label changes no capability: Flash keeps its live vision.
    const flash = capabilitiesOf('deepseek-flash')
    expect(flash.vision).toEqual({ supported: true, evidence: 'live' })
    expect(flash.json_schema.evidence).toBe('live')
    // Changing files: vision and PDFs come from the file; the rest doesn't.
    const pro = capabilitiesOf('deepseek-v4-pro')
    expect(pro.vision).toEqual({
      supported: true,
      evidence: 'docs',
      note: 'From your models file.'
    })
    expect(pro.pdf.note).toMatch(/From your models file\.$/)
    expect(pro.effort).toEqual({ supported: true, evidence: 'docs' })
  })

  it('a customised file change drops live evidence it covers', () => {
    loadModelRegistry(
      () =>
        parse([
          {
            id: 'deepseek-flash',
            provider: 'deepseek',
            files: { pdf: false, images: true, imageTokens: 'patches' },
            effort: false
          }
        ]).profiles
    )
    // Same files as before: live stays; effort changed: docs, from the file.
    expect(capabilitiesOf('deepseek-flash').vision.evidence).toBe('live')
    expect(capabilitiesOf('deepseek-flash').effort).toEqual({
      supported: false,
      evidence: 'docs',
      note: 'From your models file.'
    })
    loadModelRegistry(
      () =>
        parse([{ id: 'deepseek-flash', provider: 'deepseek', files: { images: false } }]).profiles
    )
    expect(capabilitiesOf('deepseek-flash').vision).toMatchObject({
      supported: false,
      evidence: 'docs'
    })
  })
})
