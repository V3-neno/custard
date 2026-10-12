// Editable folders: the folders in the vault the user has let Claude change
// without asking about each edit. Nothing is granted by default, and which
// folders get a grant is the user's choice in Settings: core has no list of
// folders that are editable.
//
// Modes nest: create (new notes only) < append (also add to the end of an
// existing note) < edit (also change text in place).

export type GrantMode = 'create' | 'append' | 'edit'
export type VaultGrant = { folder: string; mode: GrantMode }

export const GRANT_MODES: { id: GrantMode; label: string; help: string }[] = [
  { id: 'create', label: 'Create', help: 'New notes only' },
  { id: 'append', label: 'Append', help: 'New notes, and adding to the end of notes' },
  { id: 'edit', label: 'Edit', help: 'New notes, adding to notes, and changing text in notes' }
]

const RANK: Record<GrantMode, number> = { create: 0, append: 1, edit: 2 }
export const modeAllows = (have: GrantMode, need: GrantMode): boolean => RANK[have] >= RANK[need]

// Note paths here are vault paths: folders joined with "/". A backslash is
// not a separator here: resolveInVault turns one into "/" before any check, so
// a path reaches this file already split the way the file system will split
// it, and a backslash that is left is just a character of a name.
//
// Compared without case, and without the trailing dots and spaces Windows
// ignores, so "custard/skills." is the skills folder. That is the strict
// reading for protection: it can only protect more. For *covering* a note by a
// grant it is only right where the file system really treats those names as
// the same (Windows, usually macOS); on a case-sensitive file system "notes"
// is another folder than "Notes", so coverage compares exactly there.
const fold = (s: string): string => s.replace(/[. ]+$/, '').toLowerCase()
const split = (path: string): string[] => path.split('/').filter(Boolean)
const parts = (path: string): string[] => split(path).map(fold)

// Notes and folders that stay protected even under a grant on a parent
// folder. A grant covers one of them only when it names that place itself (or
// something inside it). Custard's own memory and skills, its captures, and
// each plugin's activity notes are things other parts of Custard rely on.
const PROTECTED: string[][] = [
  ['custard', 'memory.md'],
  ['custard', 'skills'],
  ['custard', 'captures']
]

// The protected place a note path is in, as the number of leading path
// segments that make it up, or 0.
export function protectedDepth(path: string): number {
  const p = parts(path)
  for (const root of PROTECTED) if (root.every((seg, i) => p[i] === seg)) return root.length
  // Custard/Plugins/<plugin>/Activity, and the plugin's Overview note, which
  // Custard writes and later chats read as background.
  if (p[0] === 'custard' && p[1] === 'plugins' && p.length >= 4 && p[3] === 'activity') return 4
  if (p[0] === 'custard' && p[1] === 'plugins' && p.length === 4 && p[3] === 'overview.md') return 4
  return 0
}

// What a note's place says about the text in it, for the outside-text rule:
// 'own' for notes the user or Custard's own flow wrote on purpose (memory and
// skills), 'derived' for notes Custard wrote from chats that may have held
// text from the web or a plugin (captures, plugin activity), null for the
// rest of the vault.
export function placeKind(path: string): 'own' | 'derived' | null {
  const p = parts(path)
  if (p[0] !== 'custard') return null
  if (p[1] === 'memory.md' || p[1] === 'skills') return 'own'
  if (p[1] === 'captures') return 'derived'
  if (p[1] === 'plugins' && p.length >= 4 && p[3] === 'activity') return 'derived'
  if (p[1] === 'plugins' && p.length === 4 && p[3] === 'overview.md') return 'own'
  return null
}

export type GrantNormalization = { grants: VaultGrant[]; dropped: number }

// Cleans what is read from settings or sent from the window: whole entries
// only, folders relative to the vault with no "..", hidden folders, drive
// letters or "~" aliases, no root grant, one entry per folder (the widest
// mode wins).
export function normalizeGrants(value: unknown): GrantNormalization {
  const list = Array.isArray(value) ? value : []
  const byFolder = new Map<string, VaultGrant>()
  let dropped = 0
  for (const g of list.slice(0, 100)) {
    const r = g as { folder?: unknown; mode?: unknown }
    const mode = r?.mode
    if (
      typeof r?.folder !== 'string' ||
      (mode !== 'create' && mode !== 'append' && mode !== 'edit')
    ) {
      dropped++
      continue
    }
    const segs = r.folder
      .trim()
      .split(/[\\/]+/)
      .filter(Boolean)
    const bad =
      !segs.length ||
      segs.length > 12 ||
      /^[a-z]:$/i.test(segs[0]) ||
      segs.some((s) => s === '.' || s === '..' || s.startsWith('.') || /[:~*?"<>|]/.test(s))
    if (bad) {
      dropped++
      continue
    }
    const folder = segs.join('/')
    const key = fold(folder)
    const had = byFolder.get(key)
    if (!had || RANK[mode] > RANK[had.mode]) byFolder.set(key, { folder, mode })
  }
  return { grants: [...byFolder.values()], dropped }
}

// The mode the grants give a note path (as the vault names it, with "/"), or
// null. The most specific folder wins, and a protected place is covered only
// by a grant on that place or something inside it. `caseSensitive` is whether
// the vault's file system tells "Notes" from "notes" apart (see
// main/memory/paths caseSensitiveVault); when it does, a grant covers only
// the spelling it names. Protection ignores case either way.
export function grantFor(
  grants: readonly VaultGrant[],
  path: string,
  caseSensitive = false
): GrantMode | null {
  const need = protectedDepth(path)
  const seg = caseSensitive ? split : parts
  const p = seg(path)
  let best: { len: number; mode: GrantMode } | null = null
  for (const g of grants) {
    const f = seg(g.folder)
    // The folder must contain the note: every folder segment matches, and the
    // note has at least one more segment (a grant on "A" doesn't make "A" a note).
    if (!f.length || f.length >= p.length || !f.every((s, i) => p[i] === s)) continue
    if (need && f.length < need) continue
    if (!best || f.length > best.len) best = { len: f.length, mode: g.mode }
  }
  return best?.mode ?? null
}

// True when any grant allows at least this mode: whether to offer a tool.
export const anyGrantAllows = (grants: readonly VaultGrant[], need: GrantMode): boolean =>
  grants.some((g) => modeAllows(g.mode, need))
