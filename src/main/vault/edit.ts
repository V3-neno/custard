import { createHash, randomUUID } from 'crypto'
import { promises as fsp, realpathSync } from 'fs'
import { basename, dirname, join } from 'path'
import { resolveInVault } from '../memory/paths'
import type { VaultEdit, VaultRead } from '../../shared/chat'
import type { ToolRun } from '../turn'
import { covers, readNote, toVaultPath, versionOf } from './read'

// vault_edit: replaces one exact passage of a note the model has read, when
// the user asks for it. It can't create, delete, rename or overwrite a note.
//
// What protects the user's note:
// - the passage must appear exactly once, inside what was read, at the
//   version that was read;
// - the version is checked when the edit is asked for, after the user
//   approves, and again just before the write;
// - the previous version is copied to Custard's app data first;
// - the new text goes to a temporary file that is renamed over the note, so
//   the note is either the old one or the new one, never half of each;
// - the note is read back, and anything other than the edit is reported as
//   outcome unknown;
// - Undo only restores the copy when the note is still exactly what the edit
//   left.
// None of this is a lock: another program (Obsidian, a sync client) writing
// the same note between the last check and the rename can still lose one of
// the two changes. The copy makes that recoverable by hand.

export const EDIT_LIMITS = { oldChars: 4_000, newChars: 20_000 }

// Refused before anything was done: recorded as not run.
export class EditRefused extends Error {}

export type EditDeps = {
  writeFile?: (p: string, text: string, flag?: string) => Promise<void>
  rename?: (from: string, to: string) => Promise<void>
  readFile?: (p: string) => Promise<string>
  // For tests: runs at each step, where another program could write.
  at?: (step: 'approved' | 'backup' | 'temp' | 'written') => Promise<void>
  now?: () => number
}

const io = (deps: EditDeps): Required<Omit<EditDeps, 'at'>> & Pick<EditDeps, 'at'> => ({
  writeFile: deps.writeFile ?? ((p, t, flag) => fsp.writeFile(p, t, { flag: flag ?? 'w' })),
  rename: deps.rename ?? fsp.rename,
  readFile: deps.readFile ?? ((p) => fsp.readFile(p, 'utf8')),
  now: deps.now ?? Date.now,
  at: deps.at
})

// A vault's key for its saved copies: the same folder always gets the same one.
export function vaultKey(vault: string): string {
  let real = vault
  try {
    real = realpathSync(vault)
  } catch {
    // Not reachable; the path as given.
  }
  return createHash('sha256').update(real).digest('hex').slice(0, 16)
}

export type Prepared = {
  full: string
  path: string
  text: string
  version: string
  start: number
  end: number
  oldText: string
  newText: string
}

const n = (x: number): string => x.toLocaleString('en-US')

const rangesText = (r: [number, number][]): string =>
  r.map(([a, b]) => `${n(a)}–${n(b)}`).join(', ')

