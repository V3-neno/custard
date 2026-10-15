import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  utimesSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { said, user } from '../../test/neutral/builders'
import type { Conversation } from '../shared/chat'
import type { ChatCleanup } from './chatDelete'

// B3: the chats folder holds chats in Custard's format and old chats. Old
// chats are listed by title and never read as a chat; Delete all old chats
// removes them the way Delete removes one; the startup sweeps keep what
// belongs to a listed old chat and still clean up after a delete.

const base = mkdtempSync(join(tmpdir(), 'custard-store-'))
let userData = join(base, 'u0')
vi.mock('electron', () => ({ app: { getPath: () => userData } }))

const store = await import('./store')
const { deleteChat, deleteOldChats } = await import('./chatDelete')
const { AttachmentStore } = await import('./attachments/store')
const { reconcileDesign } = await import('./design/reconcile')

const conversations = (): string => join(userData, 'conversations')
const NEW = 'aaaaaaaa-0000-0000-0000-000000000001'
const OLD = 'bbbbbbbb-0000-0000-0000-000000000002'
const NEWER = 'cccccccc-0000-0000-0000-000000000003'
const BROKEN = 'dddddddd-0000-0000-0000-000000000004'
const NOT_CHAT = 'eeeeeeee-0000-0000-0000-000000000005'

function newChat(id = NEW): Conversation {
  const c: Conversation = {
    ...store.newConversation('chat', 'Hello there'),
    id
  }
  c.messages.push(user('Hello there'), said('Hi.'))
  store.saveConversation(c)
  return c
}

const write = (id: string, body: string): void =>
  writeFileSync(join(conversations(), `${id}.json`), body)

function seed(): void {
  newChat()
  // Saved by Custard before B3: Anthropic messages, no format.
  write(
    OLD,
    JSON.stringify({
      id: OLD,
      mode: 'design',
      title: 'Logo ideas',
      createdAt: 1,
      updatedAt: 5,
      messages: [{ role: 'user', content: 'Make a logo' }],
      memory: { watermark: 1 }
    })
  )
  write(NEWER, JSON.stringify({ format: 'custard-chat', version: 9, id: NEWER, title: 'Future' }))
  write(BROKEN, '{"id": "dddd", "title": "Cut off')
  write(NOT_CHAT, JSON.stringify(['just', 'a', 'list']))
}

beforeEach(() => {
  userData = mkdtempSync(join(base, 'u'))
  mkdirSync(conversations(), { recursive: true })
})

describe('the chats folder', () => {
  it('writes format and version first', () => {
    const c = newChat()
    const text = readFileSync(join(conversations(), `${c.id}.json`), 'utf8')
    expect(text.startsWith('{"format":"custard-chat","version":1,')).toBe(true)
  })

  it('lists old chats by title, mode and date, marked old, with the new chat', () => {
    seed()
    const all = store.listConversations(null)
    expect(all.find((c) => c.id === NEW)).toMatchObject({ title: 'Hello there' })
    expect(all.find((c) => c.id === NEW)!.old).toBeUndefined()
    expect(all.find((c) => c.id === OLD)).toEqual({
      id: OLD,
      mode: 'design',
      title: 'Logo ideas',
      updatedAt: 5,
      old: 'old'
    })
    expect(all.find((c) => c.id === NEWER)).toMatchObject({ title: 'Future', old: 'newer' })
    // A file that can't be read: listed in Chat, untitled, dated by the file.
    expect(all.find((c) => c.id === BROKEN)).toMatchObject({
      mode: 'chat',
      title: 'Untitled chat',
      old: 'unreadable'
    })
    expect(all.find((c) => c.id === BROKEN)!.updatedAt).toBeGreaterThan(0)
    expect(all.find((c) => c.id === NOT_CHAT)).toMatchObject({ old: 'unreadable' })
    expect(all).toHaveLength(5)
    // By mode: an old Design chat is in Design only.
    expect(store.listConversations('design').map((c) => c.id)).toEqual([OLD])
    expect(
      store
        .listConversations('chat')
        .map((c) => c.id)
        .sort()
    ).toEqual([NEW, NEWER, BROKEN, NOT_CHAT].sort())
  })

  it('an old chat with no date is dated by its file', () => {
    write(OLD, JSON.stringify({ id: OLD, title: 'Undated', messages: [] }))
    const t = new Date(2026, 0, 2).getTime()
    utimesSync(join(conversations(), `${OLD}.json`), t / 1000, t / 1000)
    expect(store.listConversations(null)[0].updatedAt).toBe(t)
  })

  it('nothing reads an old chat as a chat', () => {
    seed()
    for (const id of [OLD, NEWER, BROKEN, NOT_CHAT]) {
      expect(store.getConversation(id)).toBeNull()
      expect(store.oldChat(id)).toMatchObject({ id })
      expect(store.messageCount(id)).toBe(0)
      expect(store.conversationMode(id)).toBeNull()
      // Memory and chat notes change chats through updateConversation: an
      // old chat is left as it is.
      const before = readFileSync(join(conversations(), `${id}.json`), 'utf8')
      expect(store.updateConversation(id, (c) => void (c.title = 'Changed'))).toBeNull()
      expect(readFileSync(join(conversations(), `${id}.json`), 'utf8')).toBe(before)
    }
    expect(store.allConversations().map((c) => c.id)).toEqual([NEW])
    expect(store.oldChatIds().sort()).toEqual([OLD, NEWER, BROKEN, NOT_CHAT].sort())
    expect(store.getConversation(NEW)?.messages).toHaveLength(2)
    expect(store.oldChat(NEW)).toBeNull()
    expect(store.getConversation('nope')).toBeNull()
    expect(store.oldChat('nope')).toBeNull()
  })

  it('every chat file counts as existing, old or new', () => {
    seed()
    for (const id of [NEW, OLD, NEWER, BROKEN, NOT_CHAT])
      expect(store.conversationExists(id)).toBe(true)
    expect(store.conversationExists('ffffffff-0000')).toBe(false)
    expect(store.conversationIds().sort()).toEqual([NEW, OLD, NEWER, BROKEN, NOT_CHAT].sort())
  })

  it('a directory of many old chats and one new one', () => {
    for (let i = 0; i < 60; i++)
      write(
        `old-${String(i).padStart(4, '0')}`,
        JSON.stringify({ id: `old-${i}`, title: `Old ${i}`, updatedAt: i, messages: [] })
      )
    newChat()
    const all = store.listConversations(null)
    expect(all).toHaveLength(61)
    expect(all.filter((c) => !c.old).map((c) => c.id)).toEqual([NEW])
    expect(store.oldChatIds()).toHaveLength(60)
    expect(store.allConversations()).toHaveLength(1)
  })
})

