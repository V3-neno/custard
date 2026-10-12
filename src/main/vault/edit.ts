import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync } from 'fs'
import { join } from 'path'
import { resolveInVault } from '../memory/paths'
import { realTarget } from '../modes/extensions'
import { FsafeError, writeNewSync, writeReplaceSync, type Guard } from '../fsafe'
import { readNote, toVaultPath, versionOf, ReadError } from './read'
import { grantFor, modeAllows, type GrantMode, type VaultGrant } from '../../shared/vaultGrants'
import type { ToolRun } from '../turn'

// Changing notes that already exist, inside folders the user granted: add to
// the end of a note, or change it in place. Never an overwrite of the whole
// note, never a delete or rename. Every change is checked against the note's
// version, written in one atomic replace, and recorded so it can be undone.
//
// Limitation (accepted): a check just before the write can't see a program
// that saves the same note at the same moment, such as an editor with
// unsaved changes. The version check catches changes already saved.

export const EDIT_LIMITS = {
  edits: 20,
  // Characters in one edit's text.
  editChars: 20_000,
  // A note longer than this isn't edited by Claude.
  noteChars: 200_000
}

export class VaultEditError extends Error {}

// What one call may do. Positions are in the text as it was read: each edit is
// matched against that text, not against the result of the edits before it.
export type NoteEdit =
  | { type: 'replace'; old_text: string; new_text: string }
  | { type: 'insert_after_heading'; heading: string; text: string }
  | { type: 'append'; text: string }

type Change = { start: number; end: number; text: string; order: number }

const lineStarts = (text: string): number[] => {
  const starts = [0]
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1)
  return starts
}

type Heading = { level: number; title: string; start: number }

// ATX headings outside fenced code blocks.
function headings(text: string): Heading[] {
  const out: Heading[] = []
  const starts = lineStarts(text)
  let fence: string | null = null
  for (let n = 0; n < starts.length; n++) {
    const start = starts[n]
    const end = n + 1 < starts.length ? starts[n + 1] : text.length
    const line = text.slice(start, end).replace(/\r?\n$/, '')
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (f) {
      if (fence === null) fence = f[1][0]
      else if (f[1][0] === fence) fence = null
      continue
    }
    if (fence !== null) continue
    const h = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/.exec(line)
    if (h) out.push({ level: h[1].length, title: h[2], start })
  }
  return out
}

// The offset just after the last non-blank line of the section that starts at
// heading `i`: before the next heading of the same or a higher level, and
// before the blank lines that precede it.
function sectionEnd(text: string, all: Heading[], i: number): number {
  const h = all[i]
  const next = all.slice(i + 1).find((x) => x.level <= h.level)
  const limit = next ? next.start : text.length
  const nl = text.indexOf('\n', h.start)
  const headEnd = nl === -1 ? text.length : Math.min(nl + 1, limit)
  let end = limit
  while (end > headEnd) {
    const prevStart = text.lastIndexOf('\n', end - 2) + 1
    if (text.slice(prevStart, end).trim() !== '') break
    end = Math.max(prevStart, headEnd)
  }
  return end
}

const withNewline = (s: string): string => (s.endsWith('\n') ? s : `${s}\n`)

