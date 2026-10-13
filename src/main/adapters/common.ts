import type { ListedModel } from '../../shared/adapter'
import { chatModels } from '../../shared/chat'
import { providerNames, providers, type Provider } from '../../shared/providers'
import { ProviderError, toProviderError } from '../providerError'
import { capabilitiesOf, modelInfo } from './capabilities'
import type { AuthResult, ModelListing } from './types'

// The models Custard has a profile for, for one provider, in picker order,
// not checked against the provider.
export const knownModels = (provider: Provider): ListedModel[] =>
  chatModels
    .filter((m) => m.provider === provider)
    .map((m) => ({ ...modelInfo(m.id)!, available: 'unchecked' as const }))

// One entry of a provider's model list, as far as Custard reads it. DeepSeek
// also gives a display name, context size, output limit and input kinds
// (api-docs.deepseek.com/api/list-models); the others give an id and a name.
export type RawModel = {
  id: string
  name?: string
  contextWindow?: number
  maxOutput?: number
}

// A model list response: `{ data: [{ id, … }] }` for all three providers.
// Anything else is a 'bad_response', never an empty list.
export function parseModelList(body: unknown, provider: Provider): RawModel[] {
  const bad = (): never => {
    throw new ProviderError(
      'bad_response',
      providerNames[provider],
      `${providerNames[provider]} sent a model list Custard couldn't read.`
    )
  }
  if (!body || typeof body !== 'object') return bad()
  const data = (body as { data?: unknown }).data
  if (!Array.isArray(data)) return bad()
  return data.map((m): RawModel => {
    if (!m || typeof m !== 'object' || typeof (m as { id?: unknown }).id !== 'string') return bad()
    const r = m as Record<string, unknown>
    const num = (v: unknown): number | undefined =>
      typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined
    const name = r.name ?? r.display_name
    return {
      id: (r.id as string).slice(0, 200),
      ...(typeof name === 'string' && name ? { name: name.slice(0, 200) } : {}),
      ...(num(r.context_window) ? { contextWindow: num(r.context_window) } : {}),
      ...(num(r.max_output_tokens) ? { maxOutput: num(r.max_output_tokens) } : {})
    }
  })
}

// What the provider listed, against Custard's own models: each known model
// marked available or not for this key, and, when `discover` is on, the
// models Custard has no profile for. Those are never pickable (Neno's call,
// 2026-10-13): Custard has no prices, context limits or file rules for them.
export function listingFrom(
  provider: Provider,
  raw: RawModel[],
  discover: boolean,
  at: number
): ModelListing {
  const ids = new Set(raw.map((r) => r.id))
  const known = knownModels(provider).map((m) => ({ ...m, available: ids.has(m.id) }))
  const knownIds = new Set(known.map((m) => m.id))
  const seen = new Set<string>()
  const discovered: ListedModel[] = discover
    ? raw
        .filter((r) => !knownIds.has(r.id) && !seen.has(r.id) && seen.add(r.id))
        .map((r) => ({
          id: r.id,
          label: r.name ?? r.id,
          provider,
          api: providers[provider].api,
          contextWindow: r.contextWindow ?? 0,
          maxOutput: r.maxOutput ?? 0,
          priced: false,
          capabilities: capabilitiesOf(r.id),
          source: 'discovered' as const,
          available: true
        }))
    : []
  return { models: [...known, ...discovered], checkedAt: at }
}

// Runs a model-list call and turns any failure into a ProviderError with the
// key hidden. A failure that isn't the provider's or the network's (the SDK
// couldn't parse the body) is a 'bad_response'.
export async function listCall<T>(
  provider: Provider,
  key: string,
  call: () => Promise<T>
): Promise<T> {
  try {
    return await call()
  } catch (err) {
    const e = toProviderError(err, providerNames[provider], key)
    if (e.kind !== 'unknown') throw e
    throw new ProviderError(
      'bad_response',
      providerNames[provider],
      `${providerNames[provider]} sent a model list Custard couldn't read.`
    )
  }
}

// A key check is the model list: the cheapest call each provider offers.
// Only ever run when the user saves a key or presses Refresh.
export async function authenticateWith(
  provider: Provider,
  key: string,
  list: () => Promise<unknown>
): Promise<AuthResult> {
  try {
    await list()
    return { ok: true }
  } catch (err) {
    const e = toProviderError(err, providerNames[provider], key)
    return { ok: false, kind: e.kind, message: e.message }
  }
}

// How long a check may take; a check never retries on its own.
export const CHECK_OPTS = { timeout: 15_000, maxRetries: 0 }
