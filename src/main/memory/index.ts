import { app, BrowserWindow, dialog } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { getApiKey } from '../apiKey'
import { pluginHost } from '../plugins'
import { isPluginContents } from '../plugins/runtime'
import {
  allConversations,
  charge,
  setBudget,
  usageThisMonth,
  getConversation,
  oldChat,
  getMemorySettings,
  getVaultPath,
  setMemorySettings,
  updateConversation,
  clearPromptSnapshots
} from '../store'
import { handle } from '../ipc'
import { bumpMemoryEpoch } from '../promptCache'
import type { ChatMemory } from '../../shared/chat'
import { OLD_CHAT_REFUSAL } from '../../shared/neutralChat'
import type { MemorySettings } from '../../shared/memory'
import { Capture } from './capture'
import { continuationsOf } from '../continue'
import { ensurePluginFolder, findPluginFolder, type PluginInfo } from './plugins'
import { summarizer } from './summarize'
import { CHAT_NOTE_DELAY_MS, CHAT_NOTE_SYSTEM, ChatNotes } from '../chatNotes'
import { CHAT_NOTE_SCHEMA, handoffSummarizer } from '../handoff'

let instance: Capture | null = null

// What the plugin notes need to know about a plugin, from the plugin host.
export function pluginInfo(id: string, state?: PluginInfo['state']): PluginInfo | null {
  try {
    const s = pluginHost().status(id)
    return {
      id,
      name: s.name,
      description: s.description,
      version: s.active?.version ?? s.version,
      state: state ?? s.state,
      tools: s.tools.map((t) => ({ name: t.fullName, effect: t.effect }))
    }
  } catch {
    return null
  }
}

// Where a plugin's event log goes (plugins/eventLog.ts): the vault and the
// plugin's folder, found by its id. With `create`, the folder (and its
// Overview) is made the first time, like for captures. null without a vault.
export function pluginEventVault(
  id: string,
  create: boolean
): { vault: string; pluginFolder: string } | null {
  const vault = getVaultPath()
  if (!vault || !existsSync(vault)) return null
  if (!create) {
    const found = findPluginFolder(vault, id)
    return found ? { vault, pluginFolder: found } : null
  }
  const info = pluginInfo(id)
  return info ? { vault, pluginFolder: ensurePluginFolder(vault, info) } : null
}

// Every plugin, for deciding which notes a message needs. Reading every
// plugin's status hashes its source, so it's kept for a few seconds.
let cached: { at: number; list: PluginInfo[] } | null = null
export function allPluginInfo(): PluginInfo[] {
  if (cached && Date.now() - cached.at < 10_000) return cached.list
  const list = pluginHost()
    .list()
    .flatMap((p) => pluginInfo(p.id) ?? [])
  cached = { at: Date.now(), list }
  return list
}

// After a plugin is activated, renamed, turned on or off, or uninstalled.
// Its notes are never changed, deleted or moved; its current state reaches
// the model from the plugin host, not from a note.
export function pluginNotesChanged(): void {
  cached = null
}

// The app's one capture queue.
export function memory(): Capture {
  instance ??= new Capture({
    load: getConversation,
    update: updateConversation,
    vaultPath: getVaultPath,
    settings: getMemorySettings,
    summarizer: (provider, chatId) => {
      const key = getApiKey(provider)
      return key ? summarizer(provider, key, (m, u) => charge(chatId, m, u)) : null
    },
    queueFile: join(app.getPath('userData'), 'capture-queue.json'),
    pluginName: (id) => {
      try {
        return pluginHost().status(id).name
      } catch {
        return id
      }
    },
    pluginFolder: (vault, id) => {
      const info = pluginInfo(id)
      return info ? `${ensurePluginFolder(vault, info)}/Activity` : null
    },
    notify: (c) => {
      // App windows only; plugin sandboxes are windows too.
      for (const w of BrowserWindow.getAllWindows())
        if (!w.webContents.isDestroyed() && !isPluginContents(w.webContents))
          w.webContents.send('memory:update', { conversationId: c.id, memory: c.memory })
    }
  })
  return instance
}