// Applies every edit to `text`, or throws and applies none.
export function applyEdits(text: string, edits: NoteEdit[]): string {
  if (!edits.length) throw new VaultEditError('There are no edits to make.')
  if (edits.length > EDIT_LIMITS.edits)
    throw new VaultEditError(`At most ${EDIT_LIMITS.edits} edits in one call.`)
  const changes: Change[] = []
  const all = headings(text)
  edits.forEach((e, order) => {
    const at = `Edit ${order + 1}`
    const str = (v: unknown, name: string): string => {
      if (typeof v !== 'string') throw new VaultEditError(`${at}: ${name} must be text.`)
      if (v.length > EDIT_LIMITS.editChars)
        throw new VaultEditError(`${at}: ${name} is over ${EDIT_LIMITS.editChars} characters.`)
      return v
    }
    switch (e?.type) {
      case 'replace': {
        const old = str(e.old_text, 'old_text')
        const next = str(e.new_text, 'new_text')
        if (!old) throw new VaultEditError(`${at}: old_text can't be empty.`)
        const first = text.indexOf(old)
        if (first === -1)
          throw new VaultEditError(
            `${at}: old_text was not found in the note. It must match the note's text exactly.`
          )
        if (text.indexOf(old, first + 1) !== -1)
          throw new VaultEditError(
            `${at}: old_text matches more than once. Include more of the surrounding text so it matches once.`
          )
        changes.push({ start: first, end: first + old.length, text: next, order })
        return
      }
      case 'insert_after_heading': {
        const heading = str(e.heading, 'heading')
        const body = str(e.text, 'text')
        const want = /^\s{0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/.exec(heading.trim())
        if (!want)
          throw new VaultEditError(
            `${at}: heading must be a whole heading line such as "## Log", with its # marks.`
          )
        const hits = all
          .map((h, i) => ({ h, i }))
          .filter(({ h }) => h.level === want[1].length && h.title === want[2])
        if (!hits.length)
          throw new VaultEditError(`${at}: no heading "${heading.trim()}" in the note.`)
        if (hits.length > 1)
          throw new VaultEditError(
            `${at}: "${heading.trim()}" appears ${hits.length} times, so it is not clear where to insert.`
          )
        const pos = sectionEnd(text, all, hits[0].i)
        const lead = pos > 0 && text[pos - 1] !== '\n' ? '\n' : ''
        changes.push({ start: pos, end: pos, text: lead + withNewline(body), order })
        return
      }
      case 'append': {
        const body = str(e.text, 'text')
        const lead = text.length && !text.endsWith('\n') ? '\n' : ''
        changes.push({
          start: text.length,
          end: text.length,
          text: lead + withNewline(body),
          order
        })
        return
      }
      default:
        throw new VaultEditError(
          `${at}: type must be "replace", "insert_after_heading" or "append".`
        )
    }
  })
  // Edits must not overlap. Inserts at the same place keep the order given.
  const sorted = [...changes].sort(
    (a, b) => a.start - b.start || a.end - b.end || a.order - b.order
  )
  for (let i = 1; i < sorted.length; i++)
    if (sorted[i].start < sorted[i - 1].end)
      throw new VaultEditError(
        `Edits ${sorted[i - 1].order + 1} and ${sorted[i].order + 1} change overlapping text.`
      )
  let out = ''
  let at = 0
  for (const c of sorted) {
    out += text.slice(at, c.start) + c.text
    at = c.end
  }
  return out + text.slice(at)
}

// A note's leading "---" block. A heuristic, not a YAML parser: it checks the
// block is closed and that every line looks like part of a mapping or list.
const FRONT = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

function frontmatterProblem(before: string, after: string): string | null {
  const had = FRONT.test(before)
  const m = FRONT.exec(after)
  if (had && !m) return "The edit would break the note's frontmatter (the --- block at the top)."
  if (!m)
    return /^---[ \t]*\r?\n/.test(after) ? 'The note would start an unclosed --- block.' : null
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line) || /^\s+\S/.test(line) || /^\s*-\s/.test(line)) continue
    if (!/^[A-Za-z0-9_][\w .-]*:(\s|$)/.test(line))
      return `The edit would leave a line in the frontmatter that isn't "key: value": ${line.slice(0, 60)}`
  }
  return null
}

// What changed, for the activity list: the text between what the old and new
// notes share at the start and the end.
export function summarizeChange(
  before: string,
  after: string
): { removed: string; added: string; truncated: boolean } {
  let a = 0
  const max = Math.min(before.length, after.length)
  while (a < max && before[a] === after[a]) a++
  let b = 0
  while (b < max - a && before[before.length - 1 - b] === after[after.length - 1 - b]) b++
  const cap = 4000
  const removed = before.slice(a, before.length - b)
  const added = after.slice(a, after.length - b)
  return {
    removed: removed.slice(0, cap),
    added: added.slice(0, cap),
    truncated: removed.length > cap || added.length > cap
  }
}

// --- records and undo -------------------------------------------------------

export type EditRecord = {
  id: string
  time: number
  // Who asked: a chat, later an automation.
  source: string
  kind: 'create' | 'append' | 'edit'
  path: string
  chars: number
  // Present for append and edit: what undo needs and shows.
  before?: string
  beforeVersion?: string
  afterVersion?: string
  change?: ReturnType<typeof summarizeChange>
  undone?: number
}

// Chats and automations share this list.
export const KEEP_RECORDS = 200

const recordFile = (dir: string, id: string): string => join(dir, `${id}.json`)

export function recordEdit(dir: string, rec: Omit<EditRecord, 'id' | 'time'>): EditRecord {
  mkdirSync(dir, { recursive: true })
  const full: EditRecord = { id: randomUUID(), time: Date.now(), ...rec }
  writeNewSync(recordFile(dir, full.id), JSON.stringify(full))
  const all = listEdits(dir)
  for (const old of all.slice(KEEP_RECORDS)) rmSync(recordFile(dir, old.id), { force: true })
  return full
}

