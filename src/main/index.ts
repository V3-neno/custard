import {
  automationRunning,
  registerAutomationHandlers,
  startAutomations,
  stopAutomations
} from './automations'
import { app, dialog, shell, BrowserWindow } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { clearApiKey, getApiKey, setApiKey } from './apiKey'
import { allModels } from './adapters/registry'
import { loadModelRegistry, registeredProfiles } from './modelRegistry'
import { MODELS_FILE, readModelsFile } from './modelsFile'
import type { ModelsFileReport } from '../shared/models'
import { checkProvider, forgetCheck, lastCheck, modelAvailability } from './adapters/checks'
import { scanCapabilities, type ScanSources } from './adapters/scan'
import { DISCOVERY_SKILL, gapFor, starterPrompt } from './plugins/discovery'
import { isProvider } from '../shared/providers'
import { anyChatBusy, chatBusy, openConversation, registerChatHandlers } from './chat'
import { attachments, registerAttachmentHandlers } from './attachments'
import { chatNotes, memory, registerMemoryHandlers } from './memory'
import { allowOnlyAppPage, handle } from './ipc'
import { sameAppPage } from './appPage'
import {
  createPluginNamed,
  pluginHost,
  protectedRoots,
  registerPluginHandlers,
  startBackgroundSync,
  startPlugins,
  stopBackgroundSync
} from './plugins'
import { extensionRefusal, extensionTarget } from './modes/extensions'
import { listEdits, undoEdit } from './vault/edit'
import { isPluginContents } from './plugins/runtime'
import { registerWidgetHandlers, widgets } from './widgets'
import { designChatDeleted, registerDesignHandlers } from './design'
import {
  getChatSettings,
  getVaultPath,
  listConversations,
  oldChat,
  setChatSettings,
  setVaultPath,
  getVaultGrants,
  setVaultGrants,
  vaultEditsDir
} from './store'
import type { VaultInfo } from '../shared/vault'
import {
  isChatModel,
  isEffort,
  isMode,
  type ChatSettings,
  type Mode,
  type Provider
} from '../shared/chat'
import { listSkills } from './vault'
import { pinProviderEndpoints } from './endpoints'
import { OBSIDIAN_DOWNLOAD, obsidianOpenUrl } from './obsidian'
import {
  addMissingStarterSkills,
  createStarterVault,
  starterFile,
  starterSkillFolders
} from './vaultTemplate'
import { createSkill, readSkill, skillEntries } from './skillsHub'
import { deleteChat, deleteOldChats, type ChatCleanup } from './chatDelete'
import {
  registerBackgroundHandlers,
  showWindow,
  startBackground,
  startHidden,
  trackWindow
} from './background'

// One Custard at a time: a second one would run every automation twice.
// Opening it again shows the window of the one already running (it may be
// hidden in the tray).
if (!app.requestSingleInstanceLock()) app.exit(0)
else app.on('second-instance', () => showWindow())

// What goes with a chat when it is deleted (chatDelete.ts).
const cleanup: ChatCleanup = {
  widgets: (id) => widgets().conversationDeleted(id),
  attachments: (id) => attachments().deleteChat(id),
  design: designChatDeleted
}

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
    // Windows and Linux take the window and taskbar icon from here; macOS
    // uses the app bundle's icon (build/icon.icns).
    ...(process.platform !== 'darwin' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // Chromium's sandbox, like previews and plugins. The preload uses only
      // the sandboxed subset (docs/design/SANDBOX.md, "Main window").
      sandbox: true
    }
  })

  // Started at login while kept in the tray: it stays hidden there.
  const hidden = startHidden()
  mainWindow.on('ready-to-show', () => {
    if (!hidden) mainWindow.show()
  })
  trackWindow(mainWindow, createWindow)

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
// The user's models file (main/modelsFile.ts), in the data folder next to
// settings.json: read into the registry at startup and on Reload only.
let modelsReport: ModelsFileReport
function loadModels(): void {
  const r = readModelsFile(join(app.getPath('userData'), MODELS_FILE))
  modelsReport = r.report
  loadModelRegistry(() => r.profiles)
}

