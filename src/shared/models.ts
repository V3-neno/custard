import type { Capability } from './adapter'
import type { Price } from './pricing'
import type { Provider } from './providers'

// One profile per model Custard offers: every fixed fact about the model in
// one place. Facts about a provider (its API, key, address, Responses flags,
// summary model) stay in providers.ts. The built-in profiles are below; the
// list Custard offers at run time is the registry at the end of this file,
// which main fills and the renderer copies (see main/modelRegistry.ts). The
// old per-model tables are views of the profiles: chatModels() (chat.ts),
// CONTEXT_LIMITS (main/context.ts) and PRICES (pricing.ts). Adding a model of
// an existing provider is one entry here.

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export const efforts: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

// The effort levels a model takes, as data. Each level is a button in the
// model picker (`label`), an option in Settings → Default model
// (`settingsLabel`), the value stored on the chat (`value`) and what goes
// in the request (`send`). A stored level the model doesn't list shows and
// sends as `otherwise`.
export type EffortLevel = { value: Effort; label: string; settingsLabel: string; send: Effort }
export type EffortSpec = { levels: EffortLevel[]; otherwise: Effort }

// How an image (or a PDF page's image) is counted before sending: Claude's
// long-edge tiers (2,576 px / 4,784 tokens, or 1,568 / 1,568 for models
// before the 4.7 generation), or OpenAI's 32-pixel patches.
export type ImageTokens = 'claude' | 'claude-small' | 'patches'

// The hosted search a model gets for web_search: Claude's tool by version
// (dynamic filtering, 20260209, needs Claude 4.6 or later), a Responses
// provider's web_search tool, or none.
export type HostedSearch = 'claude-20260209' | 'claude-20250305' | 'responses' | false

export type ModelProfile = {
  id: string
  provider: Provider
  label: string
  // Input and output together, and the most one reply may hold, in tokens.
  limits: { window: number; maxOutput: number }
  // Server-side compaction (see main/compaction).
  compaction: boolean
  // Dollars per million tokens; null: the meter counts its calls as
  // unpriced.
  prices: Price | null
  // Claude: adaptive thinking is turned on. A Responses model always
  // reasons; Custard sends nothing to turn it on.
  thinking: boolean
  // null: no effort is sent and the picker greys its buttons out.
  effort: EffortSpec | null
  // Claude's server-side fallback on a decline.
  fallbacks: boolean
  // Whether the model takes images and PDFs at all. Why not, in words, is
  // the provider's (main/attachments/request.ts).
  files: { images: boolean; pdf: boolean; imageTokens: ImageTokens }
  search: HostedSearch
  // Seen working in a live test, rather than only documented (Settings →
  // Capabilities marks these `live`). Only tests recorded on a known model;
  // never from the models file.
  live?: Capability[]
  // Where the profile came from: absent for a built-in one; `file` for a
  // model the user's models file adds; `customised` for a built-in one the
  // file changes, with the fields whose values it changed (main/modelsFile).
  origin?: 'file' | 'customised'
  changed?: string[]
}

export const EFFORT_LABELS: Record<Effort, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'X-High',
  max: 'Max'
}

// Claude and OpenAI: every level, sent as it is.
const ALL_LEVELS: EffortSpec = {
  levels: efforts.map((e) => ({
    value: e,
    label: EFFORT_LABELS[e],
    settingsLabel: `${e} effort`,
    send: e
  })),
  otherwise: 'medium'
}

// DeepSeek's effort levels as its model list names them, shown as three
// buttons. Each is stored and sent as the value DeepSeek's Create Response
// docs list for reasoning.effort (Neno's call, 2026-10-13): Fast sends low,
// Balanced high, Thorough max. The names themselves are never sent.
// Balanced stands in for any other level (medium and xhigh are DeepSeek
// aliases of high anyway).
const DEEPSEEK_LEVELS: EffortSpec = {
  levels: [
    { value: 'low', label: 'Fast', settingsLabel: 'Fast', send: 'low' },
    { value: 'high', label: 'Balanced', settingsLabel: 'Balanced', send: 'high' },
    { value: 'max', label: 'Thorough', settingsLabel: 'Thorough', send: 'max' }
  ],
  otherwise: 'high'
}

