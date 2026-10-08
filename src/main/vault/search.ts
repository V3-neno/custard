import { promises as fsp } from 'fs'
import { join, relative, sep } from 'path'
import { resolveInVault } from '../memory/paths'

// vault_search: plain words, "quoted phrases", folder: and tag: filters,
// accent- and case-insensitive, ranked, paged. The scan is asynchronous and
// bounded (a few files at a time, a file-count and time limit) so a large
// vault never blocks the app, and it never follows a link.

export const SEARCH_LIMITS = {
  pageSize: 20,
  // Files read at the same time.
  concurrency: 8,
  maxFiles: 20_000,
  maxFileBytes: 2_000_000,
  timeMs: 5_000,
  snippets: 2,
  snippetChars: 160
}

export class SearchError extends Error {}

export type Query = { terms: string[]; phrases: string[]; folders: string[]; tags: string[] }

// Lower case without accents: "Café" and "cafe" match.
export const fold = (s: string): string =>
  // eslint-disable-next-line no-control-regex
  /^[\x00-\x7f]*$/.test(s)
    ? s.toLowerCase()
    : s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

export function parseQuery(raw: string): Query {
  const q: Query = { terms: [], phrases: [], folders: [], tags: [] }
  const re = /(\w+):"([^"]*)"|(\w+):(\S+)|"([^"]*)"|#([\p{L}\p{N}_/-]+)|(\S+)/gu
  for (const m of raw.matchAll(re)) {
    const key = (m[1] ?? m[3])?.toLowerCase()
    const value = m[2] ?? m[4]
    if ((key === 'folder' || key === 'path') && value !== undefined) {
      const f = value.trim().replace(/^[/\\]+|[/\\]+$/g, '')
      if (f) q.folders.push(f)
    } else if (key === 'tag' && value !== undefined) {
      const t = fold(value.replace(/^#/, ''))
      if (t) q.tags.push(t)
    } else if (m[5] !== undefined) {
      const p = fold(m[5]).trim().split(/\s+/).filter(Boolean)
      if (p.length > 1) q.phrases.push(p.join(' '))
      else if (p.length) q.terms.push(p[0])
    } else if (m[6] !== undefined) q.tags.push(fold(m[6]))
    else if (m[0]) {
      // A word with a colon that isn't a filter ("10:30") is just a word.
      q.terms.push(fold(m[0]))
    }
  }
  return q
}

// Text folded for matching, with the position in the original of each
// folded character, so snippets come from the note as written.
function folded(text: string): { text: string; at: (i: number) => number } {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7f]*$/.test(text)) return { text: text.toLowerCase(), at: (i) => i }
  let out = ''
  const map: number[] = []
  let i = 0
  for (const ch of text) {
    const f = fold(ch)
    for (let k = 0; k < f.length; k++) map.push(i)
    out += f
    i += ch.length
  }
  return { text: out, at: (j) => map[Math.min(j, map.length - 1)] ?? 0 }
}

// Frontmatter tags (list or inline) and #tags in the text, folded.
export function tagsOf(text: string): Set<string> {
  const tags = new Set<string>()
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1]
  if (front) {
    const block = /^tags?:[ \t]*(.*)$((?:\r?\n[ \t]*-[ \t]*.*)*)/m.exec(front)
    if (block) {
      const inline = block[1].replace(/^\[|\]$/g, '')
      for (const t of [
        ...inline.split(','),
        ...block[2].split(/\r?\n/).map((l) => l.replace(/^[ \t]*-/, ''))
      ])
        if (t.trim())
          tags.add(
            fold(
              t
                .trim()
                .replace(/^["']|["']$/g, '')
                .replace(/^#/, '')
            )
          )
    }
  }
  for (const m of text.matchAll(/(?:^|\s)#([\p{L}\p{N}_/-]*\p{L}[\p{L}\p{N}_/-]*)/gu))
    tags.add(fold(m[1]))
  return tags
}

const hasTag = (tags: Set<string>, want: string): boolean =>
  [...tags].some((t) => t === want || t.startsWith(`${want}/`))

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

type Hit = { path: string; all: boolean; matched: number; score: number; snippets: string[] }

function snippet(original: string, start: number, length: number): string {
  const { snippetChars } = SEARCH_LIMITS
  const before = Math.floor((snippetChars - length) / 3)
  let a = Math.max(0, start - Math.max(before, 20))
  let b = Math.min(original.length, a + snippetChars)
  // Whole words at the edges.
  if (a > 0) a = original.indexOf(' ', a) + 1 || a
  if (b < original.length)
    b = original.lastIndexOf(' ', b) > start ? original.lastIndexOf(' ', b) : b
  const s = original.slice(a, b).replace(/\s+/g, ' ').trim()
  return `${a > 0 ? '…' : ''}${s}${b < original.length ? '…' : ''}`
}

// One note against the query, or null when it doesn't match.
export function matchNote(path: string, text: string, q: Query): Hit | null {
  if (q.tags.length) {
    const tags = tagsOf(text)
    if (!q.tags.every((t) => hasTag(tags, t))) return null
  }
  const name = fold(path.replace(/\.md$/i, ''))
  const body = folded(text)
  const needles = [
    ...q.terms.map((t) => ({ re: new RegExp(escape(t), 'g') })),
    ...q.phrases.map((p) => ({ re: new RegExp(p.split(' ').map(escape).join('\\s+'), 'g') }))
  ]
  if (!needles.length) return { path, all: true, matched: 0, score: 0, snippets: [] }
  let matched = 0
  let score = 0
  const found: { at: number; len: number }[] = []
  for (const n of needles) {
    const inName = n.re.test(name)
    n.re.lastIndex = 0
    let count = 0
    let first: { at: number; len: number } | null = null
    for (const m of body.text.matchAll(n.re)) {
      if (!first) first = { at: m.index ?? 0, len: m[0].length }
      if (++count >= 20) break
    }
    if (!inName && !count) continue
    matched++
    score += count + (inName ? 10 : 0)
    if (first) found.push(first)
  }
  if (!matched) return null
  // Snippets around different matches, in the order they appear.
  const snippets: string[] = []
  let last = -Infinity
  for (const f of found.sort((a, b) => a.at - b.at)) {
    const at = body.at(f.at)
    if (at - last < SEARCH_LIMITS.snippetChars) continue
    snippets.push(snippet(text, at, body.at(f.at + f.len) - at))
    last = at
    if (snippets.length >= SEARCH_LIMITS.snippets) break
  }
  return { path, all: matched === needles.length, matched, score, snippets }
}

const toVaultPath = (vault: string, full: string): string =>
  relative(vault, full).split(sep).join('/')

// Every note under `dir`, never through a link or into a hidden folder.
async function* walk(dir: string): AsyncGenerator<string> {
  const stack = [dir]
  while (stack.length) {
    const d = stack.pop()!
    let entries: import('fs').Dirent[]
    try {
      entries = await fsp.readdir(d, { withFileTypes: true })
    } catch {
      continue
    }
    entries.sort((a, b) => (a.name < b.name ? 1 : -1))
    for (const e of entries) {
      if (e.name.startsWith('.') || e.isSymbolicLink()) continue
      const full = join(d, e.name)
      if (e.isDirectory()) stack.push(full)
      else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) yield full
    }
  }
}

export type SearchDeps = {
  readFile?: (p: string) => Promise<string>
  size?: (p: string) => Promise<number>
  now?: () => number
}

export type SearchResult = {
  hits: Hit[]
  total: number
  searched: number
  skippedLarge: number
  stopped: 'files' | 'time' | null
}

export async function searchVault(
  vault: string,
  q: Query,
  deps: SearchDeps = {}
): Promise<SearchResult> {
  const readFile = deps.readFile ?? ((p: string) => fsp.readFile(p, 'utf8'))
  const size = deps.size ?? (async (p: string) => (await fsp.stat(p)).size)
  const now = deps.now ?? Date.now
  const roots = q.folders.length
    ? q.folders.map((f) => {
        const full = resolveInVault(vault, f, false)
        return full
      })
    : [vault]
  const start = now()
  const hits: Hit[] = []
  let searched = 0
  let skippedLarge = 0
  let stopped: SearchResult['stopped'] = null
  const seen = new Set<string>()
  for (const root of roots) {
    const files = walk(root)
    // A few readers pull from the same walk.
    const worker = async (): Promise<void> => {
      for (;;) {
        if (stopped) return
        if (searched >= SEARCH_LIMITS.maxFiles) {
          stopped = 'files'
          return
        }
        if (now() - start > SEARCH_LIMITS.timeMs) {
          stopped = 'time'
          return
        }
        const next = await files.next()
        if (next.done) return
        const file = next.value
        if (seen.has(file)) continue
        seen.add(file)
        searched++
        try {
          if ((await size(file)) > SEARCH_LIMITS.maxFileBytes) {
            skippedLarge++
            continue
          }
          const hit = matchNote(toVaultPath(vault, file), await readFile(file), q)
          if (hit) hits.push(hit)
        } catch {
          // Unreadable notes are left out.
        }
      }
    }
    await Promise.all(Array.from({ length: SEARCH_LIMITS.concurrency }, worker))
  }
  hits.sort(
    (a, b) =>
      Number(b.all) - Number(a.all) ||
      b.matched - a.matched ||
      b.score - a.score ||
      (a.path < b.path ? -1 : 1)
  )
  return { hits, total: hits.length, searched, skippedLarge, stopped }
}

const describe = (q: Query): string =>
  [
    ...q.terms,
    ...q.phrases.map((p) => `"${p}"`),
    ...q.folders.map((f) => `folder:${f}`),
    ...q.tags.map((t) => `#${t}`)
  ].join(' ')

export async function search(
  vault: string,
  input: { query?: unknown; page?: unknown },
  deps?: SearchDeps
): Promise<string> {
  if (typeof input.query !== 'string' || !input.query.trim())
    throw new SearchError('A query is required.')
  const q = parseQuery(input.query)
  if (!q.terms.length && !q.phrases.length && !q.tags.length && !q.folders.length)
    throw new SearchError('A query is required.')
  const page = Math.max(1, Math.floor(Number(input.page) || 1))
  const r = await searchVault(vault, q, deps)
  const { pageSize } = SEARCH_LIMITS
  const notes: string[] = []
  if (r.stopped)
    notes.push(
      `This was a partial scan: it stopped after ${r.stopped === 'time' ? `${SEARCH_LIMITS.timeMs / 1000} seconds` : `${SEARCH_LIMITS.maxFiles.toLocaleString('en-US')} notes`}, with ${r.searched.toLocaleString('en-US')} notes searched, so notes it didn't reach may also match. Each page runs a new scan, which may stop at a different point, so pages can repeat or miss notes. Narrow it with folder: or more words for complete results.`
    )
  if (r.skippedLarge)
    notes.push(
      `${r.skippedLarge} note${r.skippedLarge === 1 ? ' was' : 's were'} over ${SEARCH_LIMITS.maxFileBytes / 1_000_000} MB and not searched.`
    )
  const partial = !!r.stopped
  if (!r.total)
    return [
      `No notes matched ${describe(q)}${partial ? ' in the part of the vault searched' : ''}.`,
      ...notes
    ].join('\n')
  const from = (page - 1) * pageSize
  if (from >= r.total)
    return [
      `${partial ? `This scan found ${r.total} matches` : `There are ${r.total} matches`}, so page ${page} is past the end (last page: ${Math.ceil(r.total / pageSize)}).`,
      ...notes
    ].join('\n')
  const shown = r.hits.slice(from, from + pageSize)
  const all = r.hits.filter((h) => h.all).length
  const terms = q.terms.length + q.phrases.length
  return [
    `${r.total} note${r.total === 1 ? '' : 's'} matched ${describe(q)}${partial ? ' in a partial scan (not a total for the whole vault)' : ''}${terms > 1 ? ` (${all} with every term, listed first)` : ''}. Showing ${from + 1}–${from + shown.length}${from + shown.length < r.total ? `; for more, search again with page ${page + 1}` : ''}.`,
    ...notes,
    ...shown.map(
      (h) =>
        `- ${h.path}${terms > 1 && !h.all ? ` (${h.matched} of ${terms} terms)` : ''}${h.snippets.map((s) => `\n  ${s}`).join('')}`
    )
  ].join('\n')
}
