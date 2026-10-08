import { posix } from 'path'
import type { ArtifactFile } from '../../../shared/design'
import { safeFilePath, StoreError } from '../store'

// What an HTML version is made of, checked before anything is stored:
// one complete document (index.html), optional local text files beside it,
// and images attached in the same chat, copied in. Nothing here touches the
// disk or the network; see handler.ts for storing and preview.ts for running.

export const HTML_LIMITS = {
  // The document itself.
  htmlBytes: 2_000_000,
  // Text files beside it (CSS, JS, SVG, JSON, more pages).
  files: 20,
  fileBytes: 1_000_000,
  references: 10
}

export class HtmlError extends Error {}

// Local files a version may hold, by extension. Anything else is refused,
// so a version can't carry an executable or an archive.
const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif'
}
const TEXT = new Set(['html', 'htm', 'css', 'js', 'mjs', 'json', 'svg', 'txt', 'md'])
const IMAGE_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif'
}

const ext = (p: string): string => /\.([a-z0-9]+)$/i.exec(p)?.[1].toLowerCase() ?? ''
export const mimeOf = (p: string): string | null => TYPES[ext(p)] ?? null

// A complete document: a doctype or <html> first, and </html> at the end.
// A fragment or a document cut off mid-way is refused, so a preview is only
// ever built from the whole thing.
export function checkDocument(html: string): void {
  if (Buffer.byteLength(html, 'utf8') > HTML_LIMITS.htmlBytes)
    throw new HtmlError(
      `The document is over ${HTML_LIMITS.htmlBytes / 1_000_000} MB; split it into local files.`
    )
  const start = html
    .replace(/^﻿/, '')
    .replace(/^(\s|<!--[\s\S]*?-->)+/, '')
    .slice(0, 20)
    .toLowerCase()
  if (!start.startsWith('<!doctype html') && !start.startsWith('<html'))
    throw new HtmlError(
      'Send a complete HTML document starting with <!doctype html>, not a fragment.'
    )
  if (!/<\/html\s*>\s*(<!--[\s\S]*?-->\s*)*$/i.test(html))
    throw new HtmlError('The document is incomplete: it must end with </html>.')
}

export type Planned = { path: string; mime: string; bytes: Uint8Array }