let notesInstance: ChatNotes | null = null

// The app's one queue of chat notes (Custard/Chats).
export function chatNotes(): ChatNotes {
  notesInstance ??= new ChatNotes({
    load: getConversation,
    update: updateConversation,
    vaultPath: getVaultPath,
    auto: () => getMemorySettings().auto,
    summarizer: (provider, chatId) => {
      const key = getApiKey(provider)
      return key
        ? handoffSummarizer(
            provider,
            key,
            CHAT_NOTE_SYSTEM,
            (m, u) => charge(chatId, m, u),
            CHAT_NOTE_SCHEMA
          )
        : null
    },
    queueFile: join(app.getPath('userData'), 'chat-note-queue.json'),
    // Tests set a short pause.
    delayMs: () =>
      (globalThis as { __custardChatNoteDelay?: number }).__custardChatNoteDelay ??
      CHAT_NOTE_DELAY_MS
  })
  return notesInstance
}

export function registerMemoryHandlers(): void {
  handle('memory:getSettings', () => getMemorySettings())
  handle('usage:month', () => usageThisMonth())
  handle('usage:setBudget', (_, dollars: unknown) => {
    setBudget(dollars)
    return usageThisMonth()
  })
  handle('memory:setSettings', (_, s: MemorySettings) => {
    setMemorySettings(s)
    // Chats stop showing memory from before this at their next message.
    bumpMemoryEpoch()
    if (!s.auto) {
      memory().cancelAll()
      chatNotes().cancelAll()
    }
  })
  handle('memory:setChat', (_, id: string, off: boolean): ChatMemory | null => {
    if (oldChat(id)) throw new Error(OLD_CHAT_REFUSAL)
    bumpMemoryEpoch()
    return memory().setChatMemory(id, off)?.memory ?? null
  })
  // Asks first, listing every note it will delete, then forgets the chat.
  // A chat's continuations carry a summary of it, so they are forgotten too.
  handle('memory:forgetChat', async (e, id: string): Promise<ChatMemory | null> => {
    // An old chat is never read (see store.ts); its notes stay in the vault.
    if (oldChat(id)) throw new Error(OLD_CHAT_REFUSAL)
    const later = continuationsOf(allConversations(), id)
    const ids = [id, ...later.map((c) => c.id)]
    const notes = ids.flatMap((i) => memory().savedNotes(i))
    const win = BrowserWindow.fromWebContents(e.sender)
    const opts = {
      type: 'warning' as const,
      buttons: ['Cancel', 'Forget'],
      defaultId: 0,
      cancelId: 0,
      message: 'Forget this chat?',
      detail: [
        notes.length
          ? `Custard will delete ${notes.length === 1 ? 'this note' : `these ${notes.length} notes`} it saved from this chat:\n${notes.map((n) => `• ${n}`).join('\n')}`
          : "Custard hasn't saved any notes from this chat.",
        ...(later.length
          ? [
              `It was continued in ${later.length === 1 ? 'another chat' : `${later.length} other chats`} (${later.map((c) => `"${c.title}"`).join(', ')}), which ${later.length === 1 ? 'is' : 'are'} forgotten too; the notes above include theirs.`
            ]
          : []),
        'This chat will never be remembered again. The chat itself stays in your history until you delete it, and notes saved from other chats are not changed.'
      ].join('\n\n')
    }
    const r = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
    if (r.response !== 1) return getConversation(id)?.memory ?? null
    for (const i of ids) chatNotes().forget(i)
    const left = ids.flatMap((i) => memory().forget(i).left)
    // No chat keeps showing what was forgotten from its last prompt, or
    // keeps a copy of it in its saved snapshot.
    bumpMemoryEpoch()
    clearPromptSnapshots()
    if (left.length)
      await dialog.showMessageBox({
        type: 'error',
        message: "Some notes couldn't be deleted",
        detail: `Delete these yourself in Obsidian:\n${left.map((n) => `• ${n}`).join('\n')}`
      })
    return getConversation(id)?.memory ?? null
  })
  // Waiting captures and chat notes from before a restart.
  void memory().run()
  void chatNotes().runAll()
}
