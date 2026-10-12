// The providers Custard can talk to. Each one speaks one of two APIs:
// Anthropic's Messages API, or OpenAI's Responses API (which other providers
// also offer). Code that differs by API branches on `api`; what a
// Responses provider leaves out is listed in `responses`, so a request never
// asks for a feature the provider would ignore. Adding a provider is a new
// entry here, its key file and endpoint in main/providers.ts, its models in
// chat.ts, its prices in pricing.ts and its context limits in context.ts.

export type ProviderApi = 'anthropic' | 'responses'

// What a Responses API provider supports beyond plain chat and function
// tools. OpenAI supports all of it.
export type ResponsesFeatures = {
  // Reasoning summaries (reasoning.summary), shown as the model's thinking.
  reasoningSummary: boolean
  // Encrypted reasoning passed back between tool calls
  // (include: reasoning.encrypted_content).
  encryptedReasoning: boolean
  // The input-token counting endpoint (responses.inputTokens.count).
  tokenCount: boolean
  // Hosted web search (the web_search tool).
  webSearch: boolean
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
  responses?: ResponsesFeatures
}

export const providers = {
  claude: {
    name: 'Claude',
    api: 'anthropic',
    maker: null,
    summaryModel: 'claude-haiku-4-5',
    keyPlaceholder: 'sk-ant-…',
    keyWhere: 'console.anthropic.com'
  },
  openai: {
    name: 'OpenAI',
    api: 'responses',
    maker: 'an OpenAI model',
    summaryModel: 'gpt-6-luna',
    keyPlaceholder: 'sk-…',
    keyWhere: 'platform.openai.com',
    responses: {
      reasoningSummary: true,
      encryptedReasoning: true,
      tokenCount: true,
      webSearch: true
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
    webSearch: false
  }

export const providerNames = Object.fromEntries(
  providerIds.map((p) => [p, providers[p].name])
) as Record<Provider, string>
