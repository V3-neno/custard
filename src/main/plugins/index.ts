import { app, BrowserWindow, dialog, safeStorage, shell } from 'electron'
import { join } from 'path'
import { existsSync, readdirSync } from 'fs'
import { pluginIdFrom, type Workspace } from '../../shared/plugins'
import { handle } from '../ipc'
import { getSecurityDefaults, setSecurityDefaults } from '../store'
import { PluginHost, type HostDeps } from './host'
import { migrateLegacySpotify } from './migrate'
import TypecheckWorker from './typecheck.worker?nodeWorker'
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
// Custard's own source.
export const custardSource = (): string => appRoot()
// Where plugin code lives (sources, built and installed copies, the SDK) and
// Custard's own files: no mode writes there through the vault tools.
export const protectedRoots = (): { plugin: string[]; app: string[] } => ({
  plugin: [pluginsRoot(), join(app.getPath('userData'), 'plugins'), sdkDir()],
  app: [custardSource()]
})

const crypto: Crypto = {
  available: () => safeStorage.isEncryptionAvailable(),
  encrypt: (s) => safeStorage.encryptString(s),
  decrypt: (b) => safeStorage.decryptString(b)
}

const TYPECHECK_TIMEOUT_MS = 60_000

// Throws when the check can't run (the compiler is missing, or it ran too
// long); the host reports that as a note and does not fail validation.
function typecheckInWorker(
  dir: string,
  sdkDir: string,
  widgetEntries: string[]
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const worker = TypecheckWorker({})
    const done = (f: () => void): void => {
      clearTimeout(timer)
      void worker.terminate()
      f()
    }
    const timer = setTimeout(
      () => done(() => reject(new Error('The type check took too long and was stopped.'))),
      TYPECHECK_TIMEOUT_MS
    )
    worker.once('message', (m: { ok: boolean; errors?: string[]; error?: string }) =>
      done(() => (m.ok ? resolve(m.errors ?? []) : reject(new Error(m.error))))
    )
    worker.once('error', (err) => done(() => reject(err)))
    worker.postMessage({
      dir,
      sdkDir,
      widgetEntries,
      libDir: app.isPackaged ? join(process.resourcesPath, 'typescript-lib') : undefined
    })
  })
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
    typecheck: typecheckInWorker,
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

// Checks a workspace a renderer asks for before a conversation stores it.
export function verifyWorkspace(w: Workspace | undefined): Workspace | undefined {
  if (!w) return undefined
  if (w.kind === 'internal') {
    if (!pluginHost().sourceIds().includes(w.pluginId))
      throw new Error(`There is no plugin/${w.pluginId}.`)
    return { kind: 'internal', pluginId: w.pluginId }
  }
  throw new Error('General Code was removed. Pick a plugin, or no workspace.')
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
  handle('plugins:setChatDesign', (_, id: string, on: boolean) =>
    h().setChatDesign(id, on === true)
  )
  handle('plugins:connect', (_, id: string) => h().connect(id))
  handle('plugins:disconnect', (_, id: string) => h().disconnect(id))
  handle('plugins:resetSecrets', async (e, id: string) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const opts = {
      type: 'warning' as const,
      buttons: ['Cancel', 'Reset'],
      defaultId: 0,
      cancelId: 0,
      message: `Reset ${h().status(id).name}'s saved secrets?`,
      detail:
        "Custard can't decrypt them right now. Resetting deletes them for good: the account sign-in and any secret settings. If your keyring or secure storage is only locked, cancel, unlock it and restart Custard instead."
    }
    const r = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
    if (r.response !== 1) return h().status(id)
    return h().resetSecrets(id)
  })
  // Only a name is asked for; the id is made from it (see pluginIdFrom).
  handle('plugins:create', (_, name: string) => {
    const root = pluginsRoot()
    const taken = new Set([
      ...h()
        .list()
        .map((p) => p.id),
      ...(existsSync(root) ? readdirSync(root) : [])
    ])
    const id = pluginIdFrom(String(name), taken)
    if (!id)
      throw new Error(
        'Use at least one letter from a to z in the name; Custard makes the folder name from it.'
      )
    scaffoldPlugin(root, id, String(name))
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
}
