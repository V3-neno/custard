import { randomBytes } from 'crypto'
import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync } from 'fs'
import { open, rename, rm } from 'fs/promises'
import { basename, dirname, join, resolve } from 'path'
import type { ExportResult } from '../../../shared/design'
import { safeFilePath, type ArtifactStore } from '../store'

// Export: the user's own copy of one version, made by Custard (never by the
// page), wherever the user picks, except inside Custard's protected places.
// An export is a separate copy: deleting the chat leaves it alone.
//
// One file (an image, a video, a page with no local files) is saved as that
// file; a page with local files is saved as a new folder, never merged into
// an existing one. New files are created exclusively, so a file or link that
// appears at the target is never written through; replacing a file (after
// the user confirms) writes a fresh file beside it and renames it into
// place, which replaces a link rather than following it.
//
// The writes go through `Writer`, whose shape matches Workstream D's
// race-resistant helper (src/main/fsafe: writeNew, writeReplace with a
// guard on the real target). Until it is on this branch the local fallback
// below is used; its known gap is in docs/design/WORKSPACE.md.

export type Guard = (realTarget: string) => string | null
export type Writer = {
  writeNew: (path: string, data: Uint8Array, opts: { guard?: Guard }) => Promise<string>
  writeReplace: (path: string, data: Uint8Array, opts: { guard?: Guard }) => Promise<string>
}

export type ExportDeps = {
  artifacts: Pick<ArtifactStore, 'get' | 'read'>
  // Where to save; null when the user cancels.
  pick: (a: { defaultName: string; folder: boolean; ext: string }) => Promise<string | null>
  // Asks before replacing an existing file.
  confirmReplace: (path: string) => Promise<boolean>
  // Why a target can't be written (inside a protected place), or null.
  refuse: Guard
  writer?: Writer
}

export class ExportRefused extends Error {}

// The real place a path would land: its nearest existing ancestor resolved,
// plus the rest as written.
export function realTarget(full: string): string {
  let dir = full
  const rest: string[] = []
  while (!existsSync(dir) && !isLink(dir)) {
    const up = dirname(dir)
    if (up === dir) break
    rest.unshift(basename(dir))
    dir = up
  }
  try {
    return join(realpathSync(dir), ...rest)
  } catch {
    return full
  }
}

// Fallback writer: exclusive create with O_NOFOLLOW where the platform has
// it, and the parent's real path checked against the guard just before.
const guarded = (path: string, guard?: Guard): string => {
  const real = join(realpathSync(dirname(path)), basename(path))
  const why = guard?.(real)
  if (why) throw new ExportRefused(why)
  return real
}
async function createExclusive(path: string, data: Uint8Array): Promise<void> {
  const { constants } = await import('fs')
  const flags =
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0)
  const fh = await open(path, flags, 0o644)
  try {
    await fh.writeFile(data)
  } finally {
    await fh.close()
  }
}
export const localWriter: Writer = {
  writeNew: async (path, data, { guard }) => {
    const real = guarded(path, guard)
    await createExclusive(real, data)
    return real
  },
  writeReplace: async (path, data, { guard }) => {
    const real = guarded(path, guard)
    const temp = join(dirname(real), `.${basename(real)}.custard-${randomBytes(6).toString('hex')}`)
    try {
      await createExclusive(temp, data)
      guarded(path, guard)
      await rename(temp, real)
    } finally {
      await rm(temp, { force: true })
    }
    return real
  }
}

const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50) || 'output'

const extOf = (p: string): string => /\.([a-z0-9]+)$/i.exec(p)?.[1].toLowerCase() ?? ''

function isLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

export async function exportVersion(
  deps: ExportDeps,
  chat: string,
  artifactId: string,
  versionId: string
): Promise<ExportResult> {
  const w = deps.writer ?? localWriter
  const a = deps.artifacts.get(chat, artifactId)
  const v = a?.versions.find((x) => x.id === versionId)
  if (!a || !v) return { ok: false, error: 'There is no such version.' }
  if (v.status !== 'succeeded' || !v.files.length)
    return { ok: false, error: 'Only a finished version can be exported.' }

  // Every file read (and hash-checked) before anything is written.
  const files: { path: string[]; bytes: Uint8Array }[] = []
  for (const f of v.files) {
    const bytes = deps.artifacts.read(chat, a.id, v.id, f.path)
    if (!bytes)
      return {
        ok: false,
        error: `${f.path} is missing or changed in Custard's copy, so nothing was exported.`
      }
    files.push({ path: safeFilePath(f.path), bytes: new Uint8Array(bytes) })
  }

  const folder = files.length > 1
  const ext = folder ? '' : extOf(v.files[0].path) || 'bin'
  const defaultName = `${slug(a.name)}-v${v.n}${folder ? '' : `.${ext}`}`
  const picked = await deps.pick({ defaultName, folder, ext })
  if (!picked) return { ok: false, canceled: true }
  const target = resolve(picked)

  const why = deps.refuse(target) ?? deps.refuse(realTarget(target))
  if (why) return { ok: false, error: why }
  const parent = dirname(target)
  if (!existsSync(parent)) return { ok: false, error: 'That folder no longer exists.' }

  try {
    if (folder) {
      if (existsSync(target) || isLink(target))
        return { ok: false, error: `${basename(target)} already exists; choose a new folder name.` }
      mkdirSync(target)
      const made = realpathSync(target)
      // The folder made is where it was meant to be (not swapped for a link).
      if (made !== join(realpathSync(parent), basename(target)) || deps.refuse(made)) {
        return { ok: false, error: 'The folder changed while exporting, so nothing was written.' }
      }
      try {
        for (const f of files) {
          const full = join(target, ...f.path)
          if (f.path.length > 1) mkdirSync(dirname(full), { recursive: true })
          await w.writeNew(full, f.bytes, { guard: deps.refuse })
        }
      } catch (err) {
        // A half-written export folder is removed; it was made just now.
        rmSync(target, { recursive: true, force: true })
        throw err
      }
      return { ok: true, path: target, files: files.length }
    }
    if (existsSync(target) || isLink(target)) {
      if (!isLink(target) && lstatSync(target).isDirectory())
        return { ok: false, error: `${basename(target)} is a folder; choose a file name.` }
      if (!(await deps.confirmReplace(target))) return { ok: false, canceled: true }
      await w.writeReplace(target, files[0].bytes, { guard: deps.refuse })
      return { ok: true, path: target, files: 1 }
    }
    await w.writeNew(target, files[0].bytes, { guard: deps.refuse })
    return { ok: true, path: target, files: 1 }
  } catch (err) {
    if (err instanceof ExportRefused || (err as Error)?.constructor?.name === 'FsafeError')
      return { ok: false, error: (err as Error).message }
    const code = (err as NodeJS.ErrnoException)?.code
    return {
      ok: false,
      error:
        code === 'EEXIST' || code === 'ELOOP'
          ? 'Something appeared at that place while exporting, so nothing was written over it.'
          : `It couldn't be exported: ${err instanceof Error ? err.message : String(err)}`
    }
  }
}
