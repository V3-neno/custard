import { app, dialog, shell, BrowserWindow, ipcMain } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { clearApiKey, getApiKey, setApiKey } from './apiKey'
import { registerChatHandlers } from './chat'
import {
  deleteConversation,
  getChatSettings,
  getConversation,
  getVaultPath,
  listConversations,
  setChatSettings,
  setVaultPath
} from './store'
import type { VaultInfo } from '../shared/vault'
import { listSkills } from './vault'
import { createStarterVault } from './vaultTemplate'

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

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
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

  ipcMain.handle('apiKey:has', () => getApiKey() !== null)
  ipcMain.handle('apiKey:set', (_, key: string) => setApiKey(key))
  ipcMain.handle('apiKey:clear', () => clearApiKey())
  ipcMain.handle('settings:get', () => getChatSettings())
  ipcMain.handle('settings:set', (_, s) => setChatSettings(s))
  ipcMain.handle('conversations:list', () => listConversations())
  ipcMain.handle('conversations:get', (_, id: string) => getConversation(id))
  ipcMain.handle('conversations:delete', (_, id: string) => deleteConversation(id))
  ipcMain.handle('vault:get', () => vaultInfo())
  ipcMain.handle('vault:pick', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const options = {
      title: 'Choose your Obsidian vault folder',
      properties: ['openDirectory' as const]
    }
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    if (!result.canceled && result.filePaths[0]) setVaultPath(result.filePaths[0])
    return vaultInfo()
  })
  ipcMain.handle('vault:createStarter', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const options = {
      title: 'Choose where to create the starter vault',
      properties: ['openDirectory' as const, 'createDirectory' as const]
    }
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    if (!result.canceled && result.filePaths[0])
      setVaultPath(createStarterVault(result.filePaths[0]))
    return vaultInfo()
  })
  ipcMain.handle('vault:clear', () => setVaultPath(null))
  registerChatHandlers()

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
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