// Checks an edit before the user is asked. Throws EditRefused with the reason.
export async function prepareEdit(
  vault: string,
  input: { path?: unknown; version?: unknown; old_text?: unknown; new_text?: unknown },
  reads: Record<string, VaultRead>
): Promise<Prepared> {
  let full: string
  try {
    full = resolveInVault(vault, input.path)
  } catch (err) {
    throw new EditRefused(err instanceof Error ? err.message : String(err))
  }
  const path = toVaultPath(vault, full)
  if (typeof input.old_text !== 'string' || !input.old_text)
    throw new EditRefused('old_text is required: the exact passage to replace.')
  if (typeof input.new_text !== 'string')
    throw new EditRefused('new_text is required (it may be empty to remove the passage).')
  if (input.old_text === input.new_text)
    throw new EditRefused('new_text is the same as old_text, so there is nothing to change.')
  if (input.old_text.length > EDIT_LIMITS.oldChars)
    throw new EditRefused(
      `old_text is ${n(input.old_text.length)} characters; at most ${n(EDIT_LIMITS.oldChars)} can be replaced at once. Edit a smaller passage.`
    )
  if (input.new_text.length > EDIT_LIMITS.newChars)
    throw new EditRefused(
      `new_text is ${n(input.new_text.length)} characters; at most ${n(EDIT_LIMITS.newChars)} can go in at once.`
    )
  const read = reads[path]
  if (!read)
    throw new EditRefused(
      `${path} hasn't been read in this chat. Read it with vault_read first, then edit it using the version that gives.`
    )
  if (input.version !== read.version)
    throw new EditRefused(
      `version must be the one from your latest vault_read of ${path} (${read.version}).`
    )
  let text: string
  try {
    text = await readNote(full, true)
  } catch (err) {
    throw new EditRefused(err instanceof Error ? err.message : String(err))
  }
  const version = versionOf(text)
  if (version !== read.version)
    throw new EditRefused(
      `${path} has changed since you read it (version ${read.version}; it is now ${version}), possibly in Obsidian or by sync. Read it again and make the edit against the current text.`
    )
  // A note with Windows line endings: the passage is matched and written the same way.
  const crlf = text.includes('\r\n')
  const fix = (s: string): string => (crlf ? s.replace(/\r?\n/g, '\r\n') : s)
  const oldText = fix(input.old_text)
  const newText = fix(input.new_text)
  const at: number[] = []
  for (let i = text.indexOf(oldText); i >= 0 && at.length < 50; i = text.indexOf(oldText, i + 1))
    at.push(i)
  if (!at.length)
    throw new EditRefused(
      `old_text doesn't appear in ${path} exactly as given (spaces, line breaks and punctuation must match). Nothing was changed.`
    )
  if (at.length > 1)
    throw new EditRefused(
      `old_text appears ${at.length >= 50 ? '50 or more' : at.length} times in ${path}. Include more of the surrounding text so it matches exactly once. Nothing was changed.`
    )
  const start = at[0]
  const end = start + oldText.length
  if (start === 0 && end === text.length)
    throw new EditRefused(
      'old_text is the whole note. vault_edit replaces a passage; it never overwrites a whole note.'
    )
  if (!covers(read.ranges, start, end))
    throw new EditRefused(
      `The passage is at characters ${n(start)}–${n(end)}, outside what you read of ${path} (${rangesText(read.ranges)}). Read that part first.`
    )
  return { full, path, text, version, start, end, oldText, newText }
}

const tempFor = (full: string): string =>
  join(dirname(full), `.${basename(full)}.custard-${randomUUID().slice(0, 8)}.tmp`)

