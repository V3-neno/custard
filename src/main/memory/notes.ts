import { createHash, randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { basename, dirname, join } from 'path'

// Custard's own writes to vault notes. The user (in Obsidian, or another
// chat) may change a note at any time, so every write reads the note, makes
// its change, and only replaces the file if the note is still exactly what
// was read; otherwise it reads again and retries. Custard only changes text
// between its own markers; everything else in a note is left as it is.

export class ConflictError extends Error {}

const hash = (s: string): string => createHash('sha256').update(s).digest('hex')

export const readNote = (full: string): string | null =>
  existsSync(full) ? readFileSync(full, 'utf8') : null

// Replaces `full` with `next` unless it changed since it was read as `before`.
function replaceIfUnchanged(full: string, before: string | null, next: string): void {
  mkdirSync(dirname(full), { recursive: true })
  const tmp = join(dirname(full), `.${basename(full)}.${randomUUID().slice(0, 8)}.custard-tmp`)
  writeFileSync(tmp, next)
  try {
    const now = readNote(full)
    if ((now === null) !== (before === null) || (now !== null && hash(now) !== hash(before!)))
      throw new ConflictError('The note changed while Custard was writing to it.')
    renameSync(tmp, full)
  } finally {
    rmSync(tmp, { force: true })
  }
}

// Applies `change` to the note's current text (null if it doesn't exist),
// retrying when the note changes underneath. `change` returning null means
// there's nothing to write.
export function updateNote(
  full: string,
  change: (text: string | null) => string | null,
  attempts = 3
): boolean {
  for (let n = 1; ; n++) {
    const before = readNote(full)
    const next = change(before)
    if (next === null || next === before) return false
    try {
      replaceIfUnchanged(full, before, next)
      return true
    } catch (err) {
      if (!(err instanceof ConflictError) || n >= attempts) throw err
    }
  }
}

const begin = (name: string): string => `<!-- custard:begin ${name} -->`
const end = (name: string): string => `<!-- custard:end ${name} -->`

// The text between a managed section's markers, or null without them.
export function section(text: string | null, name: string): string | null {
  if (!text) return null
  const a = text.indexOf(begin(name))
  const b = text.indexOf(end(name), a)
  if (a < 0 || b < 0) return null
  return text
    .slice(a + begin(name).length, b)
    .replace(/^\n/, '')
    .replace(/\n$/, '')
}

// Sets a managed section's body. When the note has no intact section (new
// note, or the user removed a marker), a new one is added at the end and the
// rest of the note is kept as it was.
export function withSection(
  text: string | null,
  name: string,
  body: string,
  heading?: string
): string {
  const block = `${begin(name)}\n${body.replace(/\n+$/, '')}\n${end(name)}`
  const current = text ?? ''
  const a = current.indexOf(begin(name))
  const b = a >= 0 ? current.indexOf(end(name), a) : -1
  if (a >= 0 && b >= 0) return current.slice(0, a) + block + current.slice(b + end(name).length)
  const sep = current && !current.endsWith('\n') ? '\n\n' : current ? '\n' : ''
  return `${current}${sep}${heading ? `${heading}\n\n` : ''}${block}\n`
}

// Whether a capture's marker is already somewhere in the note.
export const hasMarker = (text: string | null, marker: string): boolean =>
  !!text && text.includes(`<!-- custard:capture ${marker} -->`)

export const markerComment = (marker: string): string => `<!-- custard:capture ${marker} -->`
