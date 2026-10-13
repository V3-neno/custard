import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { ModelCheck } from '../../shared/adapter'
import { chatModels, type ModelAvailability } from '../../shared/chat'
import { isProvider, providerNames, type Provider } from '../../shared/providers'
import { getApiKey } from '../apiKey'
import { toProviderError } from '../providerError'
import { adapterFor } from './registry'

// Key checks from Settings. The only code that asks a provider for its model
// list, and it runs only when the user saves a key or presses Refresh
// (Neno's call, 2026-10-13): never at startup, never in the background.
// The result is kept in userData/model-checks.json so "last checked" survives
// a restart; it holds model ids and the outcome, never a key.

const file = (): string => join(app.getPath('userData'), 'model-checks.json')

function readAll(): Partial<Record<Provider, ModelCheck>> {
  try {
    if (!existsSync(file())) return {}
    const all = JSON.parse(readFileSync(file(), 'utf8')) as Record<string, ModelCheck>
    return Object.fromEntries(
      Object.entries(all).filter(([p, c]) => isProvider(p) && c && typeof c.checkedAt === 'number')
    )
  } catch {
    return {}
  }
}

function write(provider: Provider, check: ModelCheck | null): void {
  const all = readAll()
  if (check) all[provider] = check
  else delete all[provider]
  writeFileSync(file(), JSON.stringify(all, null, 1))
}

export const lastCheck = (provider: Provider): ModelCheck | null => readAll()[provider] ?? null

// Removing a key removes what was learned with it.
export const forgetCheck = (provider: Provider): void => write(provider, null)

const running = new Map<Provider, Promise<ModelCheck | null>>()

// Checks the saved key by listing the provider's models: one request, to the
// provider's pinned address, with that provider's key only. A failure never
// changes or removes the saved key. Null when there is no key.
export function checkProvider(provider: Provider): Promise<ModelCheck | null> {
  if (!isProvider(provider)) throw new Error('Unknown provider')
  const busy = running.get(provider)
  if (busy) return busy
  const job = (async (): Promise<ModelCheck | null> => {
    const key = getApiKey(provider)
    if (!key) return null
    let check: ModelCheck
    try {
      const listing = await adapterFor(provider).listModels(key)
      check = {
        checkedAt: listing.checkedAt ?? Date.now(),
        result: 'ok',
        models: listing.models.map((m) => ({
          id: m.id,
          label: m.label,
          available: m.available === true,
          source: m.source
        }))
      }
    } catch (err) {
      const e = toProviderError(err, providerNames[provider], key)
      check = { checkedAt: Date.now(), result: e.kind, message: e.message, models: [] }
    }
    write(provider, check)
    return check
  })()
  running.set(provider, job)
  return job.finally(() => running.delete(provider))
}

// Whether each of Custard's models can be picked, from the saved keys and the
// last check only: no request. A check that couldn't reach the provider
// (timeout, no connection) says nothing about the key, so it doesn't make a
// model unavailable; a rejected key or a list without the model does.
export function availabilityFrom(
  hasKey: (p: Provider) => boolean,
  check: (p: Provider) => ModelCheck | null
): ModelAvailability[] {
  return chatModels.map((m): ModelAvailability => {
    if (!hasKey(m.provider)) return { id: m.id, available: false, reason: 'no-key' }
    const c = check(m.provider)
    if (c && (c.result === 'auth' || c.result === 'permission'))
      return { id: m.id, available: false, reason: 'rejected' }
    if (c?.result === 'ok' && !c.models.some((x) => x.id === m.id && x.available))
      return { id: m.id, available: false, reason: 'removed' }
    return { id: m.id, available: true }
  })
}

export const modelAvailability = (): ModelAvailability[] =>
  availabilityFrom((p) => getApiKey(p) !== null, lastCheck)
