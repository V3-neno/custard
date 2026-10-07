import { app, dialog, shell, BrowserWindow } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { clearApiKey, getApiKey, setApiKey } from './apiKey'
import { openConversation, registerChatHandlers } from './chat'
import { attachments, registerAttachmentHandlers } from './attachments'
import { memory, registerMemoryHandlers } from './memory'
import { handle } from './ipc'
import { pluginHost, registerPluginHandlers, startPlugins } from './plugins'
import { isPluginContents } from './plugins/runtime'
import {
  deleteConversation,
  getChatSettings,
  getVaultPath,
  listConversations,
  setChatSettings,
  setVaultPath
} from './store'
import type { VaultInfo } from '../shared/vault'
import type { ChatSettings, Mode, Provider } from '../shared/chat'
import { listSkills } from './vault'
import { addMissingStarterSkills, createStarterVault } from './vaultTemplate'

function vaultInfo(): VaultInfo {
  const path = getVaultPath()
  if (!path) return null
  return {
    path,
    isObsidian: existsSync(join(path, '.obsidian')),
    skills: existsSync(path) ? listSkills(path).map((s) => s.name) : []
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
      sandbox: false
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
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
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
  handle('conversations:list', (_, mode: Mode) => listConversations(mode))
  handle('conversations:get', (_, id: string) => openConversation(id))
  handle('conversations:delete', async (_, id: string) => {
    deleteConversation(id)
    // The chat's attached files go with it.
    await attachments().deleteChat(id)
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
  handle('vault:addStarterSkills', () => {
    const path = getVaultPath()
    if (!path || !existsSync(path)) throw new Error('Connect a vault first.')
    return { added: addMissingStarterSkills(path), vault: vaultInfo() }
  })
  registerChatHandlers()
  registerAttachmentHandlers()
  registerPluginHandlers()
  registerMemoryHandlers()

  createWindow()
  // Plugins start after the window so a slow plugin can't delay the app.
  void startPlugins()

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

app.on('before-quit', () => pluginHost().shutdown())

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
