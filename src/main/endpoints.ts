// Where provider requests go. The SDKs read ANTHROPIC_BASE_URL and
// OPENAI_BASE_URL from the environment, which would send the stored keys,
// chats and vault notes to whatever those name. A packaged build pins the
// official endpoints; development and test builds (the e2e mock) may still
// point elsewhere through the environment.

let pinned = false

// Called once at startup with app.isPackaged.
export function pinProviderEndpoints(packaged: boolean): void {
  pinned = packaged
}

export const anthropicEndpoint = (): { baseURL?: string } =>
  pinned ? { baseURL: 'https://api.anthropic.com' } : {}

export const openaiEndpoint = (): { baseURL?: string } =>
  pinned ? { baseURL: 'https://api.openai.com/v1' } : {}
