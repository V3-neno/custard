import type { ListedModel } from '../../shared/adapter'
import { requireProfile } from '../../shared/models'
import { providerIds, type Provider } from '../../shared/providers'
import { anthropicAdapter } from './anthropic'
import { responsesAdapter } from './responses'
import type { ProviderAdapter } from './types'

// One adapter per provider in shared/providers.ts. TypeScript makes a new
// provider entry add one here.
const adapters: Record<Provider, ProviderAdapter> = {
  claude: anthropicAdapter,
  openai: responsesAdapter('openai'),
  deepseek: responsesAdapter('deepseek')
}

export const adapterFor = (provider: Provider): ProviderAdapter => adapters[provider]

// A model with no profile has no provider: it fails loudly (NoProfileError)
// rather than going to Claude.
export const adapterForModel = (model: string): ProviderAdapter =>
  adapters[requireProfile(model).provider]

// Every provider's models, in picker order (see shared/providers.ts).
// Not checked against any provider: no key is sent.
export const allModels = async (): Promise<ListedModel[]> =>
  (await Promise.all(providerIds.map((p) => adapters[p].listModels(null)))).flatMap((l) => l.models)
