import { createHash } from 'crypto'
import { promises as fsp } from 'fs'
import { relative, sep } from 'path'
import { resolveInVault } from '../memory/paths'
import { find, findQuery, FIND_LIMITS, formatFound, outline } from '../textFind'

// vault_read in parts. Each part says which characters of the note it holds,
// whether more follows, and the note's version (a hash of the whole note), so
// a later part can tell when the note changed in between.

export const READ_LIMITS = {
  // Characters per part.
  part: 40_000,
  // A note larger than this isn't read at all.
  maxBytes: 20_000_000
}

export class ReadError extends Error {}

export const versionOf = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12)

export const toVaultPath = (vault: string, full: string): string =>
  relative(vault, full).split(sep).join('/')

// A note's text, or a plain reason it can't be read.
// resolveInVault has already refused a link that leads outside the vault.
export async function readNote(full: string): Promise<string> {
  let size: number
  try {
    const st = await fsp.stat(full)
    if (!st.isFile()) throw new ReadError('Note not found.')
    size = st.size
  } catch (err) {
    if (err instanceof ReadError) throw err
    throw new ReadError('Note not found.')
  }
  if (size > READ_LIMITS.maxBytes)
    throw new ReadError(
      `That note is over ${READ_LIMITS.maxBytes / 1_000_000} MB, too large to read.`
    )
  return fsp.readFile(full, 'utf8')
}

// The part size for a caller whose results are cut at `maxChars` (the whole
// result: header, part and footer). 2,000 characters are left for the header
// and footer; never below 1,000 so a note always moves forward.
export const partSizeFor = (maxChars: number): number =>
  Math.max(1000, Math.min(READ_LIMITS.part, maxChars - 2000))

const n = (x: number): string => x.toLocaleString('en-US')

// Where a part ends: the last line break in the part, unless that would make
// it much shorter, so lines aren't cut in two.
function partEnd(text: string, from: number, size: number): number {
  const max = from + size
  if (max >= text.length) return text.length
  const nl = text.lastIndexOf('\n', max - 1)
  return nl >= from + size / 2 ? nl + 1 : max
}

// `size` is characters per part, at most READ_LIMITS.part. A caller whose
// results are capped (a chat, an unattended run) asks for a part small enough
// that header, part and footer fit, so the cap never cuts the footer off: a
// cut part would lose its tail and the offset to continue from (the next part
// starts after the end the header names).
export async function readPart(
  vault: string,
  input: { path?: unknown; offset?: unknown; version?: unknown; find?: unknown },
  size: number = READ_LIMITS.part
): Promise<string> {
  const full = resolveInVault(vault, input.path)
  const path = toVaultPath(vault, full)
  const text = await readNote(full)
  const version = versionOf(text)
  const offset = input.offset === undefined ? 0 : Number(input.offset)
  if (!Number.isInteger(offset) || offset < 0)
    throw new ReadError('offset must be a whole number of characters, 0 or more.')
  if (typeof input.version === 'string' && input.version && input.version !== version)
    throw new ReadError(
      `${path} changed since the part you read (version ${input.version}; it is now ${version}). What you read before may no longer match. Read it again from the start (offset 0, no version).`
    )
  if (offset > text.length || (offset === text.length && offset > 0))
    throw new ReadError(
      `offset ${n(offset)} is past the end of ${path} (${n(text.length)} characters).`
    )
  // `find` on a long note: the sections that match, each with its offset,
  // and the note's headings, instead of the next part (see textFind).
  const q = input.offset === undefined ? findQuery(input.find) : null
  if (q && text.length > FIND_LIMITS.minText) {
    const found = find(text, q, Math.min(FIND_LIMITS.budget, size))
    if (found)
      return [
        `[${path} · version ${version} · ${n(text.length)} characters · the parts matching "${q}"]`,
        formatFound(found),
        outline(text),
        `[To read around a part, call vault_read with its offset and version "${version}".]`
      ]
        .filter(Boolean)
        .join('\n\n')
  }
  const nothing =
    q && text.length > FIND_LIMITS.minText
      ? `[Nothing in ${path} matched "${q}"; here is its start.]\n`
      : ''
  const end = partEnd(text, offset, Math.max(1, Math.min(size, READ_LIMITS.part)))
  const whole = offset === 0 && end === text.length
  const more = end < text.length
  const head = whole
    ? `[${path} · version ${version} · the whole note, ${n(text.length)} characters]`
    : `[${path} · version ${version} · characters ${n(offset)}–${n(end)} of ${n(text.length)}${more ? ' · more follows' : ' · end of note'}]`
  const foot = more
    ? `\n[Part ends at character ${n(end)} of ${n(text.length)}; more follows. For the next part, call vault_read with offset ${end} and version "${version}".]`
    : ''
  return `${nothing}${head}\n${text.slice(offset, end)}${foot}`
}
