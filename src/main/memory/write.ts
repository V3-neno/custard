import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { dirname, join } from 'path'
import { resolveInVault } from './paths'
import { hasMarker, section, updateNote, withSection } from './notes'
import { MEMORY_NOTE } from '../../shared/vault'

// Where automatic memory goes, and how it stays readable. Custard only adds
// to its own marked sections; the user can edit or delete anything in them,
// and text outside them is never touched. Old entries are moved, word for
// word, to archive notes rather than deleted.

export const ACTIVITY_NOTE = 'Custard/Activity.md'
export const MEMORY_SECTION = 'remembered'
export const ACTIVITY_SECTION = 'activity'
export const CAPS = { memory: 40, activity: 30 }
// Custard/Activity.md archives to Custard/Activity/2026-10.md, and a
// plugin's Activity.md to an Activity folder beside it.
const activityArchive = (note: string, entry: string): string => {
  const month = /^### (\d{4}-\d{2})-\d{2}/.exec(entry)?.[1]
  return `${note.replace(/\.md$/, '')}/${month ?? 'Earlier'}.md`
}

// Custard/Memory.md archives to Custard/Memory archive.md, a plugin's
// Preferences.md to "Preferences archive.md" beside it.
const listArchive = (note: string): string => note.replace(/\.md$/, ' archive.md')
const listHeading = (note: string): string =>
  `## Remembered by Custard\n\n_Custard adds to this list after chats. Edit or delete anything here; what you delete is not added back. Older items move to [[${listArchive(note).replace(/\.md$/, '')}]]._`
const activityIntro = (title: string): string =>
  `# ${title}\n\nWhat you and Custard did, added after chats. Each entry keeps what was asked, what was tried, what the tool reported and what was seen afterwards apart. Edit or delete anything; older entries move to the Activity folder.\n`

// Splits a section into entries (each starting with a line that matches
// `start`) and whatever came before the first one.
function entries(body: string, start: RegExp): { head: string; items: string[] } {
  const lines = body.split('\n')
  const head: string[] = []
  const items: string[][] = []
  for (const l of lines) {
    if (start.test(l)) items.push([l])
    else if (items.length) items[items.length - 1].push(l)
    else head.push(l)
  }
  return {
    head: head.join('\n').replace(/\n+$/, ''),
    items: items.map((i) => i.join('\n').replace(/\n+$/, ''))
  }
}

type Kind = 'memory' | 'activity'
const START: Record<Kind, RegExp> = { memory: /^- /, activity: /^### / }

function archive(vault: string, path: string, items: string[]): void {
  updateNote(resolveInVault(vault, path), (text) => {
    const missing = items.filter((i) => !(text ?? '').includes(i))
    if (!missing.length) return null
    const base =
      text ??
      `# ${path.replace(/^.*\//, '').replace(/\.md$/, '')}\n\nMoved here by Custard, word for word.\n`
    return `${base.replace(/\n*$/, '\n\n')}${missing.join('\n\n')}\n`
  })
}

// Adds new entries to a note's managed section, unless this capture (by its
// marker) is already there. Returns false when nothing needed writing.
export function addEntries(
  vault: string,
  note: string,
  kind: Kind,
  marker: string,
  newItems: string[],
  title = 'Activity'
): boolean {
  if (!newItems.length) return false
  const full = resolveInVault(vault, note)
  const name = kind === 'memory' ? MEMORY_SECTION : ACTIVITY_SECTION
  const cap = kind === 'memory' ? CAPS.memory : CAPS.activity
  let overflow: string[] = []
  const wrote = updateNote(full, (text) => {
    if (hasMarker(text, marker)) return null
    const current = section(text, name)
    const parsed = entries(current ?? '', START[kind])
    const all = [...parsed.items, ...newItems]
    overflow = all.slice(0, Math.max(0, all.length - cap))
    const kept = all.slice(overflow.length)
    const sep = kind === 'memory' ? '\n' : '\n\n'
    const body = [parsed.head, kept.join(sep)].filter(Boolean).join('\n\n')
    const base = text ?? (kind === 'activity' ? activityIntro(title) : '# Memory\n')
    return withSection(
      base,
      name,
      body,
      current === null && kind === 'memory' ? listHeading(note) : undefined
    )
  })
  // Archived after the main note is written; a crash in between leaves the
  // entries in both places, never in neither.
  if (overflow.length) {
    if (kind === 'memory') archive(vault, listArchive(note), overflow)
    else {
      const byNote = new Map<string, string[]>()
      for (const o of overflow) {
        const p = activityArchive(note, o)
        byNote.set(p, [...(byNote.get(p) ?? []), o])
      }
      for (const [p, items] of byNote) archive(vault, p, items)
    }
  }
  return wrote
}

export const addToMemory = (vault: string, marker: string, lines: string[]): boolean =>
  addEntries(vault, MEMORY_NOTE, 'memory', marker, lines)

// Which notes already hold a capture, so a retry records it as saved.
export function notesWithMarker(vault: string, notes: string[], marker: string): string[] {
  return notes.filter((n) => {
    try {
      const full = resolveInVault(vault, n)
      return existsSync(full) && hasMarker(readFileSync(full, 'utf8'), marker)
    } catch {
      return false
    }
  })
}

// A vault's identity, so a capture waiting for one vault is never written
// into another. Kept in a hidden file the vault tools can't reach.
const ID_FILE = 'Custard/.custard-vault-id'

export function vaultId(vault: string, create: boolean): string | null {
  const file = join(vault, ID_FILE)
  try {
    const id = readFileSync(file, 'utf8').trim()
    if (id) return id
  } catch {
    // Not there yet.
  }
  if (!create) return null
  mkdirSync(dirname(resolveInVault(vault, 'Custard/id.md')), { recursive: true })
  const id = randomUUID()
  try {
    writeFileSync(file, `${id}\n`, { flag: 'wx' })
    return id
  } catch {
    // Another write got there first.
    return readFileSync(file, 'utf8').trim() || null
  }
}

// The latest activity headings, for the system prompt.
export function recentActivity(vault: string, n = 5): string[] {
  try {
    const text = readFileSync(resolveInVault(vault, ACTIVITY_NOTE), 'utf8')
    return entries(section(text, ACTIVITY_SECTION) ?? '', START.activity)
      .items.slice(-n)
      .map((i) => i.split('\n')[0].replace(/^### /, ''))
  } catch {
    return []
  }
}
