// Controls for text an unattended run did not write: what plugins and notes
// return. A run has nobody to catch a hijacked instruction, so these are
// enforced by the app and don't depend on the model noticing anything:
//
// - every result is wrapped in a fixed envelope, with anything that looks like
//   markup escaped and its length capped;
// - text the run writes can't carry a link that came from a result (a link is
//   how data leaves a note: a remote image loads when the note is opened);
// - text the run writes or records can't hold something that looks like a key.

export const RESULT_CAPS = { vault: 40_000, plugin: 12_000 }

// Code points removed from results: C0 controls except tab and newline, DEL,
// line and paragraph separators, and the bidirectional overrides and isolates.
const dropped = (c: number): boolean =>
  (c <= 0x1f && c !== 0x09 && c !== 0x0a) ||
  c === 0x7f ||
  c === 0x2028 ||
  c === 0x2029 ||
  (c >= 0x202a && c <= 0x202e) ||
  (c >= 0x2066 && c <= 0x2069)

const clean = (s: string): string =>
  [...s]
    .filter((ch) => !dropped(ch.codePointAt(0)!))
    .join('')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

export function fenceResult(source: string, text: string, cap: number): string {
  const body = clean(text)
  const shown = body.length > cap ? body.slice(0, cap) : body
  const note =
    body.length > cap
      ? `\n[… ${(body.length - cap).toLocaleString('en-US')} more characters are left out here]`
      : ''
  return `<tool_result source="${source.replace(/[^\w.:/ -]/g, '')}" trust="data">\n${shown}${note}\n</tool_result>`
}

// --- links ------------------------------------------------------------------

export type Links = { hosts: Set<string>; targets: Set<string>; wiki: Set<string> }
export const noLinks = (): Links => ({ hosts: new Set(), targets: new Set(), wiki: new Set() })

const URL_RE = /\b(?:https?:\/\/|ftp:\/\/|mailto:|www\.)[^\s<>()[\]`"']+/gi
const MD_TARGET_RE = /!?\[[^\]]*\]\(\s*<?([^)\s>]+)/g
const HTML_TARGET_RE = /\b(?:href|src|srcset|poster|data)\s*=\s*["']?([^"'\s>]+)/gi
const WIKI_RE = /!?\[\[([^\]|#\n]+)(?:[#|][^\]\n]*)?\]\]/g

const trimEnd = (u: string): string => u.replace(/[.,;:!?)]+$/, '').replace(/\/+$/, '')

// The host of an http(s)/ftp link, or the whole address of a mailto.
function hostOf(u: string): string | null {
  const m = /^(?:(?:https?|ftp):\/\/)?(?:[^/@\s]*@)?([^/:?#\s]+)/i.exec(
    u.replace(/^www\./i, 'www.')
  )
  if (/^mailto:/i.test(u)) return trimEnd(u).toLowerCase()
  return m ? m[1].toLowerCase().replace(/^www\./, '') : null
}

export function linksIn(text: string, into: Links = noLinks()): Links {
  for (const m of text.matchAll(URL_RE)) {
    const h = hostOf(trimEnd(m[0]))
    if (h) into.hosts.add(h)
  }
  for (const re of [MD_TARGET_RE, HTML_TARGET_RE])
    for (const m of text.matchAll(re)) {
      const t = trimEnd(m[1]).toLowerCase()
      if (!t || t.startsWith('#')) continue
      const h = /^(?:[a-z][a-z0-9+.-]*:|\/\/|www\.)/i.test(t)
        ? hostOf(t.replace(/^\/\//, ''))
        : null
      if (h) into.hosts.add(h)
      else into.targets.add(t)
    }
  for (const m of text.matchAll(WIKI_RE)) into.wiki.add(m[1].trim().toLowerCase())
  return into
}

// Schemes that run or inline something are never written by a run.
const ACTIVE = /(?:^|[\s("'=<[])(?:javascript|vbscript|data):/i

export type Outside = { fromResults: Links; fromPlugins: Links; fromSkill: Links }
export const newOutside = (skill: string): Outside => ({
  fromResults: noLinks(),
  fromPlugins: noLinks(),
  fromSkill: linksIn(skill)
})

// Why `text` can't be written, or null. A link is refused when it points to a
// host, address or wikilink that a result carried and the skill itself does
// not name. Host matches count for URLs, so changing the path or adding a
// query to a planted address does not get around it.
export function refuseLinks(text: string, o: Outside): string | null {
  if (ACTIVE.test(text))
    return 'The text contains a link that would run or embed something (javascript:, data: or similar), so nothing was written.'
  const w = linksIn(text)
  for (const h of w.hosts)
    if (o.fromResults.hosts.has(h) && !o.fromSkill.hosts.has(h))
      return `The text contains a link to ${h}, which came from a tool result. A run doesn't write links taken from results, so nothing was written. Write it without the link.`
  for (const t of w.targets)
    if (o.fromResults.targets.has(t) && !o.fromSkill.targets.has(t))
      return `The text contains a link target (${t.slice(0, 60)}) that came from a tool result, so nothing was written. Write it without the link.`
  for (const k of w.wiki)
    if (o.fromPlugins.wiki.has(k) && !o.fromSkill.wiki.has(k))
      return `The text contains the wikilink [[${k.slice(0, 60)}]], which came from a plugin result, so nothing was written. Write the name without the link.`
  return null
}

// --- secrets ----------------------------------------------------------------

const SECRET_RES: RegExp[] = [
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g
]

export const looksLikeSecret = (text: string): boolean =>
  SECRET_RES.some((re) => ((re.lastIndex = 0), re.test(text)))

export const redactSecrets = (text: string): string =>
  SECRET_RES.reduce((t, re) => t.replace(re, '[redacted]'), text)

export const SECRET_REFUSAL =
  'The text looks like it contains a key or token, so nothing was written. Notes and run records never hold secrets.'