const removeQuietly = async (p: string): Promise<void> => {
  try {
    await fsp.unlink(p)
  } catch {
    // Already gone.
  }
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

// Writes `next` over the note through a temporary file, if the note is still
// `expect`. Returns how it went.
async function replaceNote(
  full: string,
  expect: string,
  next: string,
  deps: EditDeps
): Promise<
  | { done: 'not-run'; why: string }
  | { done: 'failed'; why: string }
  | { done: 'unknown'; why: string }
  | { done: 'completed' }
> {
  const f = io(deps)
  const temp = tempFor(full)
  try {
    await f.writeFile(temp, next, 'wx')
  } catch (err) {
    await removeQuietly(temp)
    return { done: 'failed', why: `Couldn't write the new version (${message(err)}).` }
  }
  await f.at?.('temp')
  // The last check, as close to the rename as it can be.
  let now: string
  try {
    now = versionOf(await readNote(full, true))
  } catch (err) {
    await removeQuietly(temp)
    return {
      done: 'not-run',
      why: `The note couldn't be checked just before writing (${message(err)}).`
    }
  }
  if (now !== versionOf(expect)) {
    await removeQuietly(temp)
    return {
      done: 'not-run',
      why: 'The note changed just before the write (another program saved it).'
    }
  }
  try {
    await f.rename(temp, full)
  } catch (err) {
    await removeQuietly(temp)
    return { done: 'failed', why: `Couldn't replace the note (${message(err)}).` }
  }
  await f.at?.('written')
  let back: string
  try {
    back = await f.readFile(full)
  } catch (err) {
    return {
      done: 'unknown',
      why: `The note couldn't be read back after writing (${message(err)}).`
    }
  }
  if (versionOf(back) !== versionOf(next))
    return {
      done: 'unknown',
      why: "Read back after writing, the note doesn't match the edit: another program may have changed it at the same moment."
    }
  return { done: 'completed' }
}

// Ranges read before the edit, moved to where that text is after it.
export function shiftRanges(
  ranges: [number, number][],
  start: number,
  end: number,
  delta: number
): [number, number][] {
  return ranges.map(([a, b]) =>
    b <= start ? [a, b] : a >= end ? [a + delta, b + delta] : [Math.min(a, start), b + delta]
  )
}

export type Applied = { run: ToolRun; edit?: VaultEdit }

// Runs an approved edit. `reads` is updated so the edited note counts as read
// at its new version.
export async function applyEdit(
  vault: string,
  p: Prepared,
  reads: Record<string, VaultRead>,
  historyDir: string,
  deps: EditDeps = {}
): Promise<Applied> {
  const f = io(deps)
  await f.at?.('approved')
  // The user may have taken a while to answer.
  let text: string
  try {
    text = await readNote(p.full, true)
  } catch (err) {
    return {
      run: { content: `${message(err)} Nothing was changed.`, isError: true, outcome: 'not-run' }
    }
  }
  if (versionOf(text) !== p.version)
    return {
      run: {
        content: `${p.path} changed while the edit waited for approval, so it wasn't made. Read it again and redo the edit against the current text.`,
        isError: true,
        outcome: 'not-run'
      }
    }
  // The copy first. Without it, nothing is written.
  const key = vaultKey(vault)
  const dir = join(historyDir, key)
  const stamp = new Date(f.now()).toISOString().replace(/[:.]/g, '-')
  const backup = join(dir, `${stamp}-${randomUUID().slice(0, 8)}-${basename(p.full)}`)
  try {
    await fsp.mkdir(dir, { recursive: true })
    await f.writeFile(backup, p.text, 'wx')
  } catch (err) {
    await removeQuietly(backup)
    return {
      run: {
        content: `Couldn't save a copy of ${p.path} before editing (${message(err)}), so the note wasn't changed.`,
        isError: true,
        outcome: 'failed'
      }
    }
  }
  await f.at?.('backup')
  const next = p.text.slice(0, p.start) + p.newText + p.text.slice(p.end)
  const r = await replaceNote(p.full, p.text, next, deps)
  if (r.done === 'not-run' || r.done === 'failed') {
    await removeQuietly(backup)
    return {
      run: {
        content: `${r.why} ${p.path} wasn't changed.${r.done === 'not-run' ? ' Read it again and redo the edit against the current text.' : ''}`,
        isError: true,
        outcome: r.done
      }
    }
  }
  const after = versionOf(next)
  const edit: VaultEdit = {
    path: p.path,
    vault: key,
    before: p.version,
    after,
    backup,
    at: f.now(),
    ...(r.done === 'unknown' ? { unknown: true } : {})
  }
  if (r.done === 'unknown')
    return {
      run: {
        content: `${r.why} The version from before the edit is saved at ${backup}. Check the note before doing anything else to it.`,
        isError: true,
        outcome: 'unknown'
      },
      edit
    }
  const delta = p.newText.length - p.oldText.length
  const prev = reads[p.path]
  reads[p.path] = {
    version: after,
    ranges: shiftRanges(prev?.ranges ?? [], p.start, p.end, delta),
    at: f.now()
  }
  return {
    run: {
      content: `Edited ${p.path}: replaced ${n(p.oldText.length)} characters at ${n(p.start)} with ${n(p.newText.length)}. The note is now version ${after}; what you read of it still counts, moved to match. The user can undo this from the chat.`,
      isError: false,
      outcome: 'completed'
    },
    edit
  }
}

// Undo: puts the copy back only if the note is still exactly what the edit
// left. Never overwrites a change made since.
export async function undoEdit(
  vault: string,
  e: VaultEdit,
  deps: EditDeps = {}
): Promise<{ ok: boolean; message: string }> {
  const f = io(deps)
  const keep = `The version from before the edit is saved at ${e.backup}.`
  if (e.undone) return { ok: false, message: 'This edit was already undone.' }
  if (vaultKey(vault) !== e.vault)
    return {
      ok: false,
      message: `This edit was made in a different vault from the one connected now, so Custard won't write to it. ${keep}`
    }
  let full: string
  let text: string
  try {
    full = resolveInVault(vault, e.path)
    text = await readNote(full, true)
  } catch (err) {
    return { ok: false, message: `${e.path} can't be read now (${message(err)}). ${keep}` }
  }
  if (versionOf(text) !== e.after)
    return {
      ok: false,
      message: `${e.path} has changed since this edit, so Undo would overwrite the newer changes. Nothing was changed. ${keep}`
    }
  let before: string
  try {
    before = await f.readFile(e.backup)
  } catch (err) {
    return {
      ok: false,
      message: `The saved copy can't be read (${message(err)}), so nothing was changed.`
    }
  }
  if (versionOf(before) !== e.before)
    return {
      ok: false,
      message: `The saved copy at ${e.backup} isn't the version from before the edit any more, so nothing was changed.`
    }
  const r = await replaceNote(full, text, before, deps)
  switch (r.done) {
    case 'completed':
      return { ok: true, message: `Undone: ${e.path} is back to the version from before the edit.` }
    case 'unknown':
      return { ok: false, message: `${r.why} Check ${e.path}. ${keep}` }
    default:
      return { ok: false, message: `${r.why} ${e.path} wasn't changed. ${keep}` }
  }
}