// Newest first. Unreadable records are skipped.
export function listEdits(dir: string): EditRecord[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => /^[\w-]+\.json$/.test(f))
    .flatMap((f) => {
      try {
        const r = JSON.parse(readFileSync(join(dir, f), 'utf8')) as EditRecord
        return typeof r.id === 'string' && typeof r.time === 'number' ? [r] : []
      } catch {
        return []
      }
    })
    .sort((x, y) => y.time - x.time)
}

export type EditContext = {
  grants: readonly VaultGrant[]
  // Where records go (a folder in app data, not in the vault).
  recordsDir: string
  source: string
  // Mode and extension protection, checked on the real place written.
  guard?: Guard
}

const fail = (content: string, outcome: ToolRun['outcome'] = 'not-run'): ToolRun => ({
  content,
  isError: true,
  outcome
})

// The note's path as the vault names it, with what the grants allow there.
// Checked on the path as given and on where it really leads, so a link inside
// a granted folder can't reach a place the grants don't cover.
function grantedMode(
  vault: string,
  full: string,
  grants: readonly VaultGrant[]
): { path: string; mode: GrantMode | null } {
  const path = toVaultPath(vault, full)
  const real = toVaultPath(realpathSync(vault), realTarget(full))
  const a = grantFor(grants, path)
  const b = grantFor(grants, real)
  const mode = a && b ? (modeAllows(a, b) ? b : a) : null
  return { path, mode }
}

// Whether `path` is in a granted folder, for any mode: chat uses this to skip
// the approval card for a new note.
export function createGranted(
  vault: string,
  path: unknown,
  grants: readonly VaultGrant[]
): boolean {
  try {
    const full = resolveInVault(vault, path)
    return grantedMode(vault, full, grants).mode !== null
  } catch {
    return false
  }
}

const NOT_GRANTED = (path: string, need: GrantMode): string =>
  `${path} isn't in a folder the user has allowed you to ${need === 'edit' ? 'edit' : 'add to'}, so nothing was done. Offer to save it as a new note instead, or ask the user to add the folder under Settings → Obsidian vault → Editable folders.`

type Plan = {
  full: string
  path: string
  edits: NoteEdit[]
  before: string
  after: string
  beforeVersion: string
}

// Everything a change needs decided before anything is written: that the path
// is allowed, the version is current, every edit applies, and the result is
// sound. Returns the change, or a refusal.
async function planChange(
  vault: string,
  name: 'vault_append' | 'vault_edit',
  input: { path?: unknown; text?: unknown; edits?: unknown; version?: unknown },
  ctx: Pick<EditContext, 'grants'>
): Promise<Plan | ToolRun> {
  const full = resolveInVault(vault, input.path)
  const need: GrantMode = name === 'vault_edit' ? 'edit' : 'append'
  const { path, mode } = grantedMode(vault, full, ctx.grants)
  if (!mode || !modeAllows(mode, need)) return fail(NOT_GRANTED(path, need))
  if (!existsSync(full))
    return fail(`${path} doesn't exist, so there is nothing to change. Create it as a new note.`)

  let edits: NoteEdit[]
  if (name === 'vault_append') {
    if (typeof input.text !== 'string' || !input.text.trim())
      throw new VaultEditError('text is required.')
    edits = [{ type: 'append', text: input.text }]
  } else {
    if (!Array.isArray(input.edits)) throw new VaultEditError('edits must be a list.')
    if (typeof input.version !== 'string' || !input.version)
      throw new VaultEditError(
        'version is required: the version from vault_read for the note as you read it.'
      )
    edits = input.edits as NoteEdit[]
  }

  let before: string
  try {
    before = await readNote(full)
  } catch (err) {
    if (err instanceof ReadError) return fail(err.message)
    throw err
  }
  if (before.length > EDIT_LIMITS.noteChars)
    return fail(`${path} is over ${EDIT_LIMITS.noteChars} characters, too long to change safely.`)
  const beforeVersion = versionOf(before)
  if (name === 'vault_edit' && input.version !== beforeVersion)
    return fail(
      `${path} changed since you read it (you have version ${String(input.version)}; it is now ${beforeVersion}). Read it again with vault_read and redo the edit from what you read.`
    )

  const after = applyEdits(before, edits)
  if (after.length > EDIT_LIMITS.noteChars)
    return fail(
      `The note would be over ${EDIT_LIMITS.noteChars} characters, so nothing was changed.`
    )
  const problem = frontmatterProblem(before, after)
  if (problem) return fail(`${problem} Nothing was changed.`)
  if (after === before) return fail('The edits change nothing, so nothing was written.')
  return { full, path, edits, before, after, beforeVersion }
}

