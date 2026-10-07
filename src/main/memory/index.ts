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
import { ensurePluginFolder, refreshPlugin, type PluginInfo } from './plugins'
import { existsSync } from 'fs'
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

// After a plugin is activated, renamed, turned on or off, or uninstalled:
// its notes (if it has any) say so. Notes are never deleted or moved.
export function pluginNotesChanged(id: string, state?: PluginInfo['state']): void {
  cached = null
  const vault = getVaultPath()
  const info = pluginInfo(id, state)
  if (!vault || !existsSync(vault) || !info) return
  try {
    refreshPlugin(vault, info)
  } catch (err) {
    console.error('Plugin notes:', err)
  }
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
    pluginNote: (vault, id, note) => {
      const info = pluginInfo(id)
      return info ? `${ensurePluginFolder(vault, info)}/${note}.md` : null
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
