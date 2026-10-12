import { readdirSync, readFileSync, realpathSync, statSync, unlinkSync } from 'fs'
import { createHash, randomUUID } from 'crypto'
import { basename, dirname, isAbsolute, join, relative, sep } from 'path'
import { FsafeError, FsafeExistsError, makeDirs, writeNewSync, type Guard } from '../fsafe'
import { resolveInVault, safeName } from './paths'

// Where automatic memory goes. Each capture is a new note, created only if
// nothing has that name yet, and Custard never opens it for writing again.
// No note the user might be editing is ever replaced, so a capture can't
// overwrite an edit made in Obsidian or anywhere else. Limits come from how
// much is read back, not from moving or trimming text.

export const CAPTURES = 'Custard/Captures'
export const RETRIEVAL = { notes: 20, chars: 2000, activity: 5 }

// "2026-10-07 1432 Spotify test 3f9a1c2e", the name before any " (2)". The
// last part comes from the capture's job id (chat id and message range), so
// two captures made in the same minute, on this device or another, get
// different names, and a retry of the same capture gets the same one. It
// makes clashes unlikely, not impossible: a sync tool can still make
// conflict copies.
export const captureName = (date: string, time: string, title: string, job: string): string =>
  `${date} ${time.replace(':', '')} ${safeName(title, 'Chat').slice(0, 60)} ${createHash('sha256').update(job).digest('hex').slice(0, 8)}`

// A note's frontmatter, as written by noteText (values are JSON strings).
export function frontmatter(text: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  const out: Record<string, string> = {}
  for (const line of m?.[1].split(/\r?\n/) ?? []) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line)
    if (!kv) continue
    try {
      const v = JSON.parse(kv[2])
      out[kv[1]] = typeof v === 'string' ? v : String(v)
    } catch {
      out[kv[1]] = kv[2].trim()
    }
  }
  return out
}

const read = (full: string): string | null => {
  try {
    return readFileSync(full, 'utf8')
  } catch {
    return null
  }
}

const insideOf = (root: string, p: string): boolean => {
  const rel = relative(root, p)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

// Custard's own vault writes go through the race-resistant helper like the
// vault tools do: Custard choosing the names doesn't make the folders above
// them safe (a folder can be a link, or be swapped for one). Folders are made
// one level at a time and the note created exclusively, each checked to be
// really inside the real vault. See docs/design/FILESYSTEM.md.
export function createNote(vault: string, full: string, text: string): void {
  const realVault = realpathSync(vault)
  const guard: Guard = (real) =>
    insideOf(realVault, real) ? null : 'That path leads outside the vault, so nothing was written.'
  makeDirs(vault, relative(vault, dirname(full)).split(sep).filter(Boolean), { guard })
  writeNewSync(full, text, { guard })
}

// Creates `folder/name.md` (or "name (2).md", …) with exclusive create, so
// an existing file is never replaced. A file already holding this capture
// (same job and plugin: a crash after writing, before it was recorded)
// counts as written. Returns the note's vault path.
export function writeCapture(
  vault: string,
  folder: string,
  name: string,
  text: string,
  key: { job: string; plugin: string }
): string {
  for (let n = 1; n <= 20; n++) {
    const rel = `${folder}/${name}${n > 1 ? ` (${n})` : ''}.md`
    const full = resolveInVault(vault, rel)
    try {
      createNote(vault, full, text)
      return rel
    } catch (err) {
      if (!(err instanceof FsafeExistsError)) throw err
      const fm = frontmatter(read(full) ?? '')
      if (fm['custard-capture'] === key.job && (fm.plugin ?? '') === key.plugin) return rel
    }
  }
  throw new Error('Too many notes with the same name.')
}

// Capture notes in a folder, newest first: by the date and time their
// names start with, then by when the file was last written (captures in the
// same minute), then by name.
export function captureNotes(vault: string, folder = CAPTURES): string[] {
  try {
    const dir = resolveInVault(vault, folder, false)
    return readdirSync(dir)
      .filter((f) => f.endsWith('.md') && !f.startsWith('.'))
      .map((f) => {
        let t = 0n
        try {
          t = statSync(join(dir, f), { bigint: true }).mtimeNs
        } catch {
          // Gone meanwhile.
        }
        return { f, stamp: /^\d{4}-\d{2}-\d{2} \d{4}/.exec(f)?.[0] ?? '', t }
      })
      .sort((a, b) =>
        a.stamp !== b.stamp
          ? a.stamp < b.stamp
            ? 1
            : -1
          : a.t !== b.t
            ? a.t < b.t
              ? 1
              : -1
            : a.f < b.f
              ? 1
              : -1
      )
      .map((x) => `${folder}/${x.f}`)
  } catch {
    return []
  }
}

// A note's "## Heading" sections.
export function sections(text: string): Map<string, string> {
  const out = new Map<string, string>()
  const parts = text.split(/^## /m).slice(1)
  for (const p of parts) {
    const nl = p.indexOf('\n')
    out.set((nl < 0 ? p : p.slice(0, nl)).trim(), nl < 0 ? '' : p.slice(nl + 1).trim())
  }
  return out
}

const bullets = (s = ''): string[] =>
  s
    .split('\n')
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2).trim())

