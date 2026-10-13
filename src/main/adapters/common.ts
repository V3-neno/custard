import type { Provider } from '../../shared/providers'
import { chatModels } from '../../shared/chat'
import { toProviderError } from '../providerError'
import { providerNames } from '../../shared/providers'
import { modelInfo } from './capabilities'
import type { AuthResult, ModelListing } from './types'

// The models Custard has a profile for, for one provider, in picker order.
// Not checked against the provider (Phase 3 adds that).
export const knownModels = (provider: Provider): ModelListing['models'] =>
  chatModels
    .filter((m) => m.provider === provider)
    .map((m) => ({ ...modelInfo(m.id)!, available: 'unchecked' as const }))

// A key check: the provider's model list, the cheapest call each offers.
// Only ever run when the user saves a key or presses Refresh.
export async function authenticateWith(
  provider: Provider,
  call: () => Promise<unknown>
): Promise<AuthResult> {
  try {
    await call()
    return { ok: true }
  } catch (err) {
    const e = toProviderError(err, providerNames[provider])
    return { ok: false, kind: e.kind, message: e.message }
  }
}
