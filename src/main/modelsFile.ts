import { existsSync, readFileSync, statSync } from 'fs'
import {
  builtInProfiles,
  efforts,
  type Effort,
  type EffortLevel,
  type EffortSpec,
  type HostedSearch,
  type ImageTokens,
  type ModelProfile,
  type ModelsFileReport
} from '../shared/models'
import type { Price } from '../shared/pricing'
import { providerIds, providerNames, providers, type Provider } from '../shared/providers'

// The user's models file: models.json in Custard's data folder (next to
// settings.json, never in the vault), read at startup and on Reload in
// Settings, never watched. It can add models for the built-in providers
// (Claude, OpenAI, DeepSeek) and change built-in ones. It can't add a
// provider, an address, a key or code: a model goes through its provider's
// own adapter, key and pinned address.
//
//   { "version": 1, "models": [ { "id": …, "provider": …, "label": …,
//     "limits": { "window": …, "maxOutput": … }, … } ] }
//
// A bad file loads no entries; a bad entry is skipped with its reason. An
// entry is used whole or not at all, and the built-in profiles never depend
// on the file.

export const MODELS_FILE = 'models.json'
const MAX_BYTES = 1_000_000
const MAX_MODELS = 200

const FIELDS = [
  'id',
  'provider',
  'label',
  'limits',
  'prices',
  'effort',
  'files',
  'search',
  'compaction',
  'thinking',
  'fallbacks'
] as const
const RATES = ['input', 'cacheWrite', 'cacheRead', 'output'] as const
const ID = /^[a-z0-9._:/-]{1,80}$/

type Raw = Record<string, unknown>
const isObject = (v: unknown): v is Raw => !!v && typeof v === 'object' && !Array.isArray(v)
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v)
const list = (xs: readonly string[]): string => xs.join(', ')

class Reject extends Error {}
const reject = (reason: string): never => {
  throw new Reject(reason)
}

// Only the keys a part may have; anything else (a typo, a key, an address)
// rejects the entry rather than being ignored.
function onlyKeys(o: Raw, allowed: readonly string[], where: string): void {
  const extra = Object.keys(o).filter((k) => !allowed.includes(k))
  if (extra.length)
    reject(
      `Unknown field${extra.length > 1 ? 's' : ''} ${list(extra.map((k) => `"${k}"`))}${where}.`
    )
}

// The Claude model whose profile may not take effort (see checkEntry).
const HAIKU_45 = 'claude-haiku-4-5'

const providerApi = (p: Provider): 'anthropic' | 'responses' => providers[p].api

// The effort levels a provider's built-in models take. The picker shows one
// set of effort buttons per provider, so every model of a provider that
// takes effort uses these.
const builtInEffort = (p: Provider): EffortSpec | null =>
  (builtInProfiles as readonly ModelProfile[]).find((m) => m.provider === p && m.effort)?.effort ??
  null

const sameLevels = (a: EffortSpec, b: EffortSpec): boolean =>
  a.otherwise === b.otherwise &&
  a.levels.length === b.levels.length &&
  a.levels.every(
    (l, i) =>
      l.value === b.levels[i].value && l.label === b.levels[i].label && l.send === b.levels[i].send
  )