// Limits checked against the providers' docs on 2026-10-07 (see
// docs/long-chats.md), prices on 2026-10-12 (sources at the top of
// pricing.ts). Neither is looked up at run time. In picker order.
export const builtInProfiles = [
  // Claude: the full 1M context at standard rates; cache reads at 0.05x on
  // Opus 5.5 and Sonnet 5.5, 0.1x on Haiku 4.5.
  {
    id: 'claude-opus-5-5',
    provider: 'claude',
    label: 'Opus 5.5',
    limits: { window: 1_000_000, maxOutput: 128_000 },
    compaction: true,
    prices: { input: 4, cacheWrite: 5, cacheRead: 0.2, output: 20 },
    thinking: true,
    effort: ALL_LEVELS,
    fallbacks: true,
    files: { images: true, pdf: true, imageTokens: 'claude' },
    search: 'claude-20260209'
  },
  {
    id: 'claude-sonnet-5-5',
    provider: 'claude',
    label: 'Sonnet 5.5',
    limits: { window: 1_000_000, maxOutput: 128_000 },
    compaction: true,
    prices: { input: 2, cacheWrite: 2.5, cacheRead: 0.1, output: 10 },
    thinking: true,
    effort: ALL_LEVELS,
    fallbacks: true,
    files: { images: true, pdf: true, imageTokens: 'claude' },
    search: 'claude-20260209'
  },
  // No effort (so no thinking), no compaction, no fallbacks, the basic
  // search tool and the smaller image tier.
  {
    id: 'claude-haiku-4-5',
    provider: 'claude',
    label: 'Haiku 4.5',
    limits: { window: 200_000, maxOutput: 64_000 },
    compaction: false,
    prices: { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 },
    thinking: false,
    effort: null,
    fallbacks: false,
    files: { images: true, pdf: true, imageTokens: 'claude-small' },
    search: 'claude-20250305'
  },
  // OpenAI: no cache-write charge. The pricing page gives long-context rates
  // without a threshold; openai.com says the standard rates are "for context
  // lengths under 270K", so 270,000 input tokens is used.
  {
    id: 'gpt-6-astra',
    provider: 'openai',
    label: 'GPT-6 Astra',
    limits: { window: 1_050_000, maxOutput: 128_000 },
    compaction: true,
    prices: {
      input: 10,
      cacheWrite: 10,
      cacheRead: 1,
      output: 50,
      long: { over: 270_000, input: 20, cacheWrite: 20, cacheRead: 2, output: 75 }
    },
    thinking: true,
    effort: ALL_LEVELS,
    fallbacks: false,
    files: { images: true, pdf: true, imageTokens: 'patches' },
    search: 'responses'
  },
  {
    id: 'gpt-6.1-sol',
    provider: 'openai',
    label: 'GPT-6.1 Sol',
    limits: { window: 1_050_000, maxOutput: 128_000 },
    compaction: true,
    prices: {
      input: 2,
      cacheWrite: 2,
      cacheRead: 0.1,
      output: 10,
      long: { over: 270_000, input: 4, cacheWrite: 4, cacheRead: 0.2, output: 15 }
    },
    thinking: true,
    effort: ALL_LEVELS,
    fallbacks: false,
    files: { images: true, pdf: true, imageTokens: 'patches' },
    search: 'responses'
  },
  {
    id: 'gpt-6-luna',
    provider: 'openai',
    label: 'GPT-6 Luna',
    limits: { window: 1_050_000, maxOutput: 128_000 },
    compaction: true,
    prices: {
      input: 0.1,
      cacheWrite: 0.1,
      cacheRead: 0.01,
      output: 0.5,
      long: { over: 270_000, input: 0.2, cacheWrite: 0.2, cacheRead: 0.02, output: 0.75 }
    },
    thinking: true,
    effort: ALL_LEVELS,
    fallbacks: false,
    files: { images: true, pdf: true, imageTokens: 'patches' },
    search: 'responses'
  },
  // DeepSeek: 1M context, up to 384K output, no compaction, no hosted
  // search, no PDFs ("File inputs are not supported"), images on Flash
  // only. No image token rule is documented: OpenAI's is used as a guess.
  // No cache-write charge. Always the peak rates; off-peak hours (outside
  // 01:00-04:00 and 06:00-10:00 UTC on weekdays, and all of China's public
  // holidays) cost half, so the estimate may be high.
  {
    id: 'deepseek-v4-pro',
    provider: 'deepseek',
    label: 'DeepSeek V4 Pro',
    limits: { window: 1_000_000, maxOutput: 384_000 },
    compaction: false,
    prices: { input: 1.32, cacheWrite: 1.32, cacheRead: 0.044, output: 3.96 },
    thinking: true,
    effort: DEEPSEEK_LEVELS,
    fallbacks: false,
    files: { images: false, pdf: false, imageTokens: 'patches' },
    search: false
  },
  // Live by Neno on 2026-10-13: an image read, and a chat note written
  // (Flash is the summary model for every DeepSeek chat). Which model ran
  // the tool-call chat wasn't recorded, so text and tools stay docs.
  {
    id: 'deepseek-flash',
    provider: 'deepseek',
    label: 'DeepSeek Flash',
    limits: { window: 1_000_000, maxOutput: 384_000 },
    compaction: false,
    prices: { input: 0.3, cacheWrite: 0.3, cacheRead: 0.006, output: 1.2 },
    thinking: true,
    effort: DEEPSEEK_LEVELS,
    fallbacks: false,
    files: { images: true, pdf: false, imageTokens: 'patches' },
    search: false,
    live: ['vision', 'json_schema']
  }
] as const satisfies readonly ModelProfile[]

