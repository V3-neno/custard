import { app, BrowserWindow } from 'electron'
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
  // Waiting captures from before a restart.
  void memory().run()
}