function checkEffort(v: unknown, provider: Provider): EffortSpec | null {
  if (v === null || v === false) return null
  const own = builtInEffort(provider)
  const name = providerNames[provider]
  if (v === true) return own ?? reject(`${name}'s models take no effort levels.`)
  if (!isObject(v)) return reject('"effort" must be true, false or an object with levels.')
  onlyKeys(v, ['levels', 'otherwise'], ' in "effort"')
  if (!Array.isArray(v.levels) || !v.levels.length || v.levels.length > efforts.length)
    reject(`"effort.levels" must list 1 to ${efforts.length} levels.`)
  const levels = (v.levels as unknown[]).map((l, i): EffortLevel => {
    if (!isObject(l)) return reject(`Effort level ${i + 1} must be an object.`)
    onlyKeys(l, ['value', 'label', 'settingsLabel', 'send'], ` in effort level ${i + 1}`)
    const send = l.send ?? l.value
    if (!efforts.includes(l.value as Effort) || !efforts.includes(send as Effort))
      reject(
        `Effort level ${i + 1}: "value" and "send" must be one of Custard's five level names (${list(efforts)}). Other names can't be sent.`
      )
    if (typeof l.label !== 'string' || !l.label.trim() || l.label.length > 20)
      reject(`Effort level ${i + 1} needs a "label" of 1 to 20 characters.`)
    if (l.settingsLabel !== undefined && (typeof l.settingsLabel !== 'string' || !l.settingsLabel))
      reject(`Effort level ${i + 1}: "settingsLabel" must be text.`)
    const value = l.value as Effort
    return {
      value,
      label: (l.label as string).trim(),
      settingsLabel:
        (l.settingsLabel as string | undefined) ??
        own?.levels.find((x) => x.value === value)?.settingsLabel ??
        (l.label as string).trim(),
      send: send as Effort
    }
  })
  if (!levels.some((l) => l.value === v.otherwise))
    reject('"effort.otherwise" must be the value of one of its levels.')
  const spec: EffortSpec = { levels, otherwise: v.otherwise as Effort }
  if (!own || !sameLevels(spec, own))
    reject(
      own
        ? `${name}'s models share one set of effort buttons in the picker, so the levels must be ${name}'s own (${own.levels.map((l) => `${l.label}: ${l.send}`).join(', ')}; otherwise ${own.otherwise}). Use "effort": true for them.`
        : `${name}'s models take no effort levels.`
    )
  return spec
}

function checkRates(o: Raw, where: string): void {
  for (const r of RATES) {
    const x = o[r]
    if (typeof x !== 'number' || !Number.isFinite(x) || x < 0 || x > 1000)
      reject(`"${where}.${r}" must be a number of dollars per million tokens, 0 to 1,000.`)
  }
}

function checkPrices(v: unknown, base: Price | null, window: number): Price | null {
  if (v === null) return null
  if (!isObject(v)) return reject('"prices" must be an object, or null for unpriced.')
  onlyKeys(v, [...RATES, 'long'], ' in "prices"')
  const merged: Raw = { ...(base ?? {}), ...v }
  if (v.long === null) delete merged.long
  else if (v.long !== undefined) {
    if (!isObject(v.long)) reject('"prices.long" must be an object.')
    onlyKeys(v.long as Raw, [...RATES, 'over'], ' in "prices.long"')
    merged.long = { ...(base?.long ?? {}), ...(v.long as Raw) }
  }
  checkRates(merged, 'prices')
  if (merged.long !== undefined) {
    const long = merged.long as Raw
    checkRates(long, 'prices.long')
    if (!isInt(long.over) || long.over < 1 || long.over > window)
      reject('"prices.long.over" must be a whole number of input tokens within the window.')
  }
  return merged as Price
}

const imageRules = (p: Provider): ImageTokens[] =>
  providerApi(p) === 'anthropic' ? ['claude', 'claude-small'] : ['patches']
const searchTools = (p: Provider): Exclude<HostedSearch, false>[] =>
  providerApi(p) === 'anthropic' ? ['claude-20260209', 'claude-20250305'] : ['responses']

// What a new model has unless its entry says otherwise: unpriced, no effort,
// text only, and no search, compaction, thinking or fallbacks.
const defaults = (p: Provider): Omit<ModelProfile, 'id' | 'provider' | 'label' | 'limits'> => ({
  compaction: false,
  prices: null,
  thinking: false,
  effort: null,
  fallbacks: false,
  files: { images: false, pdf: false, imageTokens: imageRules(p)[0] },
  search: false
})

const bool = (v: unknown, name: string): boolean =>
  typeof v === 'boolean' ? v : reject(`"${name}" must be true or false.`)

