import { app, BrowserWindow, dialog, safeStorage, shell } from 'electron'
import { existsSync, realpathSync, statSync } from 'fs'
import { join } from 'path'
import type { Workspace } from '../../shared/plugins'
import { handle } from '../ipc'
import { getSecurityDefaults, setSecurityDefaults } from '../store'
import { isInside } from '../workspace/paths'
import { PluginHost, type HostDeps } from './host'
import { migrateLegacySpotify } from './migrate'
import { createRuntime, pluginPreloadPath, runTestsInSandbox } from './runtime'
import { scaffoldPlugin } from './scaffold'
import { PluginStore, type Crypto } from './store'
import { pluginNotesChanged } from '../memory'
import type { Transport } from './net'

// Where things live. In development the app path is the repository, so
// plugin sources are edited in place in plugin/. Packaged builds read them
// from the resources folder, or from CUSTARD_PLUGIN_DIR.
const appRoot = (): string => app.getAppPath()
export const pluginsRoot = (): string =>
  process.env.CUSTARD_PLUGIN_DIR ||
  (app.isPackaged ? join(process.resourcesPath, 'plugin') : join(appRoot(), 'plugin'))
export const sdkDir = (): string =>
  app.isPackaged ? join(process.resourcesPath, 'plugin-sdk') : join(appRoot(), 'src', 'plugin-sdk')
export const pluginDocsDir = (): string =>
  app.isPackaged
    ? join(process.resourcesPath, 'docs', 'plugins')
    : join(appRoot(), 'docs', 'plugins')
// Custard's own source, protected from General Code unless the user allows it.
export const custardSource = (): string => appRoot()

const crypto: Crypto = {
  available: () => safeStorage.isEncryptionAvailable(),
  encrypt: (s) => safeStorage.encryptString(s),
  decrypt: (b) => safeStorage.decryptString(b)
}

let host: PluginHost | null = null

export function pluginHost(): PluginHost {
  if (host) return host
  const deps: HostDeps = {
    sourceRoot: pluginsRoot,
    sdkDir: sdkDir(),
    store: new PluginStore(join(app.getPath('userData'), 'plugins'), crypto),
    runtime: createRuntime(pluginPreloadPath()),
    testRunner: runTestsInSandbox,
    openExternal: (url) => shell.openExternal(url),
    openBrowser: (url) => shell.openExternal(url),
    askByDefault: () => getSecurityDefaults().askBeforeWriteTools,
    // Test hook for the end-to-end run against a local mock. Only code already
    // running in the main process can set it.
    transport: () =>
      (globalThis as { __custardPluginTransport?: Transport }).__custardPluginTransport
  }
  host = new PluginHost(deps)
  return host
}

export async function startPlugins(): Promise<void> {
  const h = pluginHost()
  const store = h.store
  try {
    migrateLegacySpotify(app.getPath('userData'), store, crypto)
  } catch (err) {
    console.error('Spotify settings migration failed', err)
  }
  await h.startAll()
}

// General Code folders that overlap Custard's source, which the user allowed
// in a separate confirmation this session. A renderer can't grant this itself.
const coreGrants = new Set<string>()
// General Code folders the user chose in the main-process folder picker this
// session. A folder path from the renderer alone never makes a workspace.
const generalGrants = new Set<string>()

const overlapsCore = (root: string): boolean => {
  const core = realpathSync.native(custardSource())
  return isInside(root, core) || isInside(core, root)
}

// Checks a workspace a renderer asks for before a conversation stores it.
export function verifyWorkspace(w: Workspace | undefined): Workspace | undefined {
  if (!w) return undefined
  if (w.kind === 'internal') {
    if (!pluginHost().sourceIds().includes(w.pluginId))
      throw new Error(`There is no plugin/${w.pluginId}.`)
    return { kind: 'internal', pluginId: w.pluginId }
  }
  if (typeof w.root !== 'string' || !existsSync(w.root))
    throw new Error('That folder no longer exists.')
  const root = realpathSync.native(w.root)
  if (!generalGrants.has(root) || !statSync(root).isDirectory())
    throw new Error(
      'Choose this folder again with "Choose a project folder" so Custard can confirm it.'
    )
  if (isInside(root, app.getPath('userData')))
    throw new Error("Custard's data folder can't be a workspace.")
  const core = overlapsCore(root)
  if (core && w.coreAccess && coreGrants.has(root))
    return { kind: 'general', root, coreAccess: true }
  if (core && isInside(root, custardSource()))
    throw new Error(
      "This folder is part of Custard's own source. Choose it again and allow core access."
    )
  return { kind: 'general', root }
}

