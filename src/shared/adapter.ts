import type { Provider, ProviderApi } from './providers'

// The shapes every provider adapter shares (see main/adapters). Kept here so
// Settings and the model picker can show them; nothing in this file talks to
// a provider.

// What a model can do, as Custard uses it. `function_calling` and
// `tool_use` are one thing here: Custard sends function tools the same way to
// every provider.
export const capabilities = [
  'text',
  'streaming',
  'tool_use',
  'json_schema',
  'vision',
  'pdf',
  'reasoning',
  'reasoning_summary',
  'effort',
  'web_search',
  'prompt_caching',
  'compaction',
  'token_counting',
  'fallbacks'
] as const

export type Capability = (typeof capabilities)[number]

export const capabilityLabels: Record<Capability, string> = {
  text: 'Text chat',
  streaming: 'Streamed replies',
  tool_use: 'Tools (vault, plugins, web)',
  json_schema: 'Structured output',
  vision: 'Images in',
  pdf: 'PDFs in',
  reasoning: 'Thinking',
  reasoning_summary: 'Visible thinking',
  effort: 'Effort levels',
  web_search: 'Web search',
  prompt_caching: 'Prompt caching',
  compaction: 'Compaction of long chats',
  token_counting: 'Exact token counts',
  fallbacks: 'Fallback on decline'
}

// How Custard knows: from the provider's documentation and Custard's own
// rules, or seen working in a live test.
export type Evidence = 'docs' | 'live'

export type CapabilityEntry = {
  supported: boolean
  evidence: Evidence
  // Anything a yes or no leaves out ("Flash only", "provider-side").
  note?: string
}

export type ModelCapabilities = Record<Capability, CapabilityEntry>

// A model as an adapter describes it.
//   profile: Custard knows it (prices, context size, file rules).
//   discovered: the provider lists it but Custard has no profile for it.
export type ModelInfo = {
  id: string
  label: string
  provider: Provider
  api: ProviderApi
  description?: string
  contextWindow: number
  maxOutput: number
  // Whether the cost meter has prices for it.
  priced: boolean
  capabilities: ModelCapabilities
  source: 'profile' | 'discovered'
}

// A model as the picker gets it from an adapter: whether the key can use
// it, or 'unchecked' when nobody asked the provider.
export type ListedModel = ModelInfo & { available: boolean | 'unchecked' }

// Why a provider call failed, whatever the SDK. The message for the user is
// built from the kind (see main/providerError).
export const providerErrorKinds = [
  // The key was rejected (401).
  'auth',
  // The key is valid but may not use this (403).
  'permission',
  'rate_limit',
  'timeout',
  // The provider couldn't be reached at all.
  'network',
  // 503 / 529.
  'overloaded',
  // The model doesn't exist or this key can't see it (404).
  'model_not_found',
  // The request is more than the model can take in.
  'too_long',
  // Asked for something the provider or model doesn't do.
  'unsupported',
  // Any other 4xx.
  'bad_request',
  // Any other 5xx.
  'server',
  // The provider answered, but not in the documented shape (a model list
  // that isn't one, say).
  'bad_response',
  // Stopped by the user.
  'aborted',
  'unknown'
] as const

export type ProviderErrorKind = (typeof providerErrorKinds)[number]

// The last key check for a provider (Settings → Save or Refresh), as
// Settings shows it. Holds no key.
export type ModelCheck = {
  checkedAt: number
  // ok: the key works and the list came back. 'auth': the provider rejected
  // the key. Anything else: it couldn't be checked, and the saved key was
  // left as it is.
  result: 'ok' | ProviderErrorKind
  // The plain-language reason when it isn't ok.
  message?: string
  // From a successful check: Custard's models, each usable with this key or
  // not, then (DeepSeek) the ones Custard doesn't support yet.
  models: { id: string; label: string; available: boolean; source: 'profile' | 'discovered' }[]
}