// One entry, checked whole: over its built-in profile (a customisation) or
// over the defaults (a new model). Throws Reject with the first problem.
function checkEntry(raw: Raw, base: ModelProfile | null): ModelProfile {
  if ('live' in raw)
    reject('"live" isn\'t allowed: only tests Custard ran itself mark a capability live.')
  onlyKeys(raw, FIELDS, '')
  const id = raw.id as string
  const provider = raw.provider as Provider
  const start = base ?? { id, provider, label: '', limits: { window: 0, maxOutput: 0 } }
  const d = base ?? { ...start, ...defaults(provider) }

  let label = d.label
  if (raw.label !== undefined || !base) {
    if (typeof raw.label !== 'string' || !raw.label.trim() || raw.label.trim().length > 60)
      reject('"label" is required: the name shown in the picker, 1 to 60 characters.')
    label = (raw.label as string).trim()
  }

  let limits = d.limits
  if (raw.limits !== undefined || !base) {
    if (!isObject(raw.limits))
      reject('"limits" is required: { "window": tokens, "maxOutput": tokens }.')
    onlyKeys(raw.limits as Raw, ['window', 'maxOutput'], ' in "limits"')
    limits = { ...(base?.limits ?? {}), ...(raw.limits as Raw) } as ModelProfile['limits']
  }
  if (!isInt(limits.window) || limits.window < 1_000 || limits.window > 10_000_000)
    reject('"limits.window" must be a whole number of tokens from 1,000 to 10,000,000.')
  if (!isInt(limits.maxOutput) || limits.maxOutput < 1 || limits.maxOutput > limits.window)
    reject('"limits.maxOutput" must be a whole number of tokens, at most the window.')

  const prices =
    raw.prices !== undefined
      ? checkPrices(raw.prices, base?.prices ?? null, limits.window)
      : d.prices && checkPrices(d.prices, null, limits.window)

  const effort = raw.effort !== undefined ? checkEffort(raw.effort, provider) : d.effort
  // Haiku 4.5 takes no effort parameter (Anthropic's API rejects it), and a
  // summary or automation request would carry one. Known by its id: the
  // built-in, or a customisation of it. The same model under another id
  // can't be told apart.
  if (effort && provider === 'claude' && id === HAIKU_45)
    reject('Haiku 4.5 takes no effort level: Anthropic\'s API rejects one. Leave "effort" out.')

  let files = d.files
  if (raw.files !== undefined) {
    if (!isObject(raw.files)) reject('"files" must be an object.')
    onlyKeys(raw.files as Raw, ['images', 'pdf', 'imageTokens'], ' in "files"')
    files = { ...d.files, ...(raw.files as Raw) } as ModelProfile['files']
    bool(files.images, 'files.images')
    bool(files.pdf, 'files.pdf')
  }
  if (!imageRules(provider).includes(files.imageTokens))
    reject(`"files.imageTokens" must be one of ${list(imageRules(provider))} for this provider.`)

  const search = raw.search !== undefined ? (raw.search as HostedSearch) : d.search
  if (search !== false && !searchTools(provider).includes(search))
    reject(
      `"search" must be false or one of ${list(searchTools(provider))}: ${providerNames[provider]} uses the ${providerApi(provider) === 'anthropic' ? 'Messages' : 'Responses'} API.`
    )

  const compaction =
    raw.compaction !== undefined ? bool(raw.compaction, 'compaction') : d.compaction
  const thinking = raw.thinking !== undefined ? bool(raw.thinking, 'thinking') : d.thinking
  const fallbacks = raw.fallbacks !== undefined ? bool(raw.fallbacks, 'fallbacks') : d.fallbacks
  if (fallbacks && provider !== 'claude') reject('"fallbacks" is for Claude models only.')

  return {
    id,
    provider,
    label,
    limits: { window: limits.window, maxOutput: limits.maxOutput },
    compaction,
    prices,
    thinking,
    effort,
    fallbacks,
    files: { images: files.images, pdf: files.pdf, imageTokens: files.imageTokens },
    search,
    ...(base?.live ? { live: base.live } : {})
  }
}

const FACTS = [
  'label',
  'limits',
  'compaction',
  'prices',
  'thinking',
  'effort',
  'fallbacks',
  'files',
  'search'
] as const

