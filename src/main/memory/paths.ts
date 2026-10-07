import { existsSync, realpathSync } from 'fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'path'

// Where a vault path may point. Shared by the vault tools and by Custard's
// own memory writes so the rules are the same everywhere: inside the vault,
// no hidden folders, .md notes only (unless a folder is asked for), and no
// symlink that leads out of the vault.

export class VaultPathError extends Error {}

const inside = (root: string, p: string): boolean => {
  const rel = relative(root, p)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

// The closest part of `p` that exists, resolved through symlinks.
function realAncestor(p: string): string {
  let cur = p
  while (!existsSync(cur)) {
    const up = dirname(cur)
    if (up === cur) return cur
    cur = up
  }
  return realpathSync(cur)
}

export function resolveInVault(vault: string, path: unknown, mustBeNote = true): string {
  if (typeof path !== 'string' || !path.trim()) throw new VaultPathError('A path is required.')
  const full = resolve(vault, path.trim().replace(/^[/\\]+/, ''))
  const rel = relative(vault, full)
  if (rel.startsWith('..') || isAbsolute(rel))
    throw new VaultPathError('Path is outside the vault.')
  if (rel.split(sep).some((part) => part.startsWith('.')))
    throw new VaultPathError('Hidden folders are off limits.')
  if (mustBeNote && !full.toLowerCase().endsWith('.md'))
    throw new VaultPathError('Only .md notes are allowed.')
  // A symlinked folder or note inside the vault must not lead outside it.
  if (!inside(realpathSync(vault), realAncestor(full)))
    throw new VaultPathError('Path leads outside the vault through a link.')
  return full
}

// A note or folder name made safe for any desktop file system.
export function safeName(name: string, fallback: string): string {
  const cleaned = name
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*#^[\]\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '')
    .slice(0, 80)
  const reserved = /^(con|prn|aux|nul|com\d|lpt\d)$/i
  return cleaned && !reserved.test(cleaned) ? cleaned : fallback
}