// What Settings lists about the user's models file (main/modelsFile.ts).
//   missing: there is no file; empty: it has nothing in it; ok: it was read
//   (each entry loaded or rejected); error: it couldn't be used at all, so
//   no entry from it is loaded.
export type ModelsFileReport = {
  path: string
  status: 'missing' | 'empty' | 'ok' | 'error'
  error?: string
  loaded: { id: string; label: string; provider: Provider; origin: 'file' | 'customised' }[]
  rejected: { index: number; id?: string; reason: string }[]
}

export type BuiltInModelId = (typeof builtInProfiles)[number]['id']

// The registry: the profiles Custard offers now, in picker order. Main owns
// it (main/modelRegistry.ts builds it at startup; today that is the built-in
// profiles) and the renderer replaces its copy with main's list over IPC
// (models:profiles) before it draws anything. A model id with no profile here
// is never sent anywhere: the chat shows "its profile is missing" instead.
let registry: readonly ModelProfile[] = builtInProfiles

export const allProfiles = (): readonly ModelProfile[] => registry

// Replaces the registry. Main calls it once at startup, the renderer with
// main's list.
export function setProfiles(list: readonly ModelProfile[]): void {
  registry = list
}

// The profile of a model id, or undefined for one Custard has no profile for.
export const profileOf = (id: string): ModelProfile | undefined => registry.find((m) => m.id === id)

export const hasProfile = (id: unknown): id is string =>
  typeof id === 'string' && profileOf(id) !== undefined

// Thrown where a model id with no profile reaches code that would otherwise
// have to guess (a request, its provider, its effort).
export class NoProfileError extends Error {
  constructor(readonly model: string) {
    super(noProfileMessage(model))
    this.name = 'NoProfileError'
  }
}

// What the user is told when a chat or automation names such a model.
export const noProfileMessage = (model: string): string =>
  `${model} can't be used right now: its profile is missing. Pick a different model.`

// The profile of a model id, or a NoProfileError.
export function requireProfile(id: string): ModelProfile {
  const p = profileOf(id)
  if (!p) throw new NoProfileError(id)
  return p
}

// A provider's effort levels, for what the picker shows on that provider's
// tab: the first of its models that takes effort (a provider's models share
// their levels; a test checks it).
export const providerEffort = (provider: Provider): EffortSpec | null =>
  registry.find((m) => m.provider === provider && m.effort)?.effort ?? null

// The level a stored effort shows as under these levels.
export const shownLevel = (spec: EffortSpec | null, e: Effort): Effort =>
  !spec || spec.levels.some((l) => l.value === e) ? e : spec.otherwise

// What a request carries for a stored effort under these levels.
export const sentLevel = (spec: EffortSpec, e: Effort): Effort => {
  const shown = shownLevel(spec, e)
  return spec.levels.find((l) => l.value === shown)?.send ?? shown
}

// Whether a model gets web_search (Settings → Capabilities reads the same).
export const hasHostedSearch = (id: string): boolean => (profileOf(id)?.search ?? false) !== false
