import { app, BrowserWindow, dialog } from 'electron'
import { join } from 'path'
import { getApiKey } from '../apiKey'
import { pluginHost } from '../plugins'
import { isPluginContents } from '../plugins/runtime'
import {
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
import { summarizer } from './summarize'

let instance: Capture | null = null

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
  handle('memory:forgetChat', async (e, id: string): Promise<ChatMemory | null> => {
    const notes = memory().savedNotes(id)
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
        'This chat will never be remembered again. The chat itself stays in your history until you delete it, and notes saved from other chats are not changed.'
      ].join('\n\n')
    }
    const r = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
    if (r.response !== 1) return getConversation(id)?.memory ?? null
    const { left } = memory().forget(id)
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
