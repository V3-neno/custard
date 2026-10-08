import { lstatSync, realpathSync } from 'fs'
import { isAbsolute, join, relative, resolve, sep } from 'path'

// Where a vault path may point. Shared by the vault tools and by Custard's
// own memory writes so the rules are the same everywhere: inside the vault,
// no hidden folders, .md notes only (unless a folder is asked for), and no
// symlink that leads out of the vault.

export class VaultPathError extends Error {}

const inside = (root: string, p: string): boolean => {
  const rel = relative(root, p)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

// Checks every part of `rel` below the vault, from the top. A symlink must
// lead to something that exists inside the vault; a broken one (whose target
// doesn't exist yet) is refused, because writing through it would create the
// target wherever it points. Parts that don't exist yet end the walk.
//
// Limitation: this runs just before the write. Another program replacing a
// folder with a link in between (a race) isn't prevented by this check; new
// notes are opened with exclusive create, which doesn't follow a link at the
// note itself, but a swapped parent folder could still be followed.
function checkLinks(vault: string, realVault: string, rel: string): void {
  let cur = vault
  for (const part of rel.split(sep).filter(Boolean)) {
    cur = join(cur, part)
    let st: import('fs').Stats
    try {
      st = lstatSync(cur)
    } catch {
      return
    }
    if (!st.isSymbolicLink()) continue
    let target: string
    try {
      target = realpathSync(cur)
    } catch {
      throw new VaultPathError('Path goes through a broken link.')
    }
    if (!inside(realVault, target))
      throw new VaultPathError('Path leads outside the vault through a link.')
  }
}

export function resolveInVault(vault: string, path: unknown, mustBeNote = true): string {
  if (typeof path !== 'string' || !path.trim()) throw new VaultPathError('A path is required.')
  const full = resolve(vault, path.trim().replace(/^[/\\]+/, ''))
  const rel = relative(vault, full)
  if (rel.startsWith('..') || isAbsolute(rel))
    throw new VaultPathError('Path is outside the vault.')
  const parts = rel.split(sep)
  if (parts.some((part) => part.startsWith('.')))
    throw new VaultPathError('Hidden folders are off limits.')
  // "a.md:x" names a hidden stream on Windows; "OBSIDI~1" is a short alias
  // that could reach a hidden folder.
  if (parts.some((part) => part.includes(':')))
    throw new VaultPathError('":" is not allowed in note paths.')
  if (parts.some((part) => /~\d/.test(part)))
    throw new VaultPathError('That looks like a Windows short name. Use the full name.')
  if (mustBeNote && !full.toLowerCase().endsWith('.md'))
    throw new VaultPathError('Only .md notes are allowed.')
  // A symlinked folder or note inside the vault must not lead outside it,
  // and a broken one must not be written through.
  checkLinks(vault, realpathSync(vault), rel)
  return full
}

// A note or folder name made safe for any desktop file system.
export function safeName(name: string, fallback: string): string {
  const cleaned = name
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*#^[\]\u0000-\u001f]/g, ' ')
    // No "." or ".." left as a word of the name.
    .replace(/(^|\s)\.+(?=\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '')
    .slice(0, 80)
  const reserved = /^(con|prn|aux|nul|com\d|lpt\d)$/i
  return cleaned && !reserved.test(cleaned) ? cleaned : fallback
}
