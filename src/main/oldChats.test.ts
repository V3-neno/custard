import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { OLD_CHAT_REFUSAL } from '../shared/neutralChat'
import type { ChatEvent } from '../shared/chat'

// B3: an old chat at each entry point that could read it as a chat. Each is
// refused with OLD_CHAT_REFUSAL (or finds nothing), no provider is asked,
// and the file is left exactly as it was. The handlers are the app's own,
// registered as index.ts registers them; Electron and the provider adapters
// are stand-ins.

const base = mkdtempSync(join(tmpdir(), 'custard-oldchats-'))
const userData = join(base, 'userData')
const handlers = new Map<string, (e: unknown, ...a: unknown[]) => unknown>()
const listeners = new Map<string, (e: unknown, ...a: unknown[]) => unknown>()
const provider: string[] = []

vi.mock('electron', () => ({
  app: { getPath: () => userData, isPackaged: false, getVersion: () => '0' },
  safeStorage: { isEncryptionAvailable: () => false },
  shell: {},
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => undefined, on: () => undefined },
  protocol: { registerSchemesAsPrivileged: () => undefined, handle: () => undefined },
  session: { defaultSession: { protocol: { handle: () => undefined } } },
  net: {},
  WebContentsView: class {},
  webContents: { getAllWebContents: () => [] },
  nativeTheme: {},
  dialog: {},
  Menu: {}
}))
vi.mock('./ipc', () => ({
  handle: (c: string, f: (e: unknown, ...a: unknown[]) => unknown) => handlers.set(c, f),
  on: (c: string, f: (e: unknown, ...a: unknown[]) => unknown) => listeners.set(c, f)
}))
vi.mock('./apiKey', () => ({ getApiKey: () => 'sk-test', hasApiKey: () => true }))
vi.mock('./adapters/registry', () => ({
  adapterFor: () => {
    provider.push('adapter asked for')
    throw new Error('no provider in this test')
  }
}))

mkdirSync(join(userData, 'conversations'), { recursive: true })
const { registerChatHandlers } = await import('./chat')
const { registerMemoryHandlers, chatNotes, memory } = await import('./memory')
const store = await import('./store')
registerChatHandlers()
registerMemoryHandlers()

const OLD = 'bbbbbbbb-0000-0000-0000-000000000002'
const file = join(userData, 'conversations', `${OLD}.json`)
const OLD_TEXT = JSON.stringify({
  id: OLD,
  mode: 'chat',
  title: 'Before B3',
  createdAt: 1,
  updatedAt: 5,
  messages: [
    { role: 'user', content: 'Hi' },
    { role: 'assistant', content: [{ type: 'text', text: 'Hello.' }] }
  ]
})

beforeEach(() => {
  writeFileSync(file, OLD_TEXT)
  provider.length = 0
})
const unchanged = (): void => expect(readFileSync(file, 'utf8')).toBe(OLD_TEXT)

function sendTo(conversationId: string | undefined, extra: object = {}): ChatEvent[] {
  const events: ChatEvent[] = []
  const sender = { isDestroyed: () => false, send: (_: string, e: ChatEvent) => events.push(e) }
  void listeners.get('chat:send')!(
    { sender },
    {
      requestId: 'r1',
      conversationId,
      mode: 'chat',
      text: 'Carry on',
      settings: { model: 'claude-opus-5-5', effort: 'medium' },
      ...extra
    }
  )
  return events
}
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20))

describe('an old chat at each entry point', () => {
  it('send: refused, nothing sent', async () => {
    const events = sendTo(OLD)
    await settle()
    expect(events).toEqual([
      { requestId: 'r1', type: 'error', message: OLD_CHAT_REFUSAL, conversation: null, kept: false }
    ])
    expect(provider).toEqual([])
    unchanged()
  })

  it('reference: picking it in the message box refuses the message, even with a note', async () => {
    // Its summary note from before B3 is still in the vault.
    const vault = join(base, 'vault')
    mkdirSync(join(vault, 'Custard/Chats'), { recursive: true })
    writeFileSync(
      join(vault, 'Custard/Chats', `Before B3 ${OLD.slice(0, 8)}.md`),
      `---\ncustard-chat: "${OLD}"\ntitle: "Before B3"\noutside: "false"\n---\n**Goal:** Hi`
    )
    store.setVaultPath(vault)
    const events = sendTo(undefined, { references: [OLD] })
    await settle()
    expect(events).toEqual([expect.objectContaining({ type: 'error', message: OLD_CHAT_REFUSAL })])
    expect(provider).toEqual([])
    unchanged()
  })

  it('Continue in a new chat: refused, no summary asked for', async () => {
    const r = await handlers.get('chat:continue')!({}, OLD, false)
    expect(r).toEqual({ ok: false, error: OLD_CHAT_REFUSAL, canSkipSummary: false })
    expect(provider).toEqual([])
    unchanged()
  })

  it('model picker: refused', () => {
    expect(() =>
      handlers.get('conversations:setModel')!({}, OLD, {
        model: 'claude-opus-5-5',
        effort: 'medium'
      })
    ).toThrow(OLD_CHAT_REFUSAL)
    unchanged()
  })

  it('hub offer: refused', () => {
    expect(handlers.get('chat:proposal')!({}, OLD, 'p1', true)).toEqual({
      ok: false,
      error: OLD_CHAT_REFUSAL
    })
    unchanged()
  })

  it('memory for this chat, and Forget: refused', async () => {
    expect(() => handlers.get('memory:setChat')!({}, OLD, true)).toThrow(OLD_CHAT_REFUSAL)
    await expect(
      (async () => handlers.get('memory:forgetChat')!({ sender: {} }, OLD))()
    ).rejects.toThrow(OLD_CHAT_REFUSAL)
    unchanged()
  })

  it('memory capture and the chat note: the chat is never loaded, nothing is queued', async () => {
    const asChat = { ...JSON.parse(OLD_TEXT), format: undefined }
    memory().afterTurn(asChat, 'claude')
    chatNotes().afterTurn(asChat, 'claude')
    await memory().run()
    await chatNotes().runAll()
    expect(chatNotes().pending()).toEqual([])
    chatNotes().cancelAll()
    expect(provider).toEqual([])
    unchanged()
  })

  it('links between chats and History search see its title only', () => {
    expect(store.allConversations().map((c) => c.id)).not.toContain(OLD)
    expect(handlers.get('conversations:continuations')!({}, OLD)).toEqual([])
    expect(store.listConversations(null).find((c) => c.id === OLD)).toEqual({
      id: OLD,
      mode: 'chat',
      title: 'Before B3',
      updatedAt: 5,
      old: 'old'
    })
  })
})
