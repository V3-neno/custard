import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readlinkSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
  type Stats
} from 'fs'
import { randomBytes } from 'crypto'
import { basename, dirname, join, sep } from 'path'

// Race-resistant file and folder creation for targets a model, a user or
// another program can influence (vault notes, memory captures, Design
// exports). Path checks alone run before the write, so another program
// swapping a folder for a link in between could redirect it. Node has no
// openat()/mkdirat(), so this narrows the window instead of closing it:
//
// 1. Resolve the parent folder's real path and ask `guard` about the real
//    target before anything is created.
// 2. Create the file with O_CREAT | O_EXCL (| O_NOFOLLOW where defined).
//    O_EXCL refuses an existing name, including a link, so the final name
//    can't be redirected.
// 3. Before writing any content, check that the file just created is the one
//    at the expected real path (same device and inode, real path unchanged).
//    If not, the parent was swapped: the empty file is removed where it can
//    be found and nothing is written. On Linux it is found through the open
//    handle (/proc/self/fd), which still names it after a swap is undone.
// 4. Write through the open handle, so a later swap can't redirect the bytes.
//
// Folders (`makeDirs`) are made one level at a time from a trusted real
// base, each checked (a real folder, at the expected real path, allowed by
// `guard`) before the next is made inside it.
//
// Residual risk (docs/design/SECURITY-REVIEW.md D3, docs/design/FILESYSTEM.md):
// - macOS and Windows: if a parent folder is swapped for a link and swapped
//   back between steps 2 and 3, an empty file can be left where the link
//   pointed. Linux removes it through /proc/self/fd (tested).
// - Every platform: a folder swapped the same way while `makeDirs` runs can
//   leave an empty folder where the link pointed; nothing is written into it.
// - Removing a stray file is by path after an identity check, so a further
//   swap in that instant could make it remove a different empty file of the
//   same name. Only empty files are ever removed.
// None of it has run on Windows or macOS.

export class FsafeError extends Error {}
// The name is taken (a file, folder or link is already there).
export class FsafeExistsError extends FsafeError {}

// Why a real target path is refused, or null to allow it.
export type Guard = (realTarget: string) => string | null

export type WriteOptions = {
  guard?: Guard
  mode?: number
}

const CREATE =
  constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0)

// The calls tests replace to stage a race at an exact moment.
export const io = {
  open: (path: string, flags: number, mode: number): number => openSync(path, flags, mode),
  mkdir: (path: string, mode: number): void => {
    mkdirSync(path, { mode })
  }
}

const sameFile = (a: Stats, b: Stats): boolean => a.dev === b.dev && a.ino === b.ino

const lstatOrNull = (p: string): Stats | null => {
  try {
    return lstatSync(p)
  } catch {
    return null
  }
}
const realOrNull = (p: string): string | null => {
  try {
    return realpathSync.native(p)
  } catch {
    return null
  }
}

function realParent(path: string): string {
  const real = realOrNull(dirname(path))
  if (!real) throw new FsafeError('The folder to write into does not exist.')
  return real
}

// The name writeReplace gives the file it writes beside the target before
// renaming it over. One left behind by a crash is not part of anything: readers
// of a folder skip it.
export const isAtomicTemp = (name: string): boolean => /^\..+\.[0-9a-f]{12}\.tmp$/.test(name)

function checkName(name: string): void {
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes(sep))
    throw new FsafeError('A file name is required.')
}

// Where the open file actually is, from the kernel (Linux only).
function pathOfFd(fd: number): string | null {
  if (process.platform !== 'linux') return null
  try {
    const p = readlinkSync(`/proc/self/fd/${fd}`)
    return p.endsWith(' (deleted)') ? null : p
  } catch {
    return null
  }
}

// Removes a stray file Custard just created, wherever it can be found, but
// only while it is still that same, still empty file.
function removeStray(fd: number, opened: Stats, candidates: (string | null)[]): void {
  for (const p of [pathOfFd(fd), ...candidates]) {
    if (!p) continue
    const s = lstatOrNull(p)
    if (s && sameFile(s, opened) && s.size === 0) {
      try {
        unlinkSync(p)
        return
      } catch {
        // Try the next way of finding it.
      }
    }
  }
}

function writeAll(fd: number, data: string | Uint8Array): void {
  const buf = typeof data === 'string' ? Buffer.from(data) : data
  let at = 0
  while (at < buf.byteLength) at += writeSync(fd, buf, at)
}

