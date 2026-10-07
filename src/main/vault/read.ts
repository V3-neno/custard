import { createHash } from 'crypto'
import { promises as fsp } from 'fs'
import { relative, sep } from 'path'
import { resolveInVault } from '../memory/paths'
import type { VaultRead } from '../../shared/chat'

// vault_read in parts. Each part says which characters of the note it holds,
// whether more follows, and the note's version (a hash of the whole note), so
// a later part, or an edit, can tell when the note changed in between.

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
// resolveInVault has already refused a link that leads outside the vault;
// `noLink` refuses any link (an edit would replace the link with a file).
export async function readNote(full: string, noLink = false): Promise<string> {
  let size: number
  try {
    const st = await (noLink ? fsp.lstat(full) : fsp.stat(full))
    if (st.isSymbolicLink())
      throw new ReadError("That note is a link to another file, so Custard won't edit it.")
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

// Sorted, merged character ranges.
export function addRange(ranges: [number, number][], r: [number, number]): [number, number][] {
  const all = [...ranges, r].sort((a, b) => a[0] - b[0])
  const out: [number, number][] = []
  for (const [a, b] of all) {
    const last = out[out.length - 1]
    if (last && a <= last[1]) last[1] = Math.max(last[1], b)
    else out.push([a, b])
  }
  return out
}

export const covers = (ranges: [number, number][], a: number, b: number): boolean =>
  ranges.some(([x, y]) => x <= a && b <= y)

const n = (x: number): string => x.toLocaleString('en-US')

// Where a part ends: the last line break in the part, unless that would make
// it much shorter, so lines aren't cut in two.
function partEnd(text: string, from: number): number {
  const max = from + READ_LIMITS.part
  if (max >= text.length) return text.length
  const nl = text.lastIndexOf('\n', max - 1)
  return nl >= from + READ_LIMITS.part / 2 ? nl + 1 : max
}

export async function readPart(
  vault: string,
  input: { path?: unknown; offset?: unknown; version?: unknown },
  reads: Record<string, VaultRead>,
  now = Date.now
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
  const end = partEnd(text, offset)
  // Reads at another version describe a different text, so they're dropped.
  const prev = reads[path]
  reads[path] = {
    version,
    ranges: addRange(prev?.version === version ? prev.ranges : [], [offset, end]),
    at: now()
  }
  const whole = offset === 0 && end === text.length
  const more = end < text.length
  const head = whole
    ? `[${path} · version ${version} · the whole note, ${n(text.length)} characters]`
    : `[${path} · version ${version} · characters ${n(offset)}–${n(end)} of ${n(text.length)}${more ? ' · more follows' : ' · end of note'}]`
  const foot = more
    ? `\n[Part ends at character ${n(end)} of ${n(text.length)}; more follows. For the next part, call vault_read with offset ${end} and version "${version}".]`
    : ''
  return `${head}\n${text.slice(offset, end)}${foot}`
}
