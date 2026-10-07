import { randomUUID } from 'crypto'
import { promises as fsp } from 'fs'
import { join } from 'path'
import {
  ATTACHMENT_LIMITS,
  type Attachment,
  type AttachResult,
  type DraftAttachment
} from '../../shared/attachments'
import { AttachError, displayName, inspect } from './inspect'
import { createHash } from 'crypto'

// Attached files, copied into Custard's app data so a chat reopens the same
// way even if the original moves. Each copy is written once under a random
// name and made read-only; the original name is kept only for display.
//   <root>/drafts/<draft id>/<id>.<ext>   picked, not sent yet
//   <root>/<chat id>/<id>.<ext>           sent with a chat message
// Nothing here is uploaded anywhere.

export class AttachmentMissing extends Error {}

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp'
}

const withoutKey = <T extends object, K extends keyof T>(o: T, k: K): Omit<T, K> => {
  const copy = { ...o }
  delete copy[k]
  return copy
}

const ID = /^[a-zA-Z0-9-]{8,64}$/
const checkId = (id: string, what: string): string => {
  if (!ID.test(id)) throw new Error(`Bad ${what} id.`)
  return id
}

// The most any single attached file can be, whatever its type.
const MAX_FILE = Math.max(
  ATTACHMENT_LIMITS.imageBytes,
  ATTACHMENT_LIMITS.pdfBytes,
  ATTACHMENT_LIMITS.textBytes
)

export class AttachmentStore {
  constructor(private readonly root: string) {}

  private draftDir = (draft: string): string => join(this.root, 'drafts', checkId(draft, 'draft'))
  private chatDir = (chat: string): string => join(this.root, checkId(chat, 'chat'))
  private file = (dir: string, a: { id: string; ext: string }): string =>
    join(dir, `${checkId(a.id, 'file')}${a.ext ? `.${a.ext.replace(/[^a-z0-9]/g, '')}` : ''}`)

  // Checks and copies one file into a draft. Never throws for a bad file: the
  // reason comes back for the composer to show.
  async addBytes(draft: string, name: string, bytes: Buffer): Promise<AttachResult> {
    const shown = displayName(name)
    try {
      const info = inspect(name, bytes)
      const dir = this.draftDir(draft)
      await fsp.mkdir(dir, { recursive: true })
      const existing = await this.listDraft(draft)
      if (existing.length >= ATTACHMENT_LIMITS.perMessage)
        throw new AttachError(`A message can carry up to ${ATTACHMENT_LIMITS.perMessage} files.`)
      const total = existing.reduce((n, a) => n + a.bytes, 0) + info.bytes
      if (total > ATTACHMENT_LIMITS.messageBytes)
        throw new AttachError(
          `The files on one message can add up to ${ATTACHMENT_LIMITS.messageBytes / 1_000_000} MB; this would make ${(total / 1_000_000).toFixed(1)} MB.`
        )
      const attachment: DraftAttachment = { id: randomUUID(), name: shown, draft, ...info }
      const path = this.file(dir, attachment)
      await fsp.writeFile(path, bytes, { flag: 'wx', mode: 0o444 })
      await fsp.writeFile(`${path}.json`, JSON.stringify(attachment), { flag: 'wx', mode: 0o444 })
      return { ok: true, attachment }
    } catch (err) {
      if (err instanceof AttachError) return { ok: false, name: shown, error: err.message }
      return {
        ok: false,
        name: shown,
        error: `Couldn't copy the file (${(err as Error).message}).`
      }
    }
  }

  // From a path the user picked. The size is checked before reading, and the
  // read stops one byte past the limit in case the file grows meanwhile.
  async addPath(draft: string, path: string): Promise<AttachResult> {
    const name = displayName(path)
    let handle: import('fs').promises.FileHandle | null = null
    try {
      const st = await fsp.stat(path)
      if (!st.isFile()) return { ok: false, name, error: "That isn't a file." }
      if (st.size > MAX_FILE)
        return {
          ok: false,
          name,
          error: `The file is ${(st.size / 1_000_000).toFixed(1)} MB; attached files can be up to ${MAX_FILE / 1_000_000} MB.`
        }
      handle = await fsp.open(path, 'r')
      const buf = Buffer.alloc(Math.min(st.size, MAX_FILE) + 1)
      const { bytesRead } = await handle.read(buf, 0, buf.length, 0)
      if (bytesRead > MAX_FILE)
        return { ok: false, name, error: 'The file grew past the size limit while it was read.' }
      return await this.addBytes(draft, path, buf.subarray(0, bytesRead))
    } catch (err) {
      return { ok: false, name, error: `Couldn't read the file (${(err as Error).message}).` }
    } finally {
      await handle?.close()
    }
  }

  async listDraft(draft: string): Promise<DraftAttachment[]> {
    const dir = this.draftDir(draft)
    let names: string[] = []
    try {
      names = await fsp.readdir(dir)
    } catch {
      return []
    }
    const out: DraftAttachment[] = []
    for (const n of names.filter((n) => n.endsWith('.json'))) {
      try {
        out.push(JSON.parse(await fsp.readFile(join(dir, n), 'utf8')))
      } catch {
        // A half-written record: its file is ignored and swept later.
      }
    }
    return out
  }