// The models file's text (null: there is none) as profiles to add to the
// registry, and what Settings lists about it.
export function parseModelsFile(
  text: string | null,
  path: string,
  builtIns: readonly ModelProfile[] = builtInProfiles
): { profiles: ModelProfile[]; report: ModelsFileReport } {
  const report: ModelsFileReport = { path, status: 'missing', loaded: [], rejected: [] }
  const fail = (error: string): { profiles: ModelProfile[]; report: ModelsFileReport } => ({
    profiles: [],
    report: { ...report, status: 'error', error }
  })
  if (text === null) return { profiles: [], report }
  if (!text.trim()) return { profiles: [], report: { ...report, status: 'empty' } }
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch (err) {
    return fail(`It isn't valid JSON (${err instanceof Error ? err.message : String(err)}).`)
  }
  if (!isObject(body)) return fail('It must be an object: { "version": 1, "models": [ … ] }.')
  if (body.version !== 1)
    return fail(`Unknown version ${JSON.stringify(body.version)}: Custard reads version 1.`)
  const extra = Object.keys(body).filter((k) => k !== 'version' && k !== 'models')
  if (extra.length) return fail(`Unknown field ${list(extra.map((k) => `"${k}"`))} in the file.`)
  if (!Array.isArray(body.models)) return fail('"models" must be a list.')
  if (body.models.length > MAX_MODELS) return fail(`At most ${MAX_MODELS} models.`)

  const entries = body.models as unknown[]
  const idOf = (e: unknown): string | undefined =>
    isObject(e) && typeof e.id === 'string' ? e.id : undefined
  const counts = new Map<string, number>()
  for (const e of entries) {
    const id = idOf(e)
    if (id !== undefined) counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  const profiles: ModelProfile[] = []
  entries.forEach((raw, index) => {
    const id = idOf(raw)
    try {
      if (!isObject(raw)) reject('Each model must be an object.')
      const e = raw as Raw
      if (typeof e.id !== 'string' || !ID.test(e.id))
        reject('"id" is required: up to 80 characters of lowercase letters, digits and . _ : / -')
      if ((counts.get(e.id as string) ?? 0) > 1)
        reject('This id is in the file more than once, so none of its entries is used.')
      if (!providerIds.includes(e.provider as Provider))
        reject(`"provider" must be one of ${list(providerIds)}.`)
      const built = builtIns.find((m) => m.id === e.id)
      if (built && built.provider !== e.provider)
        reject(
          `${e.id} is ${providerNames[built.provider]}'s built-in model, so it can't be a ${providerNames[e.provider as Provider]} model.`
        )
      const profile = checkEntry(e, built ?? null)
      if (built) {
        const changed = FACTS.filter(
          (f) => JSON.stringify(profile[f]) !== JSON.stringify(built[f])
        ) as string[]
        profiles.push({ ...profile, origin: 'customised', changed })
      } else profiles.push({ ...profile, origin: 'file' })
      report.loaded.push({
        id: profile.id,
        label: profile.label,
        provider: profile.provider,
        origin: built ? 'customised' : 'file'
      })
    } catch (err) {
      // Anything unexpected skips the entry too, rather than the whole file.
      const reason =
        err instanceof Reject ? err.message : "It couldn't be checked, so it isn't used."
      report.rejected.push({ index, ...(id !== undefined ? { id } : {}), reason })
    }
  })
  return { profiles, report: { ...report, status: 'ok' } }
}

// Reads the file. A file that can't be read, or is too large, loads nothing.
export function readModelsFile(path: string): {
  profiles: ModelProfile[]
  report: ModelsFileReport
} {
  if (!existsSync(path)) return parseModelsFile(null, path)
  try {
    if (statSync(path).size > MAX_BYTES)
      return {
        profiles: [],
        report: {
          path,
          status: 'error',
          error: 'It is larger than 1 MB.',
          loaded: [],
          rejected: []
        }
      }
    return parseModelsFile(readFileSync(path, 'utf8'), path)
  } catch (err) {
    return {
      profiles: [],
      report: {
        path,
        status: 'error',
        error: `It couldn't be read (${err instanceof Error ? err.message : String(err)}).`,
        loaded: [],
        rejected: []
      }
    }
  }
}
