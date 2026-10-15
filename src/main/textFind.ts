// Finding the parts of a long text that answer a question, for web_read and
// vault_read's `find`. Instead of the next 20,000-40,000 characters, the model
// gets the few sections that match what it is looking for, each with its
// offset so it can read around one, and the text's headings. Nothing is
// summarized: every part is the text's own words.
//
// Sections follow the Markdown headings (web pages are extracted with them)
// and paragraphs, about a thousand characters each. They are ranked with
// BM25 over plain words, accent- and case-insensitive; a heading's words
// count double in the section it starts, and a section holding the whole
// query as a phrase, or more of its words, ranks higher. Sections far
// weaker than the best match are left out. Words, not meaning: a vague `find` can
// miss, which is why the outline and offsets come with the parts and why no
// match falls back to the start of the text.

export const FIND_LIMITS = {
  // A text this short is returned as it is; there's nothing to save.
  minText: 6_000,
  // Sections close at a paragraph once this long, and are cut at this
  // length times 1.5 when a paragraph runs on.
  section: 1_200,
  // What the matching parts may add up to, in characters.
  budget: 6_000,
  maxSections: 6,
  // A section scoring under this share of the best one is left out.
  weakest: 0.25,
  // Headings listed in the outline, and characters per heading.
  outline: 40,
  headingChars: 100,
  // The longest `find` used.
  query: 200
}

export type Section = { start: number; end: number; heading: string }
export type Found = Section & { text: string }

// Lower case without accents (as vault_search folds).
const fold = (s: string): string =>
  // eslint-disable-next-line no-control-regex
  /^[\x00-\x7f]*$/.test(s)
    ? s.toLowerCase()
    : s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

const STOP = new Set(
  'a an and are as at be but by do does for from has have how i in is it its me my of on or our so than that the their them then there these they this to was we were what when where which who why will with you your'.split(
    ' '
  )
)

export const words = (s: string): string[] =>
  (fold(s).match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 1 && !STOP.has(w))

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/

// The text's sections, in order, covering all of it.
export function sections(text: string): Section[] {
  const out: Section[] = []
  const path: string[] = []
  let start = 0
  let heading = ''
  const close = (end: number): void => {
    if (end > start && text.slice(start, end).trim()) out.push({ start, end, heading })
    start = end
  }
  let at = 0
  for (const line of text.split('\n')) {
    const lineEnd = Math.min(text.length, at + line.length + 1)
    const h = HEADING.exec(line)
    if (h) {
      close(at)
      const level = h[1].length
      path.length = Math.min(path.length, level - 1)
      path[level - 1] = h[2].slice(0, FIND_LIMITS.headingChars)
      heading = path.filter(Boolean).join(' > ')
    } else if (!line.trim() && at - start >= FIND_LIMITS.section) close(at)
    else if (lineEnd - start >= FIND_LIMITS.section * 1.5) close(lineEnd)
    at = lineEnd
  }
  close(text.length)
  // A paragraph with no line breaks is cut at spaces.
  const max = Math.floor(FIND_LIMITS.section * 1.5)
  return out.flatMap((s) => {
    if (s.end - s.start <= max) return [s]
    const parts: Section[] = []
    let from = s.start
    while (s.end - from > max) {
      const space = text.lastIndexOf(' ', from + FIND_LIMITS.section)
      const cut = space > from + FIND_LIMITS.section / 2 ? space + 1 : from + FIND_LIMITS.section
      parts.push({ start: from, end: cut, heading: s.heading })
      from = cut
    }
    parts.push({ start: from, end: s.end, heading: s.heading })
    return parts
  })
}

// The best-matching sections, in text order, within the budget; null when
// nothing matches (or the query has no words to look for).
export function find(text: string, query: string, budget = FIND_LIMITS.budget): Found[] | null {
  const q = [...new Set(words(query.slice(0, FIND_LIMITS.query)))]
  if (!q.length) return null
  const secs = sections(text)
  if (!secs.length) return null
  const phrase = q.length > 1 ? words(query).join(' ') : ''
  const bags = secs.map((s) => {
    const body = words(text.slice(s.start, s.end))
    const tf = new Map<string, number>()
    for (const w of body) tf.set(w, (tf.get(w) ?? 0) + 1)
    // A heading's words count double, in the section the heading starts.
    if (HEADING.test(text.slice(s.start, s.end).split('\n', 1)[0]))
      for (const w of words(s.heading)) tf.set(w, (tf.get(w) ?? 0) + 2)
    return { tf, len: body.length, joined: phrase ? body.join(' ') : '' }
  })
  const avg = bags.reduce((n, b) => n + b.len, 0) / bags.length || 1
  const df = new Map(q.map((t) => [t, bags.filter((b) => b.tf.has(t)).length]))
  const k1 = 1.2
  const b = 0.75
  const scored = secs.map((s, i) => {
    const bag = bags[i]
    let score = 0
    let matched = 0
    for (const t of q) {
      const f = bag.tf.get(t) ?? 0
      if (!f) continue
      matched++
      const n = df.get(t) ?? 0
      const idf = Math.log(1 + (secs.length - n + 0.5) / (n + 0.5))
      score += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * bag.len) / avg))
    }
    if (score > 0) {
      score *= 1 + matched / q.length
      if (phrase && bag.joined.includes(phrase)) score *= 1.5
    }
    return { s, score }
  })
  const best = Math.max(0, ...scored.map((x) => x.score))
  if (!best) return null
  // Much weaker matches than the best are left out, not used to fill the
  // budget.
  const ranked = scored
    .filter((x) => x.score >= best * FIND_LIMITS.weakest)
    .sort((x, y) => y.score - x.score)
  const picked: Section[] = []
  let used = 0
  for (const { s } of ranked) {
    if (picked.length >= FIND_LIMITS.maxSections) break
    const len = s.end - s.start
    // The best one always goes in, cut to the budget if it must be.
    if (!picked.length) {
      picked.push(len > budget ? { ...s, end: s.start + budget } : s)
      used += Math.min(len, budget)
      continue
    }
    if (used + len > budget) continue
    picked.push(s)
    used += len
  }
  return picked
    .sort((x, y) => x.start - y.start)
    .map((s) => ({ ...s, text: text.slice(s.start, s.end).trim() }))
}

const n = (x: number): string => x.toLocaleString('en-US')

// The matching parts, each headed with where it is.
export const formatFound = (found: Found[]): string =>
  found
    .map(
      (f) =>
        `[characters ${n(f.start)}–${n(f.end)}${f.heading ? ` · under "${f.heading}"` : ''}]\n${f.text}`
    )
    .join('\n\n')

// The text's headings with the offset each starts at, or '' for none.
export function outline(text: string): string {
  const lines: string[] = []
  let count = 0
  let at = 0
  for (const line of text.split('\n')) {
    const h = HEADING.exec(line)
    if (h) {
      count++
      if (lines.length < FIND_LIMITS.outline)
        lines.push(
          `${'  '.repeat(h[1].length - 1)}- ${h[2].slice(0, FIND_LIMITS.headingChars)} (offset ${at})`
        )
    }
    at += line.length + 1
  }
  if (!lines.length) return ''
  const more = count - lines.length
  return `Headings:\n${lines.join('\n')}${more > 0 ? `\n(${more} more headings not listed)` : ''}`
}

// The query as given, trimmed and bounded, or null for none.
export function findQuery(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const q = v.trim().slice(0, FIND_LIMITS.query)
  return q ? q : null
}