const dateOf = (rel: string): string => /(\d{4}-\d{2}-\d{2})[^/]*$/.exec(rel)?.[1] ?? ''

// Whether a capture note was made from a chat that held text from the web or
// a plugin. New notes say so in their frontmatter (`outside: "true"`); a note
// that doesn't say (made before captures recorded it, or edited) counts as
// made from outside text, because nothing says it wasn't.
export const madeFromOutside = (noteText: string): boolean =>
  frontmatter(noteText).outside !== 'false'

// What later chats are shown: preferences and decisions from the newest
// capture notes, and the newest activity. Read as the notes are now, so an
// edit or deletion in Obsidian is what the assistant sees next time.
export function readCaptures(
  vault: string,
  folder = CAPTURES
): { remembered: string[]; activity: string[]; notes: number; cut: number; outside: boolean } {
  const notes = captureNotes(vault, folder)
  const remembered: string[] = []
  const activity: string[] = []
  let chars = 0
  // Entries left out for length, so the prompt can say so.
  let cut = 0
  let full = false
  // Some note shown was made from a chat that held outside text.
  let outside = false
  for (const [n, rel] of notes.slice(0, RETRIEVAL.notes).entries()) {
    const text = read(resolveInVault(vault, rel))
    if (!text) continue
    const s = sections(text)
    const date = dateOf(rel)
    const fromOutside = madeFromOutside(text)
    for (const line of [
      ...bullets(s.get('Preferences')),
      ...bullets(s.get('Decisions')).map((d) => `Decided: ${d}`)
    ]) {
      const entry = `${date}: ${line}`
      if (full || chars + entry.length > RETRIEVAL.chars) {
        full = true
        cut++
        continue
      }
      chars += entry.length
      remembered.push(entry)
      if (fromOutside) outside = true
    }
    if (n < RETRIEVAL.activity) {
      const before = activity.length
      activity.push(
        ...(s.get('Activity') ?? '')
          .split('\n')
          .filter((l) => l.startsWith('### '))
          .map((l) => `${date} · ${l.slice(4).trim()}`),
        ...bullets(s.get('Still open')).map((u) => `${date} · Open: ${u}`)
      )
      if (fromOutside && activity.length > before) outside = true
    }
  }
  const shown = activity.slice(0, RETRIEVAL.activity * 3)
  return {
    remembered,
    activity: shown,
    notes: notes.length,
    cut: cut + activity.length - shown.length,
    outside
  }
}

// Every capture note Custard saved from one chat, wherever it is under
// Custard/ (plugin folders included), found by its frontmatter. Bounded.
export function chatCaptures(vault: string, chatId: string): string[] {
  const found: string[] = []
  let budget = 5000
  const walk = (rel: string): void => {
    let entries
    try {
      entries = readdirSync(resolveInVault(vault, rel, false), { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (--budget < 0 || e.name.startsWith('.')) continue
      const child = `${rel}/${e.name}`
      if (e.isDirectory()) walk(child)
      else if (e.isFile() && e.name.endsWith('.md')) {
        let full
        try {
          full = resolveInVault(vault, child)
        } catch {
          continue
        }
        const fm = frontmatter(read(full) ?? '')
        if (fm['custard-capture'] && fm.chat === chatId) found.push(child)
      }
    }
  }
  walk('Custard')
  return found.sort()
}

// Deletes the given notes. Returns those that are gone afterwards.
export function deleteNotes(vault: string, notes: string[]): string[] {
  return notes.filter((n) => {
    try {
      // Removed by its real folder, checked to be inside the real vault just
      // before, so a folder swapped for a link isn't followed out of it. A
      // link at the note itself is removed, not followed.
      const full = resolveInVault(vault, n)
      const realDir = realpathSync(dirname(full))
      if (!insideOf(realpathSync(vault), realDir)) return false
      unlinkSync(join(realDir, basename(full)))
      return true
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'ENOENT'
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
  const id = randomUUID()
  try {
    createNote(
      vault,
      join(dirname(resolveInVault(vault, 'Custard/id.md')), basename(ID_FILE)),
      `${id}\n`
    )
    return id
  } catch (err) {
    if (err instanceof FsafeError && !(err instanceof FsafeExistsError)) throw err
    // Another write got there first.
    return readFileSync(file, 'utf8').trim() || null
  }
}