const isPlan = (x: Plan | ToolRun): x is Plan => 'after' in x

// What a change will do, for the user to approve first: the note and what
// would be removed and added. A change that would be refused is refused here,
// without asking. Nothing is written.
export async function previewChange(
  vault: string,
  name: 'vault_append' | 'vault_edit',
  input: { path?: unknown; text?: unknown; edits?: unknown; version?: unknown },
  ctx: Pick<EditContext, 'grants'>
): Promise<{ label: string; detail: string } | ToolRun> {
  const plan = await planChange(vault, name, input, ctx)
  if (!isPlan(plan)) return plan
  const change = summarizeChange(plan.before, plan.after)
  return {
    label: `${name === 'vault_edit' ? 'Edit' : 'Add to'} ${plan.path}`,
    detail: [
      `${name === 'vault_edit' ? 'Edit' : 'Add to'} ${plan.path} (${plan.edits.length} ${plan.edits.length === 1 ? 'change' : 'changes'}).`,
      '',
      ...(change.removed ? [`Removed:`, change.removed, ''] : []),
      ...(change.added ? [`Added:`, change.added] : []),
      ...(change.truncated ? ['', '(Long: only the start of each part is shown.)'] : [])
    ].join('\n')
  }
}

// vault_append and vault_edit.
export async function changeNote(
  vault: string,
  name: 'vault_append' | 'vault_edit',
  input: { path?: unknown; text?: unknown; edits?: unknown; version?: unknown },
  ctx: EditContext
): Promise<ToolRun> {
  const plan = await planChange(vault, name, input, ctx)
  if (!isPlan(plan)) return plan
  const { full, path, before, after, beforeVersion } = plan

  // The note must still be what was read, just before it is replaced.
  try {
    if (versionOf(await readNote(full)) !== beforeVersion)
      return fail(
        `${path} changed while the edit was being made, so nothing was changed. Read it again.`
      )
    writeReplaceSync(full, after, {
      guard: (real) => ctx.guard?.(real) ?? null
    })
  } catch (err) {
    if (err instanceof FsafeError)
      return fail(
        /nothing was/i.test(err.message) ? err.message : `${err.message} Nothing was changed.`
      )
    return fail(
      `Couldn't change the note: ${err instanceof Error ? err.message : String(err)}`,
      'failed'
    )
  }
  const afterVersion = versionOf(after)
  try {
    recordEdit(ctx.recordsDir, {
      source: ctx.source,
      kind: name === 'vault_edit' ? 'edit' : 'append',
      path,
      chars: after.length,
      before,
      beforeVersion,
      afterVersion,
      change: summarizeChange(before, after)
    })
  } catch (err) {
    // The note is changed; only its undo record is missing. Say so.
    return {
      content: `Changed ${path} (now version ${afterVersion}), but its undo record could not be saved: ${err instanceof Error ? err.message : String(err)}`,
      isError: false
    }
  }
  return { content: `Changed ${path} (now version ${afterVersion}).`, isError: false }
}

// A new note in a granted folder was created: keep a record of it (it has no
// undo, because nothing is ever deleted).
export function recordCreated(
  ctx: Pick<EditContext, 'recordsDir' | 'source'>,
  path: string,
  chars: number
): void {
  try {
    recordEdit(ctx.recordsDir, { source: ctx.source, kind: 'create', path, chars })
  } catch {
    // The note exists; the activity list is a help.
  }
}

// Puts a note back as it was before one of Custard's edits, if it hasn't
// changed since.
export function undoEdit(
  vault: string,
  recordsDir: string,
  id: string,
  guard?: Guard
): { ok: boolean; message: string } {
  const rec = listEdits(recordsDir).find((r) => r.id === id)
  if (!rec || rec.before === undefined || rec.afterVersion === undefined)
    return { ok: false, message: 'There is nothing to undo for that entry.' }
  if (rec.undone) return { ok: false, message: 'That change was already undone.' }
  let full: string
  try {
    full = resolveInVault(vault, rec.path)
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
  let now: string
  try {
    now = readFileSync(full, 'utf8')
  } catch {
    return { ok: false, message: `${rec.path} can't be read now, so it was left alone.` }
  }
  if (versionOf(now) !== rec.afterVersion)
    return {
      ok: false,
      message: `${rec.path} has changed since this edit, so it was left alone. Restore it from your own history if you need the old text.`
    }
  try {
    writeReplaceSync(full, rec.before, { guard: (real) => guard?.(real) ?? null })
    writeReplaceSync(recordFile(recordsDir, rec.id), JSON.stringify({ ...rec, undone: Date.now() }))
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
  return { ok: true, message: `Restored ${rec.path}.` }
}
