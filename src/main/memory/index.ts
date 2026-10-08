import { app, BrowserWindow, dialog } from 'electron'
import { join } from 'path'
import { getApiKey } from '../apiKey'
import { pluginHost } from '../plugins'
import { isPluginContents } from '../plugins/runtime'
import {
  allConversations,
  getConversation,
  getMemorySettings,
  getVaultPath,
  setMemorySettings,
  updateConversation
} from '../store'
import { handle } from '../ipc'
import type { ChatMemory } from '../../shared/chat'
import type { MemorySettings } from '../../shared/memory'
import { Capture } from './capture'
import { continuationsOf } from '../continue'
import { ensurePluginFolder, type PluginInfo } from './plugins'
import { summarizer } from './summarize'

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
    summarizer: (provider) => {
      const key = getApiKey(provider)
      return key ? summarizer(provider, key) : null
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

export function registerMemoryHandlers(): void {
  handle('memory:getSettings', () => getMemorySettings())
  handle('memory:setSettings', (_, s: MemorySettings) => {
    setMemorySettings(s)
    if (!s.auto) memory().cancelAll()
  })
  handle(
    'memory:setChat',
    (_, id: string, off: boolean): ChatMemory | null =>
      memory().setChatMemory(id, off)?.memory ?? null
  )
  // Asks first, listing every note it will delete, then forgets the chat.
  // A chat's continuations carry a summary of it, so they are forgotten too.
  handle('memory:forgetChat', async (e, id: string): Promise<ChatMemory | null> => {
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
    const left = ids.flatMap((i) => memory().forget(i).left)
    if (left.length)
      await dialog.showMessageBox({
        type: 'error',
        message: "Some notes couldn't be deleted",
        detail: `Delete these yourself in Obsidian:\n${left.map((n) => `• ${n}`).join('\n')}`
      })
    return getConversation(id)?.memory ?? null
  })
  // Waiting captures from before a restart.
  void memory().run()
}
