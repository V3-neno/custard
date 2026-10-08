import type { MediaProvider } from '../../shared/design'

// Where Design finds media providers. Built-in providers (Workstream B:
// OpenAI images) and plugin providers (Workstream C: from enabled plugins'
// `media` declarations) each register one source; Design only ever sees the
// common MediaProvider interface, never which service is behind it.

export type ProviderSource = () => MediaProvider[]

const sources = new Map<string, ProviderSource>()

// `name` is 'built-in' or 'plugins'; registering again replaces it.
export function registerProviders(name: string, source: ProviderSource): void {
  sources.set(name, source)
}

export function mediaProviders(): MediaProvider[] {
  const all: MediaProvider[] = []
  const ids = new Set<string>()
  for (const source of sources.values()) {
    let list: MediaProvider[] = []
    try {
      list = source()
    } catch (err) {
      console.error('Media providers:', err)
    }
    for (const p of list) {
      const id = p.info().id
      // Ids are unique; a clash keeps the first and drops the other.
      if (ids.has(id)) continue
      ids.add(id)
      all.push(p)
    }
  }
  return all
}

export const mediaProvider = (id: string): MediaProvider | null =>
  mediaProviders().find((p) => p.info().id === id) ?? null

// For tests.
export const clearProviders = (): void => sources.clear()
