import OpenAI from 'openai'
import type { Provider } from '../shared/providers'
import { endpointFor } from './endpoints'

// The main-process side of each provider (see shared/providers.ts): the file
// its key is kept in, under userData.
export const KEY_FILES: Record<Provider, string> = {
  claude: 'api-key.bin',
  openai: 'openai-key.bin'
}

// A client for a Responses API provider, sent to its pinned endpoint in a
// packaged build (see endpoints.ts).
export const responsesClient = (
  provider: Provider,
  apiKey: string,
  opts: { timeout?: number; maxRetries?: number } = {}
): OpenAI => new OpenAI({ apiKey, ...opts, ...endpointFor(provider) })