  async removeDraft(draft: string, id: string): Promise<void> {
    const dir = this.draftDir(draft)
    for (const a of await this.listDraft(draft))
      if (a.id === id) {
        await fsp.rm(this.file(dir, a), { force: true })
        await fsp.rm(`${this.file(dir, a)}.json`, { force: true })
      }
  }

  async discardDraft(draft: string): Promise<void> {
    await fsp.rm(this.draftDir(draft), { recursive: true, force: true })
  }

  // Moves a draft's files to the chat, for the user message at `message`.
  // Only the ids given are taken; the order is theirs.
  async commit(draft: string, chat: string, ids: string[], message: number): Promise<Attachment[]> {
    const all = await this.listDraft(draft)
    const picked = ids.map((id) => {
      const a = all.find((x) => x.id === id)
      if (!a)
        throw new AttachmentMissing('A file in the message is no longer there. Attach it again.')
      return a
    })
    const from = this.draftDir(draft)
    const to = this.chatDir(chat)
    await fsp.mkdir(to, { recursive: true })
    const moved: DraftAttachment[] = []
    try {
      for (const a of picked) {
        await fsp.rename(this.file(from, a), this.file(to, a))
        moved.push(a)
      }
    } catch (err) {
      // Put back what moved, so the draft is whole again.
      for (const a of moved)
        await fsp.rename(this.file(to, a), this.file(from, a)).catch(() => undefined)
      throw err
    }
    for (const a of picked) await fsp.rm(`${this.file(from, a)}.json`, { force: true })
    return picked.map((a) => ({ ...withoutKey(a, 'draft'), message }))
  }

  // A send that never reached the chat: the files go back to the draft.
  async uncommit(chat: string, draft: string, attachments: Attachment[]): Promise<void> {
    const from = this.chatDir(chat)
    const to = this.draftDir(draft)
    await fsp.mkdir(to, { recursive: true })
    for (const a of attachments) {
      const rest = withoutKey(a, 'message')
      await fsp.rename(this.file(from, a), this.file(to, a))
      await fsp.writeFile(`${this.file(to, a)}.json`, JSON.stringify({ ...rest, draft }), {
        mode: 0o444
      })
    }
  }

  // A sent file's bytes, checked against the hash taken when it was attached.
  async read(chat: string, a: Attachment): Promise<Buffer> {
    let b: Buffer
    try {
      b = await fsp.readFile(this.file(this.chatDir(chat), a))
    } catch {
      throw new AttachmentMissing(
        `${a.name} is no longer in Custard's copy of this chat's files, so it can't be sent again. Remove the message's files from the request by starting a new chat, or attach it again.`
      )
    }
    if (createHash('sha256').update(b).digest('hex') !== a.sha256)
      throw new AttachmentMissing(
        `Custard's copy of ${a.name} has changed since it was attached, so it won't be sent.`
      )
    return b
  }

  // For showing a thumbnail: an image's bytes as a data URL, from either place.
  async dataUrl(
    where: { chat?: string; draft?: string },
    a: { id: string; ext: string; mime: string; kind: string }
  ): Promise<string | null> {
    if (a.kind !== 'image') return null
    const dir = where.chat ? this.chatDir(where.chat) : this.draftDir(where.draft ?? '')
    try {
      const b = await fsp.readFile(this.file(dir, a))
      if (b.length > ATTACHMENT_LIMITS.imageBytes) return null
      const mime = IMAGE_MIME[a.ext]
      return mime ? `data:${mime};base64,${b.toString('base64')}` : null
    } catch {
      return null
    }
  }

  async deleteChat(chat: string): Promise<void> {
    await fsp.rm(this.chatDir(chat), { recursive: true, force: true })
  }

  // Folders of chats that no longer exist (deleted while Custard wasn't
  // running to clean up, or a new chat whose first send never finished).
  // Run at startup, before any send.
  async sweepChats(keep: Set<string>): Promise<number> {
    let names: string[] = []
    try {
      names = await fsp.readdir(this.root)
    } catch {
      return 0
    }
    let removed = 0
    for (const n of names)
      if (n !== 'drafts' && ID.test(n) && !keep.has(n)) {
        await fsp.rm(join(this.root, n), { recursive: true, force: true })
        removed++
      }
    return removed
  }

  // Drafts nobody sent: removed once they're older than `maxAgeMs`.
  async sweepDrafts(maxAgeMs: number, now = Date.now()): Promise<number> {
    const dir = join(this.root, 'drafts')
    let names: string[] = []
    try {
      names = await fsp.readdir(dir)
    } catch {
      return 0
    }
    let removed = 0
    for (const n of names) {
      try {
        const st = await fsp.stat(join(dir, n))
        if (now - st.mtimeMs > maxAgeMs) {
          await fsp.rm(join(dir, n), { recursive: true, force: true })
          removed++
        }
      } catch {
        // Gone meanwhile.
      }
    }
    return removed
  }
}
