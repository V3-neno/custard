import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ATTACHMENT_LIMITS } from '../../shared/attachments'
import { AttachError, displayName, inspect } from './inspect'
import { AttachmentMissing, AttachmentStore } from './store'
import { gif, jpeg, pdf, png, webp } from './fixtures'

const fails = (name: string, b: Buffer): string => {
  try {
    inspect(name, b)
  } catch (err) {
    expect(err).toBeInstanceOf(AttachError)
    return (err as Error).message
  }
  throw new Error('expected a refusal')
}

describe('inspect: content decides the type', () => {
  it('reads image sizes from headers', () => {
    expect(inspect('a.png', png(10, 20))).toMatchObject({
      kind: 'image',
      mime: 'image/png',
      width: 10,
      height: 20
    })
    expect(inspect('a.JPG', jpeg(30, 40))).toMatchObject({
      mime: 'image/jpeg',
      width: 30,
      height: 40
    })
    expect(inspect('a.webp', webp(7, 9))).toMatchObject({
      mime: 'image/webp',
      width: 7,
      height: 9,
      frames: 1
    })
    expect(inspect('a.gif', gif(1))).toMatchObject({
      mime: 'image/gif',
      width: 5,
      height: 6,
      frames: 1
    })
  })

  it('counts animation frames', () => {
    expect(inspect('a.gif', gif(3)).frames).toBe(3)
    expect(inspect('a.webp', webp(7, 9, 4)).frames).toBe(4)
  })

  it('reads PDF pages and refuses encrypted PDFs', () => {
    expect(inspect('r.pdf', pdf(3))).toMatchObject({
      kind: 'pdf',
      mime: 'application/pdf',
      pages: 3
    })
    expect(fails('r.pdf', pdf(1, '/Encrypt 9 0 R'))).toMatch(/encrypted or password-protected/)
    expect(fails('r.pdf', pdf(ATTACHMENT_LIMITS.pdfPages + 1))).toMatch(
      /up to 100 pages; this one has 101/
    )
  })

  it('accepts UTF-8 text and code, with the character count', () => {
    expect(inspect('notes.md', Buffer.from('# Café\n'))).toMatchObject({
      kind: 'text',
      mime: 'text/plain',
      chars: 7
    })
    expect(inspect('Dockerfile', Buffer.from('FROM node'))).toMatchObject({
      kind: 'text',
      ext: 'dockerfile'
    })
    expect(inspect('x.ts', Buffer.from('\ufefflet a = 1'))).toMatchObject({ chars: 9 })
  })

  it('refuses a mismatch between name and content, either way', () => {
    expect(fails('photo.png', pdf())).toBe(
      "The file is named .png but its content is a PDF, so it wasn't attached."
    )
    expect(fails('report.pdf', png())).toMatch(/content is a PNG image/)
    expect(fails('notes.txt', png())).toMatch(/is a PNG image but is named \.txt/)
    expect(fails('fake.jpg', Buffer.from('hello'))).toMatch(/content is not an image or PDF/)
  })

  it('refuses binary or non-UTF-8 content in text files', () => {
    expect(fails('a.txt', Buffer.from([0x61, 0x00, 0x62]))).toMatch(/binary content/)
    expect(fails('a.csv', Buffer.from([0xc3, 0x28]))).toMatch(/isn't valid UTF-8/)
  })

  it('refuses unsupported types: office files, archives, executables, audio', () => {
    for (const n of ['a.docx', 'a.zip', 'a.exe', 'a.mp3', 'a.sh.exe', 'noext'])
      expect(fails(n, Buffer.from('PK\u0003\u0004'))).toMatch(
        /aren't supported|without an extension/
      )
  })

  it('refuses oversized files and images before decoding anything', () => {
    const big = Buffer.concat([png(10, 10), Buffer.alloc(ATTACHMENT_LIMITS.imageBytes)])
    expect(fails('a.png', big)).toMatch(/Images can be up to 5.0 MB/)
    expect(fails('a.png', png(9000, 10))).toMatch(/up to 8000×8000 pixels; this one is 9000×10/)
    expect(fails('a.txt', Buffer.alloc(ATTACHMENT_LIMITS.textBytes + 1, 'a'))).toMatch(
      /Split it into smaller files rather than have part of it left out/
    )
    expect(fails('a.txt', Buffer.alloc(0))).toBe('The file is empty.')
  })

  it('refuses damaged headers', () => {
    expect(fails('a.png', png().subarray(0, 12))).toMatch(/cut short or damaged/)
    expect(fails('a.jpg', Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01]))).toMatch(
      /cut short or damaged/
    )
    expect(fails('a.gif', gif(1).subarray(0, 20))).toMatch(/cut short or damaged/)
  })

  it('cleans names for display', () => {
    expect(displayName('C:\\Users\\x\\evil\u202Etxt.exe')).toBe('eviltxt.exe')
    expect(displayName('../../etc/passwd')).toBe('passwd')
    expect(displayName('\u0000\u0007')).toBe('file')
    expect(displayName(`${'a'.repeat(200)}.md`).length).toBeLessThanOrEqual(111)
  })
})