// Steps 2–4 for one name in an already resolved real folder.
function createIn(dir: string, name: string, data: string | Uint8Array, mode: number): string {
  const target = join(dir, name)
  let fd: number
  try {
    fd = io.open(target, CREATE, mode)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EEXIST') throw new FsafeExistsError('A file with that name already exists.')
    if (code === 'ELOOP') throw new FsafeError('That name is a link, so nothing was written.')
    throw err
  }
  try {
    const opened = fstatSync(fd)
    const here = lstatOrNull(target)
    if (!here || !sameFile(here, opened) || realOrNull(dir) !== dir) {
      // Landed somewhere else: remove it if it can still be found.
      const real = realOrNull(target)
      removeStray(fd, opened, [real])
      throw new FsafeError('The folder changed while writing, so nothing was written.')
    }
    writeAll(fd, data)
    try {
      fsyncSync(fd)
    } catch {
      // Best effort.
    }
    return target
  } finally {
    closeSync(fd)
  }
}

// Creates a new file. Refuses an existing name (file or link) and any target
// `guard` refuses by its real location. Returns the real path written.
export function writeNewSync(
  path: string,
  data: string | Uint8Array,
  opts: WriteOptions = {}
): string {
  const dir = realParent(path)
  const name = basename(path)
  checkName(name)
  const refusal = opts.guard?.(join(dir, name))
  if (refusal) throw new FsafeError(refusal)
  return createIn(dir, name, data, opts.mode ?? 0o644)
}

export async function writeNew(
  path: string,
  data: string | Uint8Array,
  opts: WriteOptions = {}
): Promise<string> {
  return writeNewSync(path, data, opts)
}

// Replaces a file, or creates it. The new content goes into a fresh file
// beside it (same race checks as writeNew), which is then renamed over the
// target. rename replaces a link at the target rather than following it.
// The caller asks the user before overwriting.
export function writeReplaceSync(
  path: string,
  data: string | Uint8Array,
  opts: WriteOptions = {}
): string {
  const dir = realParent(path)
  const name = basename(path)
  checkName(name)
  const target = join(dir, name)
  const refusal = opts.guard?.(target)
  if (refusal) throw new FsafeError(refusal)
  const existing = lstatOrNull(target)
  if (existing?.isDirectory()) throw new FsafeError('That name is a folder.')
  const tmp = `.${name}.${randomBytes(6).toString('hex')}.tmp`
  const written = createIn(dir, tmp, data, opts.mode ?? existing?.mode ?? 0o644)
  try {
    if (realOrNull(dir) !== dir)
      throw new FsafeError('The folder changed while writing, so nothing was written.')
    renameSync(written, target)
  } catch (err) {
    try {
      unlinkSync(written)
    } catch {
      // Already gone.
    }
    throw err
  }
  return target
}

export async function writeReplace(
  path: string,
  data: string | Uint8Array,
  opts: WriteOptions = {}
): Promise<string> {
  return writeReplaceSync(path, data, opts)
}

// Like mkdir's own error, so callers treat it as a failure to make a folder.
const notAFolder = (part: string): Error =>
  Object.assign(new Error(`${part} is not a folder, so nothing was written.`), { code: 'ENOTDIR' })

// Makes `parts` as nested folders under `base` (which must exist), one level
// at a time, in place of mkdir -p. Each level, existing or new, must be a
// real folder at the expected real path, or a link `guard` allows by its
// real target. Returns the real path of the deepest folder.
export function makeDirs(
  base: string,
  parts: string[],
  opts: { guard?: Guard; mode?: number } = {}
): string {
  let real = realOrNull(base)
  if (!real) throw new FsafeError('The folder to write into does not exist.')
  for (const part of parts) {
    checkName(part)
    const next = join(real, part)
    const refusal = opts.guard?.(next)
    if (refusal) throw new FsafeError(refusal)
    try {
      io.mkdir(next, opts.mode ?? 0o755)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
    const st = lstatOrNull(next)
    const parentNow = realOrNull(real)
    const nextReal = realOrNull(next)
    if (!st || parentNow !== real || !nextReal)
      throw new FsafeError('The folder changed while writing, so nothing was written.')
    if (st.isSymbolicLink()) {
      // An existing link (a user's own, say): allowed only where it really
      // leads, and only to a folder.
      const why = opts.guard?.(nextReal)
      if (why) throw new FsafeError(why)
      if (!lstatOrNull(nextReal)?.isDirectory()) throw notAFolder(part)
    } else if (!st.isDirectory()) throw notAFolder(part)
    else if (nextReal !== next)
      throw new FsafeError('The folder changed while writing, so nothing was written.')
    real = nextReal
  }
  return real
}
