// The providers Custard can talk to. Each one speaks one of two APIs:
// Anthropic's Messages API, or OpenAI's Responses API (which other providers
// also offer). Code that differs by API branches on `api`; what a
// Responses provider leaves out is listed in `responses`, so a request never
// asks for a feature the provider would ignore. Adding a provider is a new
// entry here, its key file and endpoint in main/providers.ts, and its models'
// profiles in models.ts.

export type ProviderApi = 'anthropic' | 'responses'

// What a Responses API provider supports beyond plain chat and function
// tools. OpenAI supports all of it. Hosted web search is a model fact, in
// each model's profile (shared/models.ts).
export type ResponsesFeatures = {
  // Reasoning summaries (reasoning.summary), shown as the model's thinking.
  reasoningSummary: boolean
  // Encrypted reasoning passed back between tool calls
  // (include: reasoning.encrypted_content).
  encryptedReasoning: boolean
  // The input-token counting endpoint (responses.inputTokens.count).
  tokenCount: boolean
  // prompt_cache_key: requests with the same key are routed to the same
  // prompt cache, so a chat's repeated prefix is read from it more often.
  promptCacheKey: boolean
}

export type ProviderInfo = {
  name: string
  api: ProviderApi
  // How a model of this provider is introduced in its instructions, after
  // its label: "GPT-6 Astra, an OpenAI model". Claude is just "Claude".
  maker: string | null
  // The cheap model background summaries use (captures, chat notes,
  // Continue in a new chat).
  summaryModel: string
  // For the key field in Settings.
  keyPlaceholder: string
  keyWhere: string
  // Whether Settings lists the models this provider offers that Custard has
  // no profile for (as "not yet supported", never pickable). Off for Claude
  // and OpenAI, whose lists stay fixed: their live list only marks which of
  // Custard's models the key can use.
  discoverModels: boolean
  // Shown under the provider's Available models in Settings: what its model
  // list says about effort that Custard doesn't use.
  effortNote?: string
  responses?: ResponsesFeatures
}

export const providers = {
  claude: {
    name: 'Claude',
    api: 'anthropic',
    maker: null,
    summaryModel: 'claude-haiku-4-5',
    keyPlaceholder: 'sk-ant-…',
    keyWhere: 'console.anthropic.com',
    discoverModels: false
  },
  openai: {
    name: 'OpenAI',
    api: 'responses',
    maker: 'an OpenAI model',
    summaryModel: 'gpt-6-luna',
    keyPlaceholder: 'sk-…',
    keyWhere: 'platform.openai.com',
    discoverModels: false,
    responses: {
      reasoningSummary: true,
      encryptedReasoning: true,
      tokenCount: true,
      promptCacheKey: true
    }
  },
  // DeepSeek's Responses API (api-docs.deepseek.com, checked 2026-10-12):
  // stateless, function tools only, no hosted web search, no token counting,
  // no reasoning summaries or encrypted reasoning (its reasoning streams as
  // plain reasoning_text), and unsupported fields are silently ignored.
  deepseek: {
    name: 'DeepSeek',
    api: 'responses',
    maker: 'a DeepSeek model',
    summaryModel: 'deepseek-flash',
    keyPlaceholder: 'sk-…',
    keyWhere: 'platform.deepseek.com',
    discoverModels: true,
    effortNote:
      "DeepSeek's model list also names effort levels (fast, balanced, thorough). Custard doesn't read them yet: the picker's Fast, Balanced and Thorough send low, high and max, the values DeepSeek documents for its Responses API.",
    responses: {
      reasoningSummary: false,
      encryptedReasoning: false,
      tokenCount: false,
      promptCacheKey: false
    }
  }
} as const satisfies Record<string, ProviderInfo>

export type Provider = keyof typeof providers

// In the order the model picker and Settings list them.
export const providerIds = Object.keys(providers) as Provider[]

export const isProvider = (p: unknown): p is Provider =>
  typeof p === 'string' && Object.hasOwn(providers, p)

export const providerInfo = (p: Provider): ProviderInfo => providers[p]

// What a Responses provider supports; all off for an Anthropic one.
export const responsesFeatures = (p: Provider): ResponsesFeatures =>
  providerInfo(p).responses ?? {
    reasoningSummary: false,
    encryptedReasoning: false,
    tokenCount: false,
    promptCacheKey: false
  }

export const providerNames = Object.fromEntries(
  providerIds.map((p) => [p, providers[p].name])
) as Record<Provider, string>
