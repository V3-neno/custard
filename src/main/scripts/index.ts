import { app, BrowserWindow, dialog } from 'electron'
import { join } from 'path'
import { handle } from '../ipc'
import { getScripts, setScripts } from '../store'
import type {
  ScriptRuntime,
  ScriptsSettings,
  ScriptsView,
  ScriptSummary
} from '../../shared/scripts'
import { ScriptHost } from './host'
import { checkInterpreter, discover, type Interpreter } from './interpreters'
import { ScriptStore } from './store'

// Wiring for scripts (docs/scripts.md): one store in the app data folder, one
// host, the Settings handlers. Off by default; turning Scripts off stops
// every running script.

let host: ScriptHost | null = null

export const scriptsDir = (): string => join(app.getPath('userData'), 'scripts')

const chosen = (runtime: ScriptRuntime): Interpreter | null => {
  const c = getScripts()[runtime]
  return c ? { runtime, path: c.path, version: c.version } : null
}

export function scriptHost(): ScriptHost {
  host ??= new ScriptHost(new ScriptStore(scriptsDir()), {
    enabled: () => getScripts().enabled,
    interpreter: chosen
  })
  return host
}

export const scriptsOn = (): boolean => getScripts().enabled

function summaries(): ScriptSummary[] {
  const store = scriptHost().store
  return store.ids().map((id) => {
    const st = store.state(id)
    const src = store.manifestIn(id, store.srcDir(id))
    let problem: string | null = null
    let manifest = src.ok ? src.manifest : null
    if (st.approval) {
      try {
        manifest = store.verifyApproved(id)
      } catch (err) {
        problem = (err as Error).message
      }
    } else if (!src.ok) problem = src.errors[0] ?? null
    return {
      id,
      name: manifest?.name ?? id,
      runtime: manifest?.runtime ?? null,
      approved: st.approval?.version ?? null,
      enabled: st.enabled,
      useInChat: st.useInChat,
      problem
    }
  })
}

const view = (): ScriptsView => ({
  settings: getScripts(),
  running: scriptHost().runningIds(),
  scripts: summaries()
})

const isRuntime = (r: unknown): r is ScriptRuntime => r === 'python' || r === 'node'

function save(patch: Partial<ScriptsSettings>): ScriptsView {
  const s = setScripts({ ...getScripts(), ...patch })
  if (!s.enabled) scriptHost().stop()
  return view()
}

async function use(runtime: ScriptRuntime, path: string): Promise<ScriptsView> {
  const i = await checkInterpreter(runtime, path)
  if (!i)
    throw new Error(
      runtime === 'python'
        ? "That file didn't start as Python. Pick python.exe (or python3), not the Microsoft Store shortcut."
        : "That file didn't start as Node.js. Pick node.exe (or node)."
    )
  return save({ [runtime]: { path: i.path, version: i.version } })
}

export function registerScriptHandlers(): void {
  handle('scripts:get', () => view())
  handle('scripts:setEnabled', (_e, on: unknown) => save({ enabled: on === true }))
  // Lists what was found; nothing is chosen until the user picks one.
  handle('scripts:find', async (_e, runtime: unknown) => {
    if (!isRuntime(runtime)) throw new Error('Unknown runtime')
    return (await discover(runtime)).map((i) => ({ path: i.path, version: i.version }))
  })
  handle('scripts:use', async (_e, runtime: unknown, path: unknown) => {
    if (!isRuntime(runtime) || typeof path !== 'string') throw new Error('Unknown runtime')
    // Only a path Find listed (checked again here) or one picked with Browse.
    const found = await discover(runtime)
    if (!found.some((f) => f.path === path))
      throw new Error('That interpreter is no longer there. Find again.')
    return use(runtime, path)
  })
  handle('scripts:browse', async (e, runtime: unknown) => {
    if (!isRuntime(runtime)) throw new Error('Unknown runtime')
    const win = BrowserWindow.fromWebContents(e.sender)
    const options: Electron.OpenDialogOptions = {
      title: runtime === 'python' ? 'Choose Python' : 'Choose Node.js',
      properties: ['openFile'],
      ...(process.platform === 'win32'
        ? { filters: [{ name: 'Programs', extensions: ['exe'] }] }
        : {})
    }
    const r = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (r.canceled || !r.filePaths[0]) return view()
    return use(runtime, r.filePaths[0])
  })
  handle('scripts:clear', (_e, runtime: unknown) => {
    if (!isRuntime(runtime)) throw new Error('Unknown runtime')
    return save({ [runtime]: null })
  })
  handle('scripts:stop', () => {
    scriptHost().stop()
    return view()
  })
  app.on('before-quit', () => host?.stop())
}
