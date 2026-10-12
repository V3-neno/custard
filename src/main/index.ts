import { registerAutomationHandlers, startAutomations, stopAutomations } from './automations'
import { app, dialog, shell, BrowserWindow } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { clearApiKey, getApiKey, setApiKey } from './apiKey'
import { chatBusy, openConversation, registerChatHandlers } from './chat'
import { attachments, registerAttachmentHandlers } from './attachments'
import { memory, registerMemoryHandlers } from './memory'
import { allowOnlyAppPage, handle } from './ipc'
import { sameAppPage } from './appPage'
import { pluginHost, protectedRoots, registerPluginHandlers, startPlugins } from './plugins'
import { extensionRefusal, extensionTarget } from './modes/extensions'
import { listEdits, undoEdit } from './vault/edit'
import { isPluginContents } from './plugins/runtime'
import { registerWidgetHandlers, widgets } from './widgets'
import { designChatDeleted, registerDesignHandlers } from './design'
import {
  deleteConversation,
  getChatSettings,
  getVaultPath,
  listConversations,
  setChatSettings,
  setVaultPath,
  getVaultGrants,
  setVaultGrants,
  vaultEditsDir
} from './store'
import type { VaultInfo } from '../shared/vault'
import { isMode, type ChatSettings, type Mode, type Provider } from '../shared/chat'
import { listSkills } from './vault'
import { pinProviderEndpoints } from './endpoints'
import { addMissingStarterSkills, createStarterVault, starterSkillFolders } from './vaultTemplate'
import { readSkill, skillEntries } from './skillsHub'

function vaultInfo(): VaultInfo {
  const path = getVaultPath()
  if (!path) return null
  return {
    path,
    isObsidian: existsSync(join(path, '.obsidian')),
    skills: existsSync(path) ? listSkills(path).map((s) => s.folder) : []
  }
}

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    title: 'Custard',
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // Chromium's sandbox, like previews and plugins. The preload uses only
      // the sandboxed subset (docs/design/SANDBOX.md, "Main window").
      sandbox: true
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  // Links in answers can come from web pages, so only web links are opened.
  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (/^https?:\/\//i.test(details.url)) shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  const devUrl = is.dev ? process.env['ELECTRON_RENDERER_URL'] : undefined
  const appUrl = devUrl ?? pathToFileURL(join(__dirname, '../renderer/index.html')).href

  // The window stays on its own page: anything else that tries to take it
  // over (a script, a redirect) would inherit window.custard.
  const isAppPage = (url: string): boolean => sameAppPage(url, appUrl)
  const stay = (e: { url: string; preventDefault: () => void }): void => {
    if (!isAppPage(e.url)) e.preventDefault()
  }
  allowOnlyAppPage(appUrl)
  mainWindow.webContents.on('will-navigate', stay)
  mainWindow.webContents.on('will-redirect', stay)

  if (devUrl) mainWindow.loadURL(devUrl)
  else mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Packaged builds ignore ANTHROPIC_BASE_URL / OPENAI_BASE_URL (L13).
  pinProviderEndpoints(app.isPackaged)
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.custard.app')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  handle('apiKey:has', (_, p: Provider) => getApiKey(p) !== null)
  handle('apiKey:set', (_, p: Provider, key: string) => {
    setApiKey(p, key)
    void memory().run()
  })
  handle('apiKey:clear', (_, p: Provider) => clearApiKey(p))
  handle('settings:get', () => getChatSettings())
  handle('settings:set', (_, s: ChatSettings) => setChatSettings(s))
  handle('conversations:list', (_, mode: Mode | null) =>
    mode === null ? listConversations(null) : isMode(mode) ? listConversations(mode) : []
  )
  handle('conversations:get', (_, id: string) => openConversation(id))
  handle('conversations:delete', async (_, id: string) => {
    if (chatBusy(id))
      throw new Error(
        'This chat is still answering. Stop it or wait for it to finish, then delete it.'
      )
    deleteConversation(id)
    widgets().conversationDeleted(id)
    // The chat's attached files and Design outputs go with it.
    await attachments().deleteChat(id)
    designChatDeleted(id)
  })
  handle('vault:get', () => vaultInfo())
  handle('vault:pick', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const options = {
      title: 'Choose your Obsidian vault folder',
      properties: ['openDirectory' as const]
    }
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    if (!result.canceled && result.filePaths[0]) {
      setVaultPath(result.filePaths[0])
      void memory().run()
    }
    return vaultInfo()
  })
  handle('vault:createStarter', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const options = {
      title: 'Choose where to create the starter vault',
      properties: ['openDirectory' as const, 'createDirectory' as const]
    }
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    if (!result.canceled && result.filePaths[0]) {
      setVaultPath(createStarterVault(result.filePaths[0]))
      void memory().run()
    }
    return vaultInfo()
  })
  handle('vault:clear', () => setVaultPath(null))
  handle('vault:getGrants', () => getVaultGrants())
  handle('vault:setGrants', (_, grants: unknown) => setVaultGrants(grants))
  handle('vault:edits', () =>
    listEdits(vaultEditsDir()).map((r) => ({
      id: r.id,
      time: r.time,
      source: r.source,
      kind: r.kind,
      path: r.path,
      change: r.change,
      undoable: r.kind !== 'create' && !r.undone,
      undone: !!r.undone
    }))
  )
  handle('vault:undoEdit', (_, id: string) => {
    const path = getVaultPath()
    if (!path || !existsSync(path)) return { ok: false, message: 'Connect a vault first.' }
    return undoEdit(path, vaultEditsDir(), String(id), (real) => {
      const t = extensionTarget(real, path, protectedRoots())
      return t ? extensionRefusal(t, 'Settings') : null
    })
  })
  handle('vault:addStarterSkills', () => {
    const path = getVaultPath()
    if (!path || !existsSync(path)) throw new Error('Connect a vault first.')
    return { added: addMissingStarterSkills(path), vault: vaultInfo() }
  })
  // The Skills hub. Read only.
  handle('skills:list', () => {
    const path = getVaultPath()
    return path && existsSync(path) ? skillEntries(path, starterSkillFolders()) : null
  })
  handle('skills:read', (_, folder: string) => {
    const path = getVaultPath()
    if (!path || !existsSync(path)) throw new Error('Connect a vault first.')
    return readSkill(path, folder)
  })
  registerChatHandlers()
  registerAttachmentHandlers()
  registerPluginHandlers()
  registerMemoryHandlers()
  registerWidgetHandlers()
  registerDesignHandlers()
  registerAutomationHandlers()

  createWindow()
  // Plugins start after the window so a slow plugin can't delay the app.
  void startPlugins()
  // Scheduled runs happen only while Custard is open.
  startAutomations()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (appWindows().length === 0) createWindow()
  })
})

// Plugin sandboxes are hidden windows too; they don't count as the app.
const appWindows = (): BrowserWindow[] =>
  BrowserWindow.getAllWindows().filter((w) => !isPluginContents(w.webContents))

app.on('browser-window-created', (_, win) => {
  win.on('closed', () => {
    // When the last app window closes, stop the plugins so the app can quit.
    if (appWindows().length === 0 && process.platform !== 'darwin') pluginHost().shutdown()
  })
})

app.on('before-quit', () => {
  stopAutomations()
  pluginHost().shutdown()
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