app.whenReady().then(() => {
  // Before any window, so the first one gets the full list.
  loadModels()
  // Packaged builds ignore ANTHROPIC_BASE_URL / OPENAI_BASE_URL (L13).
  pinProviderEndpoints(app.isPackaged)
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.custard.app')
  // In development the dock shows Electron's icon; packaged builds use the bundle's.
  if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(icon)

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
    void chatNotes().runAll()
  })
  handle('apiKey:clear', (_, p: Provider) => {
    clearApiKey(p)
    forgetCheck(p)
  })
  // The model picker's list, from the provider adapters.
  handle('models:list', () => allModels())
  // The model registry (main/modelRegistry.ts), which the renderer copies
  // before it draws anything.
  handle('models:profiles', () => registeredProfiles())
  // Settings → Models file: what the last read found, and Reload. Reload
  // waits while a chat or an automation is running, so no running turn
  // sees its model change.
  handle('models:file', () => modelsReport)
  handle('models:reload', () => {
    if (anyChatBusy() || automationRunning())
      return {
        ok: false as const,
        error: 'A chat or an automation is running. Reload when it has finished.'
      }
    loadModels()
    return { ok: true as const, report: modelsReport, profiles: registeredProfiles() }
  })
  // Settings only: Save and Refresh check a key with its own provider.
  handle('models:check', (_, p: Provider) => checkProvider(p))
  // Which models can be picked now, from saved keys and the last check: no
  // request.
  handle('models:availability', () => modelAvailability())
  handle('models:lastCheck', (_, p: Provider) => (isProvider(p) ? lastCheck(p) : null))
  // Settings → Capabilities, and its Refresh: local files and rules only, so
  // it asks no provider and no model (see adapters/scan).
  const capabilitySources = (): ScanSources => ({
    vault: getVaultPath(),
    plugins: () => pluginHost().list(),
    checks: lastCheck
  })
  handle('capabilities:scan', () => scanCapabilities(capabilitySources()))
  // Start building: a new plugin for a gap, like New plugin in Plugins mode,
  // with a starter prompt from the plugin-discovery skill (filled in here, no
  // model asked) for the user to check and send in its workspace.
  handle('capabilities:startPlugin', (_, provider: unknown, capability: unknown) => {
    const gap = gapFor(scanCapabilities(capabilitySources()), provider, capability)
    const bundled = starterFile(DISCOVERY_SKILL)
    if (!bundled) throw new Error('Custard is missing its plugin-discovery skill.')
    const p = starterPrompt(gap, getVaultPath(), bundled)
    const made = createPluginNamed(p.name)
    return { pluginId: made.id, name: made.name, request: p.request }
  })
  handle('settings:get', () => getChatSettings())
  // The default model: only a model and effort Custard knows.
  handle('settings:set', (_, s: ChatSettings) => {
    if (!isChatModel(s?.model) || !isEffort(s?.effort)) throw new Error('Unknown model or effort.')
    setChatSettings({ model: s.model, effort: s.effort })
  })
  handle('conversations:list', (_, mode: Mode | null) =>
    mode === null ? listConversations(null) : isMode(mode) ? listConversations(mode) : []
  )
  // A chat this build can't open comes back as an old chat: its title only.
  handle('conversations:get', (_, id: string) => openConversation(id) ?? oldChat(id))
  handle('conversations:delete', async (_, id: string) => {
    if (chatBusy(id))
      throw new Error(
        'This chat is still answering. Stop it or wait for it to finish, then delete it.'
      )
    await deleteChat(id, cleanup)
  })
  // Every old chat (see store.ts), each removed the way Delete removes one.
  // The window asks first.
  handle('conversations:deleteOld', async () => (await deleteOldChats(cleanup)).deleted)
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
      void chatNotes().runAll()
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
      void chatNotes().runAll()
    }
    return vaultInfo()
  })
  handle('vault:clear', () => setVaultPath(null))
  // Whether something handles obsidian:// links, i.e. Obsidian is installed.
  // Electron asks the OS; not checked on a real Windows or macOS install.
  handle('obsidian:installed', () => app.getApplicationNameForProtocol('obsidian://') !== '')
  // Both links are built here, never taken from the renderer.
  handle('obsidian:openVault', async () => {
    const path = getVaultPath()
    if (!path) throw new Error('Connect a vault first.')
    await shell.openExternal(obsidianOpenUrl(path))
  })
  handle('obsidian:download', () => shell.openExternal(OBSIDIAN_DOWNLOAD))
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
  // Add a skill: its folder and a draft SKILL.md (see createSkill).
  handle('skills:create', (_, name: string) => {
    const path = getVaultPath()
    if (!path || !existsSync(path)) throw new Error('Connect a vault first.')
    return createSkill(path, String(name))
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
  registerBackgroundHandlers()

  // The tray icon first, so a window started hidden has it.
  startBackground()
  createWindow()
  // Plugins start after the window so a slow plugin can't delay the app.
  void startPlugins().finally(startBackgroundSync)
  // Scheduled runs happen only while Custard is running (also when its
  // window is hidden in the tray).
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
  stopBackgroundSync()
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