// A local file's path, checked like the store does, plus an allowed type.
function filePath(p: string): string {
  const clean = p.replace(/^\.\//, '')
  let parts: string[]
  try {
    parts = safeFilePath(clean)
  } catch (err) {
    throw new HtmlError(err instanceof StoreError ? err.message : String(err))
  }
  const path = parts.join('/')
  if (!mimeOf(path)) throw new HtmlError(`"${p}" isn't a file type a preview can use.`)
  return path
}

export type FileInput = { path: string; content: string }
export type ReferenceInput = { attachment: string; path?: string }
export type AttachedImage = { id: string; name: string; mime: string; bytes: Uint8Array }

// Every file of a new version. A revision or variation keeps the files of
// the version it starts from unless it replaces them, so changing a page
// doesn't mean sending its images again; index.html is always the new one.
export function planFiles(a: {
  html: string
  files: FileInput[]
  references: { ref: ReferenceInput; image: AttachedImage }[]
  inherited: Planned[]
}): Planned[] {
  checkDocument(a.html)
  if (a.files.length > HTML_LIMITS.files)
    throw new HtmlError(`At most ${HTML_LIMITS.files} local files per version.`)
  if (a.references.length > HTML_LIMITS.references)
    throw new HtmlError(`At most ${HTML_LIMITS.references} attached images per version.`)
  const out = new Map<string, Planned>()
  const add = (f: Planned, from: string): void => {
    const key = f.path.toLowerCase()
    if (out.has(key)) throw new HtmlError(`"${f.path}" is given twice (${from}).`)
    out.set(key, f)
  }
  add({ path: 'index.html', mime: TYPES.html, bytes: Buffer.from(a.html, 'utf8') }, 'the document')
  for (const f of a.files) {
    if (typeof f?.path !== 'string' || typeof f.content !== 'string')
      throw new HtmlError('Each local file needs a path and text content.')
    const path = filePath(f.path)
    if (path.toLowerCase() === 'index.html')
      throw new HtmlError('index.html is the document itself; send it as html.')
    if (!TEXT.has(ext(path)))
      throw new HtmlError(
        `"${f.path}": local files sent as text must be text (CSS, JS, SVG, JSON, HTML).`
      )
    const bytes = Buffer.from(f.content, 'utf8')
    if (bytes.byteLength > HTML_LIMITS.fileBytes) throw new HtmlError(`"${f.path}" is too large.`)
    add({ path, mime: mimeOf(path)!, bytes }, 'local files')
  }
  for (const { ref, image } of a.references) {
    const want = IMAGE_EXT[image.mime]
    if (!want) throw new HtmlError(`${image.name} isn't an image a page can show.`)
    const path = filePath(ref.path ?? `assets/${posix.basename(safeName(image.name, want))}`)
    if (ext(path) !== want && !(want === 'jpg' && ext(path) === 'jpeg'))
      throw new HtmlError(`"${path}" must end in .${want} to match ${image.name}.`)
    add({ path, mime: image.mime, bytes: image.bytes }, 'attached images')
  }
  for (const f of a.inherited)
    if (!out.has(f.path.toLowerCase()) && f.path !== 'index.html') out.set(f.path.toLowerCase(), f)
  return [...out.values()]
}

// An attached file's own name, made into a plain file name with the right
// extension.
function safeName(name: string, want: string): string {
  const base = (name.split(/[\\/]/).pop() ?? '').replace(/\.[^.]*$/, '')
  const clean = base
    .replace(/[^A-Za-z0-9_-]/g, '-')
    .replace(/^[-_]+/, '')
    .slice(0, 60)
  return `${clean || 'image'}.${want}`
}

// ------------------------------------------------------------ local references

export type AssetCheck = {
  // Relative references found in the document and its CSS.
  local: number
  missing: string[]
  // Absolute http(s) or protocol-relative references: they can't load in the
  // preview, which has no network.
  external: number
}

const SKIP = /^(#|data:|blob:|about:|javascript:|mailto:|tel:)/i
const EXTERNAL = /^(https?:)?\/\//i

function refsIn(text: string, css: boolean): string[] {
  const out: string[] = []
  if (!css)
    for (const m of text.matchAll(/\b(?:src|href|poster)\s*=\s*(["'])(.*?)\1/gis)) out.push(m[2])
  for (const m of text.matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi)) out.push(m[2])
  for (const m of text.matchAll(/@import\s+(["'])(.*?)\1/gi)) out.push(m[2])
  return out.map((r) => r.trim()).filter(Boolean)
}

// Which relative references in the document (and in its CSS files) point at
// files the version holds. A static check of the text, reported as such; the
// preview itself is the real test.
export function checkAssets(
  files: Pick<ArtifactFile, 'path' | 'mime'>[],
  read: (p: string) => string
): AssetCheck {
  const have = new Set(files.map((f) => f.path))
  const result: AssetCheck = { local: 0, missing: [], external: 0 }
  const seen = new Set<string>()
  for (const f of files) {
    const css = f.mime.startsWith('text/css')
    if (!css && !f.mime.startsWith('text/html')) continue
    const dir = posix.dirname(f.path)
    for (const r of refsIn(read(f.path), css)) {
      if (SKIP.test(r)) continue
      if (EXTERNAL.test(r)) {
        result.external++
        continue
      }
      if (/^[a-z][a-z0-9+.-]*:/i.test(r)) continue
      const path = posix
        .normalize(posix.join(r.startsWith('/') ? '.' : dir, r.split(/[?#]/)[0]))
        .replace(/^\.\//, '')
      let decoded = path
      try {
        decoded = decodeURIComponent(path)
      } catch {
        // Keep it as written.
      }
      if (seen.has(decoded)) continue
      seen.add(decoded)
      result.local++
      if (!have.has(decoded)) result.missing.push(decoded)
    }
  }
  return result
}