describe('attachment store', () => {
  let root: string
  let store: AttachmentStore
  const draft = 'draft-0001'
  const chat = 'chat-00000001'
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'custard-att-'))
    store = new AttachmentStore(root)
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('copies a file under a random read-only name, keeping the name for display', async () => {
    const r = await store.addBytes(draft, '../../secret <img src=x onerror=alert(1)>.png', png())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.attachment.name).toBe('secret <img src=x onerror=alert(1)>.png')
    const files = readdirSync(join(root, 'drafts', draft))
    expect(files.sort()).toEqual([`${r.attachment.id}.png`, `${r.attachment.id}.png.json`])
    expect(statSync(join(root, 'drafts', draft, `${r.attachment.id}.png`)).mode & 0o222).toBe(0)
  })

  it('returns the reason for a refused file and stores nothing', async () => {
    const r = await store.addBytes(draft, 'a.png', pdf())
    expect(r).toEqual({
      ok: false,
      name: 'a.png',
      error: expect.stringMatching(/content is a PDF/)
    })
    expect(await store.listDraft(draft)).toEqual([])
  })

  it('limits the number and total size of files on one message', async () => {
    for (let i = 0; i < ATTACHMENT_LIMITS.perMessage; i++)
      await store.addBytes(draft, `t${i}.txt`, Buffer.from(`file ${i}`))
    const r = await store.addBytes(draft, 'one-more.txt', Buffer.from('x'))
    expect(r).toMatchObject({ ok: false, error: 'A message can carry up to 10 files.' })
  })

  it('reads a picked path no larger than the limit, and refuses directories and huge files', async () => {
    const p = join(root, 'pick.md')
    writeFileSync(p, '# hi')
    expect(await store.addPath(draft, p)).toMatchObject({
      ok: true,
      attachment: { name: 'pick.md', kind: 'text' }
    })
    expect(await store.addPath(draft, root)).toMatchObject({
      ok: false,
      error: "That isn't a file."
    })
    const huge = join(root, 'huge.pdf')
    writeFileSync(huge, Buffer.alloc(ATTACHMENT_LIMITS.pdfBytes + 10))
    expect(await store.addPath(draft, huge)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/can be up to 20 MB/)
    })
    expect(await store.addPath(draft, join(root, 'missing.txt'))).toMatchObject({
      ok: false,
      error: expect.stringMatching(/Couldn't read the file/)
    })
  })

  it('commits to a chat, reads back with the hash checked, and reports a missing or changed copy', async () => {
    const a = await store.addBytes(draft, 'a.png', png())
    const b = await store.addBytes(draft, 'b.txt', Buffer.from('hello'))
    if (!a.ok || !b.ok) throw new Error('setup')
    const sent = await store.commit(draft, chat, [b.attachment.id, a.attachment.id], 4)
    expect(sent.map((s) => [s.name, s.message])).toEqual([
      ['b.txt', 4],
      ['a.png', 4]
    ])
    expect(await store.listDraft(draft)).toEqual([])
    expect((await store.read(chat, sent[0])).toString()).toBe('hello')
    rmSync(join(root, chat, `${sent[0].id}.txt`), { force: true })
    await expect(store.read(chat, sent[0])).rejects.toBeInstanceOf(AttachmentMissing)
    rmSync(join(root, chat, `${sent[1].id}.png`), { force: true })
    writeFileSync(join(root, chat, `${sent[1].id}.png`), png(1, 1))
    await expect(store.read(chat, sent[1])).rejects.toThrow(/has changed since it was attached/)
  })

  it('puts files back in the draft when a send never reached the chat', async () => {
    const a = await store.addBytes(draft, 'a.png', png())
    if (!a.ok) throw new Error('setup')
    const sent = await store.commit(draft, chat, [a.attachment.id], 0)
    await store.uncommit(chat, draft, sent)
    expect((await store.listDraft(draft)).map((x) => x.id)).toEqual([a.attachment.id])
    await expect(store.commit(draft, chat, ['not-there-id'], 0)).rejects.toThrow(/no longer there/)
  })

  it('removes a draft file, a whole draft, a chat, and old drafts only', async () => {
    const a = await store.addBytes(draft, 'a.txt', Buffer.from('x'))
    if (!a.ok) throw new Error('setup')
    await store.removeDraft(draft, a.attachment.id)
    expect(readdirSync(join(root, 'drafts', draft))).toEqual([])
    await store.addBytes('draft-old-1', 'a.txt', Buffer.from('x'))
    await store.addBytes('draft-new-1', 'a.txt', Buffer.from('x'))
    const old = (Date.now() - 2 * 86_400_000) / 1000
    utimesSync(join(root, 'drafts', 'draft-old-1'), old, old)
    expect(await store.sweepDrafts(86_400_000)).toBe(1)
    expect(existsSync(join(root, 'drafts', 'draft-old-1'))).toBe(false)
    expect(existsSync(join(root, 'drafts', 'draft-new-1'))).toBe(true)
    const b = await store.addBytes(draft, 'b.txt', Buffer.from('y'))
    if (!b.ok) throw new Error('setup')
    await store.commit(draft, chat, [b.attachment.id], 0)
    await store.deleteChat(chat)
    expect(existsSync(join(root, chat))).toBe(false)
  })

  it('refuses ids that could escape the folder', async () => {
    await expect(store.listDraft('../../etc')).rejects.toThrow(/Bad draft id/)
    await expect(store.deleteChat('../x')).rejects.toThrow(/Bad chat id/)
  })

  it('removes files of chats that no longer exist, and keeps drafts and live chats', async () => {
    const r = await store.addBytes(draft, 'a.png', png())
    if (!r.ok) throw new Error(r.error)
    await store.commit(draft, chat, [r.attachment.id], 0)
    const r2 = await store.addBytes(draft, 'b.png', png())
    if (!r2.ok) throw new Error(r2.error)
    await store.commit(draft, 'chat-gone-0001', [r2.attachment.id], 0)
    await store.addBytes(draft, 'c.png', png())
    expect(await store.sweepChats(new Set([chat]))).toBe(1)
    expect(existsSync(join(root, chat))).toBe(true)
    expect(existsSync(join(root, 'chat-gone-0001'))).toBe(false)
    expect(await store.listDraft(draft)).toHaveLength(1)
  })

  it('leaves the draft whole when a commit names a file that is not there', async () => {
    const r = await store.addBytes(draft, 'a.png', png())
    if (!r.ok) throw new Error(r.error)
    await expect(store.commit(draft, chat, [r.attachment.id, 'not-there-1'], 0)).rejects.toThrow(
      AttachmentMissing
    )
    expect((await store.listDraft(draft)).map((a) => a.id)).toEqual([r.attachment.id])
    // A second send of the same files finds them already gone from the draft.
    await store.commit(draft, chat, [r.attachment.id], 0)
    await expect(store.commit(draft, chat, [r.attachment.id], 2)).rejects.toThrow(AttachmentMissing)
  })
})
