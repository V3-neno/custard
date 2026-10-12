import type { Provider } from '../shared/providers'

// Where provider requests go. The SDKs read ANTHROPIC_BASE_URL and
// OPENAI_BASE_URL from the environment, which would send the stored keys,
// chats and vault notes to whatever those name. A packaged build pins the
// official endpoints; development and test builds (the e2e mock) may still
// point elsewhere through the environment.

const ENDPOINTS: Record<Provider, string> = {
  claude: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1'
}

let pinned = false

// Called once at startup with app.isPackaged.
export function pinProviderEndpoints(packaged: boolean): void {
  pinned = packaged
}

export const endpointFor = (provider: Provider): { baseURL?: string } =>
  pinned ? { baseURL: ENDPOINTS[provider] } : {}

export const anthropicEndpoint = (): { baseURL?: string } => endpointFor('claude')

export const openaiEndpoint = (): { baseURL?: string } => endpointFor('openai')
