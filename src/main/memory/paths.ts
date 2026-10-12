import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from 'fs'
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

// Whether the vault's file system tells "Notes" from "notes" apart. Decided
// from the vault itself (does the same folder answer to a differently cased
// name?), and from the platform when there is nothing to try. Folder grants
// cover only their exact spelling where it does (see shared/vaultGrants).
const sensitivity = new Map<string, boolean>()
export function caseSensitiveVault(vault: string): boolean {
  const known = sensitivity.get(vault)
  if (known !== undefined) return known
  let result = process.platform === 'linux'
  try {
    for (const name of readdirSync(vault)) {
      const swapped = name.replace(/[a-z]/gi, (c) =>
        c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()
      )
      if (swapped === name) continue
      const a = join(vault, name)
      const b = join(vault, swapped)
      if (!existsSync(b)) result = true
      else {
        const x = statSync(a)
        const y = statSync(b)
        result = !(x.ino === y.ino && x.dev === y.dev)
      }
      sensitivity.set(vault, result)
      break
    }
  } catch {
    // Unreadable: the platform's usual answer stands, and is not remembered.
  }
  return result
}

export function resolveInVault(vault: string, path: unknown, mustBeNote = true): string {
  if (typeof path !== 'string' || !path.trim()) throw new VaultPathError('A path is required.')
  if (path.includes('\0')) throw new VaultPathError('A path cannot contain a null character.')
  // A backslash separates folders everywhere, so a path means the same folders to
  // this check, to the grants and to the file system. On Linux and macOS a
  // backslash would otherwise be a letter of a name that the grant check read
  // as a folder boundary.
  const full = resolve(vault, path.trim().replace(/\\/g, '/').replace(/^\/+/, ''))
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
  // Windows drops trailing dots and spaces ("Notes." is "Notes"), so the same
  // name would mean two folders on different systems. Refused everywhere.
  if (parts.some((part) => /[. ]$/.test(part)))
    throw new VaultPathError("Names can't end in a dot or a space.")
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
