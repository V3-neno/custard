import type { WebSource } from './chat'

// Scheme-less, fragment-less form of a URL for comparison. The path and
// query are kept exactly: a changed query string is a different URL.
export function sameUrlKey(raw: string): string | null {
  try {
    const u = new URL(raw)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
    u.hash = ''
    const port = u.port && u.port !== '443' && u.port !== '80' ? `:${u.port}` : ''
    return `${u.hostname.toLowerCase()}${port}${u.pathname}${u.search}`
  } catch {
    return null
  }
}

// URLs an answer links to, as Markdown links or bare URLs.
export function linkedUrls(text: string): Set<string> {
  const keys = new Set<string>()
  for (const m of text.matchAll(/\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>"'`)\]]+)/g)) {
    const key = sameUrlKey((m[1] ?? m[2]).replace(/[.,;:!?]+$/, ''))
    if (key) keys.add(key)
  }
  return keys
}

// A turn's sources split into the ones the answer cites and the ones only
// consulted. Nothing counts as cited just because it was retrieved.
export function splitSources(
  sources: WebSource[],
  answer: string
): { cited: WebSource[]; consulted: WebSource[] } {
  const linked = linkedUrls(answer)
  const seen = new Set<string>()
  const cited: WebSource[] = []
  const consulted: WebSource[] = []
  for (const s of sources) {
    const key = sameUrlKey(s.url)
    if (!key || seen.has(key)) continue
    seen.add(key)
    ;(linked.has(key) ? cited : consulted).push(s)
  }
  return { cited, consulted }
}