export function registerPluginHandlers(): void {
  const h = pluginHost
  handle('plugins:list', () => h().list())
  handle('plugins:status', (_, id: string) => h().status(id))
  handle('plugins:review', (_, id: string) => h().review(id))
  handle('plugins:test', (_, id: string) => h().test(id))
  // What the model is told about plugins follows their name and state.
  const noted = <T>(_id: string, s: T): T => {
    pluginNotesChanged()
    return s
  }
  handle('plugins:activate', async (_, id: string, buildId: string, approved: string[]) =>
    noted(id, await h().activate(id, buildId, approved))
  )
  handle('plugins:rollback', async (_, id: string, approved: string[]) =>
    noted(id, await h().rollback(id, approved))
  )
  handle('plugins:enable', async (_, id: string) => noted(id, await h().enable(id)))
  handle('plugins:disable', (_, id: string) => noted(id, h().disable(id)))
  handle('plugins:uninstall', async (e, id: string) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const opts = {
      type: 'warning' as const,
      buttons: ['Cancel', 'Uninstall'],
      defaultId: 0,
      cancelId: 0,
      message: `Uninstall ${h().status(id).name}?`,
      detail:
        'This deletes its builds, settings, stored data and account sign-in from Custard. The source in plugin/ is kept, so you can activate it again later.'
    }
    const r = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
    if (r.response !== 1) return h().status(id)
    h().uninstall(id)
    pluginNotesChanged()
    return h().status(id)
  })
  handle('plugins:setConfig', (_, id: string, values: Record<string, unknown>) =>
    h().setConfig(id, values)
  )
  handle('plugins:setAskEveryTime', (_, id: string, tool: string, ask: boolean) =>
    h().setAskEveryTime(id, tool, ask === true)
  )
  handle('plugins:connect', (_, id: string) => h().connect(id))
  handle('plugins:disconnect', (_, id: string) => h().disconnect(id))
  handle('plugins:create', (_, id: string, name: string) => {
    scaffoldPlugin(pluginsRoot(), String(id), String(name))
    return h().status(id)
  })
  handle('plugins:labels', () => {
    const labels: Record<string, string> = {}
    for (const p of h().list())
      for (const t of p.tools) {
        const l = h().describeTemplate(p.id, t.name)
        if (l) labels[t.fullName] = l
      }
    return labels
  })
  handle('plugins:sourceRoot', () => pluginsRoot())
  handle('security:get', () => getSecurityDefaults())
  handle('security:set', (_, s: { askBeforeWriteTools: boolean }) =>
    setSecurityDefaults({ askBeforeWriteTools: s.askBeforeWriteTools !== false })
  )

  // General Code: pick a folder. Overlapping Custard's own source needs a
  // separate, explicit yes.
  handle('workspace:pickGeneral', async (e): Promise<Workspace | null> => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const opts = {
      title: 'Choose the project folder for General Code',
      properties: ['openDirectory' as const]
    }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (r.canceled || !r.filePaths[0]) return null
    const root = realpathSync.native(r.filePaths[0])
    if (isInside(root, app.getPath('userData')))
      throw new Error("Custard's data folder can't be a workspace.")
    if (!overlapsCore(root)) {
      generalGrants.add(root)
      return { kind: 'general', root }
    }
    const ask = {
      type: 'warning' as const,
      buttons: ['Cancel', 'Allow core access'],
      defaultId: 0,
      cancelId: 0,
      message: "This folder contains Custard's own source code.",
      detail:
        "General Code would be able to edit Custard itself, including its plugin host and security checks. Only allow this if you mean to work on Custard core. Without it, Custard's source stays read- and write-protected in this workspace."
    }
    const answer = win ? await dialog.showMessageBox(win, ask) : await dialog.showMessageBox(ask)
    if (answer.response === 1) {
      coreGrants.add(root)
      generalGrants.add(root)
      return { kind: 'general', root, coreAccess: true }
    }
    // Declined: allowed only if the folder merely contains Custard, whose
    // source is then blocked.
    if (isInside(root, custardSource())) return null
    generalGrants.add(root)
    return { kind: 'general', root }
  })
}
