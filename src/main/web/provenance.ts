import type { Conversation } from '../../shared/chat'
import { sameUrlKey } from '../../shared/web'

export { sameUrlKey }

// Where a URL the model wants to read came from, judged from the stored
// conversation and never from what the model says. Only URLs the user wrote
// and results of Custard's own searches are read without asking; anything
// else (a link inside a page, a URL from a note or plugin, an edited URL) is
// shown to the user first, because the URL itself can carry private data out.

export type Origin =
  | { kind: 'user' }
  | { kind: 'search'; query?: string }
  | { kind: 'page'; page: string }
  | { kind: 'other' }

const URL_RE = /https?:\/\/[^\s<>"'`]+/gi

// URLs written in the user's own messages (not tool results).
export function userUrls(c: Conversation): Set<string> {
  const keys = new Set<string>()
  for (const m of c.messages) {
    if (m.role !== 'user') continue
    const texts =
      typeof m.content === 'string'
        ? [m.content]
        : m.content.flatMap((b) => (b.type === 'text' ? [b.text] : []))
    for (const t of texts)
      for (const match of t.match(URL_RE) ?? []) {
        // Trailing punctuation and unbalanced brackets aren't part of a URL.
        let u = match.replace(/[.,;:!?]+$/, '')
        while (
          /[)\]]$/.test(u) &&
          (u.match(/[([]/g)?.length ?? 0) < (u.match(/[)\]]/g)?.length ?? 0)
        )
          u = u.slice(0, -1)
        const key = sameUrlKey(u)
        if (key) keys.add(key)
      }
  }
  return keys
}

// Links seen in pages read this session, by link key → page it was found on.
const seenLinks = new Map<string, Map<string, string>>()

export function rememberLinks(conversationId: string, page: string, links: string[]): void {
  const m = seenLinks.get(conversationId) ?? new Map<string, string>()
  for (const l of links) {
    const key = sameUrlKey(l)
    if (key && !m.has(key)) m.set(key, page)
  }
  // Bounded: keeps the most recent few thousand links per chat.
  while (m.size > 5000) m.delete(m.keys().next().value as string)
  seenLinks.set(conversationId, m)
}

export function urlOrigin(url: string, c: Conversation): Origin {
  const key = sameUrlKey(url)
  if (!key) return { kind: 'other' }
  if (userUrls(c).has(key)) return { kind: 'user' }
  const hit = (c.sources ?? []).find((s) => s.origin === 'search' && sameUrlKey(s.url) === key)
  if (hit) return { kind: 'search', query: hit.query }
  const page = seenLinks.get(c.id)?.get(key)
  if (page) return { kind: 'page', page }
  return { kind: 'other' }
}

// The approval card's explanation, or null when no approval is needed.
export function originWarning(origin: Origin): string | null {
  switch (origin.kind) {
    case 'user':
    case 'search':
      return null
    case 'page':
      return `This link came from a web page (${origin.page}), not from you or a search. Check the address before allowing it: anything in it is sent to that site.`
    default:
      return "This address didn't come from you or from a search result. Check it before allowing it: anything in it is sent to that site."
  }
}