describe('delete and delete all old chats', () => {
  type Log = string[]
  const cleanup = (log: Log, failOn?: string): ChatCleanup => ({
    widgets: (id: string) => void log.push(`widgets ${id}`),
    attachments: async (id: string) => {
      if (id === failOn) throw new Error('disk')
      log.push(`attachments ${id}`)
    },
    design: (id: string) => void log.push(`design ${id}`)
  })

  it('deletes each old chat the way Delete deletes one, and nothing else', async () => {
    seed()
    // Things delete-all must not touch.
    writeFileSync(join(userData, 'settings.json'), '{"budget":5}')
    const vault = join(userData, 'vault')
    for (const f of ['Custard/Chats/note.md', 'Custard/Captures/c.md', 'Custard/Memory.md']) {
      mkdirSync(join(vault, f, '..'), { recursive: true })
      writeFileSync(join(vault, f), 'x')
    }
    const log: Log = []
    const r = await deleteOldChats(cleanup(log))
    expect(r).toEqual({ deleted: 4, failed: [] })
    expect(readdirSync(conversations())).toEqual([`${NEW}.json`])
    for (const id of [OLD, NEWER, BROKEN, NOT_CHAT])
      expect(log.filter((l) => l.endsWith(id))).toEqual([
        `widgets ${id}`,
        `attachments ${id}`,
        `design ${id}`
      ])
    expect(log.some((l) => l.endsWith(NEW))).toBe(false)
    expect(readFileSync(join(userData, 'settings.json'), 'utf8')).toBe('{"budget":5}')
    for (const f of ['Custard/Chats/note.md', 'Custard/Captures/c.md', 'Custard/Memory.md'])
      expect(existsSync(join(vault, f))).toBe(true)
    // Nothing left to delete.
    expect(await deleteOldChats(cleanup([]))).toEqual({ deleted: 0, failed: [] })
  })

  it('one that fails does not stop the rest', async () => {
    seed()
    const r = await deleteOldChats(cleanup([], OLD))
    expect(r).toEqual({ deleted: 3, failed: [OLD] })
  })

  it('Delete on one old chat', async () => {
    seed()
    const log: Log = []
    await deleteChat(OLD, cleanup(log))
    expect(existsSync(join(conversations(), `${OLD}.json`))).toBe(false)
    expect(log).toEqual([`widgets ${OLD}`, `attachments ${OLD}`, `design ${OLD}`])
    expect(store.listConversations(null)).toHaveLength(4)
  })
})

describe('the startup sweeps', () => {
  it('attachments: an old chat keeps its folder; a deleted chat does not', async () => {
    seed()
    const root = join(userData, 'attachments')
    for (const id of [NEW, OLD, NEWER, BROKEN, 'ffffffff-0000-gone'])
      mkdirSync(join(root, id), { recursive: true })
    const files = new AttachmentStore(root)
    // As attachments/index.ts runs it: keep every chat file's id.
    expect(await files.sweepChats(new Set(store.conversationIds()))).toBe(1)
    expect(readdirSync(root).sort()).toEqual([NEW, OLD, NEWER, BROKEN].sort())
    // After a delete whose cleanup never ran (Custard stopped), the next
    // start removes the folder.
    store.deleteConversation(OLD)
    expect(await files.sweepChats(new Set(store.conversationIds()))).toBe(1)
    expect(readdirSync(root)).not.toContain(OLD)
  })

  it('Design: an old chat keeps its outputs; a deleted chat loses them', () => {
    seed()
    const jobs = [NEW, OLD, BROKEN, 'ffffffff-0000-gone'].map((c) => ({
      requestedBy: { conversationId: c }
    }))
    const run = (): string[] =>
      reconcileDesign({
        service: {
          jobs: { list: () => jobs as never, linkLocal: () => [] },
          artifacts: { get: () => undefined } as never,
          emit: () => undefined
        },
        // As design/index.ts runs it.
        chatExists: store.conversationExists,
        forgetChat: () => undefined
      }).forgotten
    expect(run()).toEqual(['ffffffff-0000-gone'])
    store.deleteConversation(OLD)
    expect(run()).toEqual([OLD, 'ffffffff-0000-gone'])
  })
})
