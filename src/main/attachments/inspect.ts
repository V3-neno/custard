import { createHash } from 'crypto'
import {
  ATTACHMENT_LIMITS,
  TEXT_EXTENSIONS,
  formatBytes,
  type AttachmentKind
} from '../../shared/attachments'

// What a file really is, from its bytes, and whether Custard will send it.
// Only headers and structure are read: images are never decoded, PDFs never
// rendered, nothing is decompressed or run.

export class AttachError extends Error {}

export type Inspected = {
  kind: AttachmentKind
  mime: string
  ext: string
  bytes: number
  sha256: string
  width?: number
  height?: number
  frames?: number
  pages?: number
  chars?: number
}

const L = ATTACHMENT_LIMITS

// A name safe to show: no control or direction-changing characters, bounded.
export function displayName(name: string): string {
  const clean = name
    .replace(/^.*[/\\]/, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
    .trim()
  if (!clean) return 'file'
  return clean.length > 120 ? `${clean.slice(0, 80)}…${clean.slice(-30)}` : clean
}

export const extOf = (name: string): string => {
  const base = name.replace(/^.*[/\\]/, '').toLowerCase()
  if (base === 'dockerfile' || base === '.gitignore' || base === '.env')
    return base.replace(/^\./, '')
  const m = /\.([a-z0-9]{1,10})$/.exec(base)
  return m ? m[1] : ''
}

type Sniffed = 'png' | 'jpeg' | 'gif' | 'webp' | 'pdf' | null

function sniff(b: Buffer): Sniffed {
  if (
    b.length >= 8 &&
    b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return 'png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg'
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1'))) return 'gif'
  if (
    b.length >= 12 &&
    b.toString('latin1', 0, 4) === 'RIFF' &&
    b.toString('latin1', 8, 12) === 'WEBP'
  )
    return 'webp'
  if (b.length >= 5 && b.toString('latin1', 0, 5) === '%PDF-') return 'pdf'
  return null
}

const IMAGE_EXT: Record<string, Sniffed> = {
  png: 'png',
  jpg: 'jpeg',
  jpeg: 'jpeg',
  gif: 'gif',
  webp: 'webp',
  pdf: 'pdf'
}

const describeSniffed = (s: Sniffed): string =>
  s === 'pdf' ? 'a PDF' : s ? `a ${s.toUpperCase()} image` : 'not an image or PDF'

const short = (): never => {
  throw new AttachError('The file is cut short or damaged.')
}

function pngSize(b: Buffer): { width: number; height: number } {
  if (b.length < 24 || b.toString('latin1', 12, 16) !== 'IHDR') short()
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
}

function jpegSize(b: Buffer): { width: number; height: number } {
  let i = 2
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) short()
    const marker = b[i + 1]
    if (marker === 0xff) {
      i++
      continue
    }
    // Markers without a length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      i += 2
      continue
    }
    const len = b.readUInt16BE(i + 2)
    if (len < 2) short()
    // Start of frame (not DHT, JPG or DAC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (i + 9 > b.length) short()
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) }
    }
    i += 2 + len
  }
  return short()
}

// Size, and the number of frames (walking the block structure, bounded).
function gifInfo(b: Buffer): { width: number; height: number; frames: number } {
  if (b.length < 13) short()
  const width = b.readUInt16LE(6)
  const height = b.readUInt16LE(8)
  let i = 13
  const flags = b[10]
  if (flags & 0x80) i += 3 * 2 ** ((flags & 7) + 1)
  const skipBlocks = (): void => {
    while (i < b.length && b[i] !== 0) i += b[i] + 1
    if (i >= b.length) short()
    i++
  }
  let frames = 0
  while (i < b.length) {
    const sep = b[i]
    if (sep === 0x3b) break
    if (sep === 0x21) {
      i += 2
      skipBlocks()
    } else if (sep === 0x2c) {
      if (i + 10 > b.length) short()
      const local = b[i + 9]
      i += 10
      if (local & 0x80) i += 3 * 2 ** ((local & 7) + 1)
      i++ // LZW minimum code size
      skipBlocks()
      if (++frames >= L.gifFrames) break
    } else short()
  }
  if (!frames) short()
  return { width, height, frames }
}

function webpInfo(b: Buffer): { width: number; height: number; frames: number } {
  let width = 0
  let height = 0
  let frames = 0
  let i = 12
  while (i + 8 <= b.length) {
    const id = b.toString('latin1', i, i + 4)
    const size = b.readUInt32LE(i + 4)
    const data = i + 8
    if (id === 'VP8X' && data + 10 <= b.length) {
      width = b.readUIntLE(data + 4, 3) + 1
      height = b.readUIntLE(data + 7, 3) + 1
    } else if (id === 'VP8 ' && !width && data + 10 <= b.length) {
      width = b.readUInt16LE(data + 6) & 0x3fff
      height = b.readUInt16LE(data + 8) & 0x3fff
    } else if (id === 'VP8L' && !width && data + 5 <= b.length) {
      const bits = b.readUInt32LE(data + 1)
      width = (bits & 0x3fff) + 1
      height = ((bits >> 14) & 0x3fff) + 1
    } else if (id === 'ANMF') frames++
    i = data + size + (size & 1)
  }
  if (!width || !height) short()
  return { width, height, frames: Math.max(1, frames) }
}

