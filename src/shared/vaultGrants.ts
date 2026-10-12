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

// Compared without case, and without the trailing dots and spaces Windows
// ignores, so "custard/skills." is the skills folder.
const fold = (s: string): string => s.replace(/[. ]+$/, '').toLowerCase()
const parts = (path: string): string[] =>
  path
    .split(/[\\/]+/)
    .filter(Boolean)
    .map(fold)

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
  // Custard/Plugins/<plugin>/Activity
  if (p[0] === 'custard' && p[1] === 'plugins' && p.length >= 4 && p[3] === 'activity') return 4
  return 0
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
// by a grant on that place or something inside it.
export function grantFor(grants: readonly VaultGrant[], path: string): GrantMode | null {
  const p = parts(path)
  const need = protectedDepth(path)
  let best: { len: number; mode: GrantMode } | null = null
  for (const g of grants) {
    const f = parts(g.folder)
    // The folder must contain the note: every folder segment matches, and the
    // note has at least one more segment (a grant on "A" doesn't make "A" a note).
    if (!f.length || f.length >= p.length || !f.every((seg, i) => p[i] === seg)) continue
    if (need && f.length < need) continue
    if (!best || f.length > best.len) best = { len: f.length, mode: g.mode }
  }
  return best?.mode ?? null
}

// True when any grant allows at least this mode: whether to offer a tool.
export const anyGrantAllows = (grants: readonly VaultGrant[], need: GrantMode): boolean =>
  grants.some((g) => modeAllows(g.mode, need))
