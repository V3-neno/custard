import type { Provider } from '../shared/providers'

// Where provider requests go. The SDKs read ANTHROPIC_BASE_URL and
// OPENAI_BASE_URL from the environment, which would send the stored keys,
// chats and vault notes to whatever those name. A packaged build pins the
// official endpoints; development and test builds (the e2e mock) may still
// point elsewhere through the environment.
//
// A provider reached with the OpenAI SDK but not OpenAI itself always gets
// its own address: left to the SDK, a development build would send its key
// to OPENAI_BASE_URL or to OpenAI. Its own variable (`env`) may move it in
// development and test builds.

const ENDPOINTS: Record<Provider, { url: string; env?: string }> = {
  claude: { url: 'https://api.anthropic.com' },
  openai: { url: 'https://api.openai.com/v1' },
  deepseek: { url: 'https://api.deepseek.com', env: 'DEEPSEEK_BASE_URL' }
}

let pinned = false

// Called once at startup with app.isPackaged.
export function pinProviderEndpoints(packaged: boolean): void {
  pinned = packaged
}

export const endpointFor = (provider: Provider): { baseURL?: string } => {
  const e = ENDPOINTS[provider]
  if (pinned) return { baseURL: e.url }
  if (!e.env) return {}
  return { baseURL: process.env[e.env] || e.url }
}

export const anthropicEndpoint = (): { baseURL?: string } => endpointFor('claude')

export const openaiEndpoint = (): { baseURL?: string } => endpointFor('openai')