// Pages from a byte scan: page objects, or the page tree's count. Compressed
// object streams can hide both; then the count is unknown and the provider
// checks it.
function pdfInfo(b: Buffer): { pages?: number } {
  const text = b.toString('latin1')
  if (/\/Encrypt\b/.test(text))
    throw new AttachError(
      "This PDF is encrypted or password-protected, which the providers don't accept."
    )
  const objects = (text.match(/\/Type\s*\/Page(?![a-zA-Z])/g) ?? []).length
  let tree = 0
  for (const m of text.matchAll(
    /\/Type\s*\/Pages\b[^>]*?\/Count\s+(\d+)|\/Count\s+(\d+)[^>]*?\/Type\s*\/Pages\b/g
  ))
    tree = Math.max(tree, Number(m[1] ?? m[2]))
  const pages = Math.max(objects, tree)
  return pages ? { pages } : {}
}

function textInfo(b: Buffer): { chars: number } {
  if (b.includes(0)) throw new AttachError("This file has binary content, so it isn't a text file.")
  let s: string
  try {
    s = new TextDecoder('utf-8', { fatal: true }).decode(b)
  } catch {
    throw new AttachError("This file isn't valid UTF-8 text.")
  }
  return { chars: s.replace(/^\ufeff/, '').length }
}

const MIME: Record<Exclude<Sniffed, null>, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf'
}

// Checks a file's bytes against its name and the limits. Throws AttachError
// with a reason the user can act on.
export function inspect(name: string, b: Buffer): Inspected {
  const ext = extOf(name)
  const sha256 = createHash('sha256').update(b).digest('hex')
  if (!b.length) throw new AttachError('The file is empty.')
  const found = sniff(b)
  const expected = IMAGE_EXT[ext]
  if (expected || found) {
    if (!expected)
      throw new AttachError(
        `The file is ${describeSniffed(found)} but is named .${ext || '(no extension)'}. Rename it to match and attach it again.`
      )
    if (found !== expected)
      throw new AttachError(
        `The file is named .${ext} but its content is ${describeSniffed(found)}, so it wasn't attached.`
      )
    if (found === 'pdf') {
      if (b.length > L.pdfBytes)
        throw new AttachError(
          `PDFs can be up to ${formatBytes(L.pdfBytes)}; this one is ${formatBytes(b.length)}. Split it or attach fewer pages.`
        )
      const info = pdfInfo(b)
      if (info.pages && info.pages > L.pdfPages)
        throw new AttachError(
          `PDFs can have up to ${L.pdfPages} pages; this one has ${info.pages}. Split it into smaller files.`
        )
      return { kind: 'pdf', mime: MIME.pdf, ext, bytes: b.length, sha256, ...info }
    }
    if (b.length > L.imageBytes)
      throw new AttachError(
        `Images can be up to ${formatBytes(L.imageBytes)}; this one is ${formatBytes(b.length)}. Save it smaller and attach it again.`
      )
    const info =
      found === 'png'
        ? pngSize(b)
        : found === 'jpeg'
          ? jpegSize(b)
          : found === 'gif'
            ? gifInfo(b)
            : webpInfo(b)
    if (!info.width || !info.height) short()
    if (info.width > L.imageSide || info.height > L.imageSide)
      throw new AttachError(
        `Images can be up to ${L.imageSide}×${L.imageSide} pixels; this one is ${info.width}×${info.height}.`
      )
    return { kind: 'image', mime: MIME[found], ext, bytes: b.length, sha256, ...info }
  }
  if (!TEXT_EXTENSIONS.includes(ext))
    throw new AttachError(
      `${ext ? `.${ext} files aren't` : "Files without an extension aren't"} supported. Attach images (PNG, JPEG, WebP, GIF), PDFs, or text and code files.`
    )
  if (b.length > L.textBytes)
    throw new AttachError(
      `Text files can be up to ${formatBytes(L.textBytes)}; this one is ${formatBytes(b.length)}. Split it into smaller files rather than have part of it left out.`
    )
  const info = textInfo(b)
  if (info.chars > L.textChars)
    throw new AttachError(
      `Text files can be up to ${L.textChars.toLocaleString('en-US')} characters; this one has ${info.chars.toLocaleString('en-US')}. Split it into smaller files.`
    )
  return { kind: 'text', mime: 'text/plain', ext, bytes: b.length, sha256, ...info }
}
