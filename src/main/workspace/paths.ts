import { existsSync, lstatSync, realpathSync } from 'fs'
import { join, sep } from 'path'

// Resolves a model-supplied relative path inside a workspace root, and is the
// only way the workspace tools turn input into a filesystem path. It refuses
// absolute paths, "..", symlinks and junctions anywhere on the way, hard-linked
// files for writes, secret-looking files, and any denied folder.
//
// Limitation: checks happen just before each operation. Another program
// swapping a folder for a symlink in between (a race) isn't prevented.

export class PathError extends Error {}

export type Boundary = {
  root: string
  // Absolute folders inside or around the root that are always off limits.
  deny?: string[]
}

// Names that are never readable or writable through workspace tools: VCS
// and dependency folders, and where common tools keep credentials.
const DENIED_NAME =
  /^(\.git|node_modules|\.env.*|.*\.(pem|key|p12|pfx|keystore)|\.ssh|\.aws|\.gnupg|\.docker|\.kube|\.npmrc|\.netrc|_netrc|\.pypirc|\.git-credentials|id_(rsa|dsa|ecdsa|ed25519)(\..*)?)$/i

// Windows 8.3 short names ("GIT~1", "ENV~1") are aliases for long names, so a
// short name could reach a file the long-name checks refuse.
export const SHORT_NAME = /~\d/

const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin'
const norm = (p: string): string => (caseInsensitive ? p.toLowerCase() : p)
export const isInside = (child: string, parent: string): boolean =>
  norm(child) === norm(parent) ||
  norm(child).startsWith(norm(parent.endsWith(sep) ? parent : parent + sep))

const realOrSelf = (p: string): string => {
  try {
    return realpathSync.native(p)
  } catch {
    return p
  }
}

export function splitRelative(rel: unknown): string[] {
  if (typeof rel !== 'string') throw new PathError('A path is required.')
  const p = rel.trim()
  if (p.length > 500 || p.includes('\0')) throw new PathError('That path is not allowed.')
  if (/^([a-zA-Z]:|[\\/]|~)/.test(p) || p.startsWith('\\\\'))
    throw new PathError('Use a path relative to the workspace, not an absolute path.')
  const parts = p.split(/[\\/]+/).filter((s) => s !== '' && s !== '.')
  for (const s of parts) {
    if (s === '..') throw new PathError('".." is not allowed in workspace paths.')
    if (s.includes(':')) throw new PathError('":" is not allowed in file names.')
    // Windows ignores trailing dots and spaces, so "a.env." would be ".env".
    if (/[. ]$/.test(s)) throw new PathError('File names may not end with a dot or space.')
    if (DENIED_NAME.test(s)) throw new PathError(`"${s}" is off limits.`)
    if (SHORT_NAME.test(s))
      throw new PathError(`"${s}" looks like a Windows short name. Use the full name.`)
  }
  return parts
}

export type ResolveOptions = { forWrite?: boolean; mustExist?: boolean }

export function resolveInside(b: Boundary, rel: unknown, o: ResolveOptions = {}): string {
  const parts = splitRelative(rel ?? '')
  if (!existsSync(b.root)) throw new PathError('The workspace folder no longer exists.')
  const root = realpathSync.native(b.root)
  let cur = root
  let i = 0
  for (; i < parts.length; i++) {
    const next = join(cur, parts[i])
    let st: import('fs').Stats
    try {
      st = lstatSync(next)
    } catch {
      break
    }
    if (st.isSymbolicLink()) throw new PathError('Symbolic links and junctions are not followed.')
    if (i < parts.length - 1 && !st.isDirectory())
      throw new PathError(`${parts.slice(0, i + 1).join('/')} is not a folder.`)
    cur = next
  }
  const missing = parts.slice(i)
  if (missing.length && o.mustExist) throw new PathError('Not found.')
  const full = join(cur, ...missing)
  // Belt and braces: the resolved real path of what exists must be inside.
  if (!isInside(realOrSelf(cur), root) || !isInside(full, root))
    throw new PathError('That path is outside the workspace.')
  for (const d of b.deny ?? [])
    if (isInside(full, realOrSelf(d)) || isInside(full, d))
      throw new PathError('That folder is protected.')
  if (o.forWrite && !missing.length) {
    const st = lstatSync(full)
    if (st.isFile() && st.nlink > 1)
      throw new PathError('This file is hard-linked elsewhere, so it is not changed.')
  }
  return full
}

export const toRelative = (root: string, full: string): string =>
  full.slice(realpathSync.native(root).length).split(sep).filter(Boolean).join('/')

export const isDeniedName = (name: string): boolean => DENIED_NAME.test(name)
