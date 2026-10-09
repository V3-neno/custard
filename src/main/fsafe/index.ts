import { constants, promises as fsp, type Stats } from 'fs'
import { randomBytes } from 'crypto'
import { basename, dirname, join } from 'path'

// Race-resistant file creation for model- or user-chosen targets (vault
// notes, Design exports). Path checks alone run before the write, so another
// program swapping a folder for a link in between could redirect it. Node
// has no openat(), so this narrows the window instead of closing it:
//
// 1. Resolve the parent folder's real path and ask `guard` about the real
//    target before anything is created.
// 2. Create the file with O_CREAT | O_EXCL (| O_NOFOLLOW where defined).
//    O_EXCL refuses an existing name, including a link, so the final name
//    can't be redirected.
// 3. Before writing any content, check that the file just created is the one
//    at the expected real path (same device and inode, real path unchanged).
//    If not, the parent was swapped: the empty file is removed where it can
//    be found and nothing is written.
// 4. Write through the open handle, so a later swap can't redirect the bytes.
//
// Residual risk (documented in docs/design/SECURITY-REVIEW.md, D3): if a
// parent folder is swapped for a link and swapped back between steps 1 and
// 3, an empty file can be left wherever the link pointed. No content is ever
// written there. Windows: O_NOFOLLOW doesn't exist, junctions are resolved by
// realpath.native, and inode checks rely on NTFS file ids; none of it has run
// on Windows.

export class FsafeError extends Error {}

// Why a real target path is refused, or null to allow it.
export type Guard = (realTarget: string) => string | null

export type WriteOptions = {
  guard?: Guard
  mode?: number
}

const CREATE =
  constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0)

const sameFile = (a: Stats, b: Stats): boolean => a.dev === b.dev && a.ino === b.ino

async function realParent(path: string): Promise<string> {
  try {
    return await fsp.realpath(dirname(path))
  } catch {
    throw new FsafeError('The folder to write into does not exist.')
  }
}

// Steps 2–4 for one name in an already resolved real folder.
async function createIn(
  dir: string,
  name: string,
  data: string | Uint8Array,
  mode: number
): Promise<string> {
  const target = join(dir, name)
  const fh = await fsp.open(target, CREATE, mode).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'EEXIST') throw new FsafeError('A file with that name already exists.')
    if (err.code === 'ELOOP') throw new FsafeError('That name is a link, so nothing was written.')
    throw err
  })
  try {
    const opened = await fh.stat()
    const here = await fsp.lstat(target).catch(() => null)
    const dirNow = await fsp.realpath(dir).catch(() => null)
    if (!here || !sameFile(here, opened) || dirNow !== dir) {
      // Landed somewhere else: remove it if it can still be found by path.
      const real = await fsp.realpath(target).catch(() => null)
      if (real) {
        const s = await fsp.lstat(real).catch(() => null)
        if (s && sameFile(s, opened)) await fsp.unlink(real).catch(() => {})
      }
      throw new FsafeError('The folder changed while writing, so nothing was written.')
    }
    await fh.writeFile(data)
    await fh.sync().catch(() => {})
    return target
  } finally {
    await fh.close()
  }
}

// Creates a new file. Refuses an existing name (file or link) and any target
// `guard` refuses by its real location. Returns the real path written.
export async function writeNew(
  path: string,
  data: string | Uint8Array,
  opts: WriteOptions = {}
): Promise<string> {
  const dir = await realParent(path)
  const name = basename(path)
  if (!name || name === '.' || name === '..') throw new FsafeError('A file name is required.')
  const refusal = opts.guard?.(join(dir, name))
  if (refusal) throw new FsafeError(refusal)
  return createIn(dir, name, data, opts.mode ?? 0o644)
}

// Replaces a file, or creates it. The new content goes into a fresh file
// beside it (same race checks as writeNew), which is then renamed over the
// target. rename replaces a link at the target rather than following it.
// The caller asks the user before overwriting.
export async function writeReplace(
  path: string,
  data: string | Uint8Array,
  opts: WriteOptions = {}
): Promise<string> {
  const dir = await realParent(path)
  const name = basename(path)
  if (!name || name === '.' || name === '..') throw new FsafeError('A file name is required.')
  const target = join(dir, name)
  const refusal = opts.guard?.(target)
  if (refusal) throw new FsafeError(refusal)
  const existing = await fsp.lstat(target).catch(() => null)
  if (existing?.isDirectory()) throw new FsafeError('That name is a folder.')
  const tmp = `.${name}.${randomBytes(6).toString('hex')}.tmp`
  const written = await createIn(dir, tmp, data, opts.mode ?? existing?.mode ?? 0o644)
  try {
    if ((await fsp.realpath(dir).catch(() => null)) !== dir)
      throw new FsafeError('The folder changed while writing, so nothing was written.')
    await fsp.rename(written, target)
  } catch (err) {
    await fsp.unlink(written).catch(() => {})
    throw err
  }
  return target
}
