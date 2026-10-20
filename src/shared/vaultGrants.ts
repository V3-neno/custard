// Editable folders: the folders in the vault the user has let Claude change
// without asking about each edit. Nothing is granted by default, and which
// folders get a grant is the user's choice in Settings: core has no list of
// folders that are editable.
//
// Modes nest: create (new notes only) < append (also add to the end of an
// existing note) < edit (also change text in place).

export type GrantMode = 'create' | 'append' | 'edit'
export type VaultGrant = { folder: string; mode: GrantMode }

// Shown in Settings and the automation form. The levels nest, so each help
// line says what the level includes.
export const GRANT_MODES: { id: GrantMode; label: string; help: string }[] = [
  { id: 'create', label: 'New notes', help: 'New notes only. Existing notes stay as they are.' },
  {
    id: 'append',
    label: 'Add to end',
    help: 'New notes, and adding text to the end of existing notes.'
  },
  {
    id: 'edit',
    label: 'Edit text',
    help: 'New notes, adding to the end, and changing text in place. Includes everything Add to end allows.'
  }
]

export const grantLabel = (mode: GrantMode): string =>
  GRANT_MODES.find((m) => m.id === mode)?.label ?? mode

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
// A plugin's event log (Custard/Plugins/<plugin>/Events) is protected too, and
// can't be granted at all: see isEventLogPlace.
const PROTECTED: string[][] = [
  ['custard', 'memory.md'],
  ['custard', 'skills'],
  ['custard', 'captures'],
  ['custard', 'chats']
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
  if (isEventLogPlace(path)) return 4
  return 0
}

// Custard/Plugins/<plugin>/Events, or anything in it: where a plugin's event
// log goes (plugins/eventLog.ts). Only Custard writes there, for the plugin,
// when the user turned the log on; Claude can't be allowed to change it, so
// the log stays a record of what really happened and not what a model wrote.
export function isEventLogPlace(path: string): boolean {
  const p = parts(path)
  return p[0] === 'custard' && p[1] === 'plugins' && p.length >= 4 && p[3] === 'events'
}

// What a note's place says about the text in it, for the outside-text rule:
// 'own' for notes the user or Custard's own flow wrote on purpose (memory and
// skills), 'derived' for notes Custard wrote from chats that may have held
// text from the web or a plugin (captures, chat notes, plugin activity), null for the
// rest of the vault.
export function placeKind(path: string): 'own' | 'derived' | null {
  const p = parts(path)
  if (p[0] !== 'custard') return null
  if (p[1] === 'memory.md' || p[1] === 'skills') return 'own'
  if (p[1] === 'captures' || p[1] === 'chats') return 'derived'
  if (p[1] === 'plugins' && p.length >= 4 && p[3] === 'activity') return 'derived'
  // Event logs hold the plugin's service's text (song titles, names).
  if (p[1] === 'plugins' && p.length >= 4 && p[3] === 'events') return 'derived'
  if (p[1] === 'plugins' && p.length === 4 && p[3] === 'overview.md') return 'own'
  return null
}

// The key one folder is kept under: the same comparison normalizeGrants uses
// to keep one entry per folder.
export const folderKey = (folder: string): string => fold(folder)

// A folder as typed in Settings, tidied the way Windows reads it: "/" or "\"
// between folders, and trailing dots and spaces dropped from each name. A name
// that would be left empty ("." or "..") is kept as typed, so normalizeGrants
// still refuses it.
export function cleanFolderInput(text: string): string {
  return text
    .split(/[\\/]+/)
    .filter(Boolean)
    .map((s) => s.replace(/[. ]+$/, '') || s)
    .join('/')
}

export type GrantNormalization = { grants: VaultGrant[]; dropped: number }

// Cleans what is read from settings or sent from the window: whole entries
// only, folders relative to the vault with no "..", hidden folders, drive
// letters or "~" aliases, no root grant, no plugin event log, one entry per
// folder (the widest mode wins).
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
    if (isEventLogPlace(folder)) {
      dropped++
      continue
    }
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
  // Never, even from a list that didn't go through normalizeGrants.
  if (isEventLogPlace(path)) return null
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
