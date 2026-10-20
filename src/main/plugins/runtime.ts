import { BrowserWindow, ipcMain, session, type Session, type WebContents } from 'electron'
import { join } from 'path'
import type {
  CapResult,
  ConfigValues,
  CallMeta,
  RuntimeFactory,
  RuntimeHandle,
  TestRunner,
  ToolOutcome
} from './host'

// Each plugin runs in its own hidden window with Chromium's renderer sandbox:
// no Node.js, context isolation, and a dedicated in-memory session whose
// network is shut three ways (every request cancelled, a dead proxy, and a
// CSP with no connect sources). Its only way out is the preload bridge, and
// the host identifies the plugin by the window a message comes from, never by
// anything the plugin says.
//
// This is crash and hang containment plus capability mediation. It is not a
// guarantee against a Chromium sandbox escape, so plugins are still treated
// as trusted, user-reviewed local code.

const LOAD_TIMEOUT_MS = 10_000
const CANCEL_GRACE_MS = 2_000
const CSP = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'"
const PAGE = `data:text/html,${encodeURIComponent(`<!doctype html><meta http-equiv="Content-Security-Policy" content="${CSP}"><title>plugin</title>`)}`

const seconds = (ms: number): string => {
  const s = Math.round(ms / 1000)
  return `${s} second${s === 1 ? '' : 's'}`
}

const locked = new WeakSet<Session>()

export async function lockedSession(partition: string): Promise<Session> {
  const ses = session.fromPartition(partition, { cache: false })
  if (locked.has(ses)) return ses
  ses.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !d.url.startsWith('data:') }))
  ses.setPermissionRequestHandler((_wc, _p, cb) => cb(false))
  ses.setPermissionCheckHandler(() => false)
  ses.setDevicePermissionHandler(() => false)
  ses.on('will-download', (e) => e.preventDefault())
  ses.setSpellCheckerEnabled(false)
  // '<-loopback>' removes Chromium's implicit proxy bypass for localhost and
  // 127.0.0.0/8, which let a preview's WebRTC TURN-over-TCP reach loopback
  // services (stabilization 4.3, Thread 4 R2). Same policy here.
  await ses.setProxy({ proxyRules: 'http://0.0.0.0:9', proxyBypassRules: '<-loopback>' })
  locked.add(ses)
  return ses
}

// The web preferences every plugin sandbox uses (plugin code and widgets).
export const sandboxPreferences = (
  partition: string,
  preload?: string
): Electron.WebPreferences => ({
  partition,
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInSubFrames: false,
  webSecurity: true,
  webviewTag: false,
  spellcheck: false,
  javascript: true,
  webgl: false,
  images: false,
  navigateOnDragDrop: false,
  backgroundThrottling: false,
  devTools: false,
  ...(preload ? { preload } : {})
})

// No new windows, navigation, redirects, webviews or UDP; no sound.
export function lockContents(wc: WebContents): void {
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))
  wc.on('will-navigate', (e) => e.preventDefault())
  wc.on('will-redirect', (e) => e.preventDefault())
  wc.on('will-attach-webview', (e) => e.preventDefault())
  wc.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
  wc.setAudioMuted(true)
}

function sandboxWindow(partition: string, preload?: string): BrowserWindow {
  const win = new BrowserWindow({
    show: false,
    width: 200,
    height: 200,
    webPreferences: sandboxPreferences(partition, preload)
  })
  lockContents(win.webContents)
  return win
}

type Instance = {
  pluginId: string
  onCap: (callId: string, name: string, args: unknown) => Promise<CapResult>
  ready: (tools: string[]) => void
  results: Map<string, (r: ToolOutcome) => void>
}
const instances = new Map<number, Instance>()

export const isPluginContents = (wc: WebContents): boolean => instances.has(wc.id)

let wired = false
function wireIpc(): void {
  if (wired) return
  wired = true
  ipcMain.on('plugin-host:ready', (e, tools: unknown) => {
    const inst = instances.get(e.sender.id)
    if (inst && Array.isArray(tools))
      inst.ready(tools.filter((t): t is string => typeof t === 'string'))
  })
  ipcMain.on('plugin-host:result', (e, callId: unknown, r: unknown) => {
    const inst = instances.get(e.sender.id)
    const done = inst?.results.get(String(callId))
    if (!done) return
    const res = (r ?? {}) as { content?: unknown; isError?: unknown; data?: unknown }
    done({
      content: typeof res.content === 'string' ? res.content : 'The plugin returned no result.',
      isError: res.isError !== false,
      // For the plugin's widgets only; checked by the host (see invoke).
      ...(res.data !== undefined ? { data: res.data } : {})
    })
  })
  ipcMain.handle(
    'plugin-host:cap',
    async (e, callId: unknown, name: unknown, args: unknown): Promise<CapResult> => {
      // The window says nothing about who it is; the sender decides.
      const inst = instances.get(e.sender.id)
      if (!inst) return { ok: false, error: 'Unknown caller.' }
      return inst.onCap(String(callId), String(name), args)
    }
  )
}

export const createRuntime =
  (preloadPath: string): RuntimeFactory =>
  async ({ pluginId, code, onCap, onExit }) => {
    wireIpc()
    const partition = `custard-plugin-${pluginId}`
    await lockedSession(partition)
    const win = sandboxWindow(partition, preloadPath)
    const wc = win.webContents
    const wcId = wc.id
    let disposed = false
    const pending = new Map<string, (r: ToolOutcome) => void>()

    const dispose = (reason: string): void => {
      if (disposed) return
      disposed = true
      instances.delete(wcId)
      for (const [, done] of pending)
        done({
          content: `The plugin stopped (${reason}), so the call did not finish.`,
          isError: true,
          interrupted: true
        })
      pending.clear()
      if (!win.isDestroyed()) {
        // Kill the renderer process first: destroying a window whose renderer
        // is stuck in a loop can block.
        if (!wc.isDestroyed() && !wc.isCrashed()) wc.forcefullyCrashRenderer()
        win.destroy()
      }
    }
    const exit = (reason: string): void => {
      if (disposed) return
      dispose(reason)
      onExit(reason)
    }
    wc.on('render-process-gone', (_e, d) => exit(`it crashed (${d.reason})`))
    wc.on('unresponsive', () => exit('it stopped responding'))

    const tools = await new Promise<string[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        dispose('load timed out')
        reject(new Error('The plugin did not finish loading within 10 seconds.'))
      }, LOAD_TIMEOUT_MS)
      instances.set(wcId, {
        pluginId,
        onCap,
        results: pending,
        ready: (t) => {
          clearTimeout(timer)
          resolve(t)
        }
      })
      wc.loadURL(PAGE)
        // Report what the plugin threw while loading, rather than Chromium's
        // generic "Script failed to execute".
        .then(() =>
          wc.executeJavaScript(
            `(function () { try {\n${code}\n; return null } catch (e) { return String((e && e.message) || e) } })()`
          )
        )
        .then((thrown: unknown) => {
          if (typeof thrown === 'string') throw new Error(thrown)
        })
        .catch((err: Error) => {
          clearTimeout(timer)
          dispose('load failed')
          reject(new Error(`The plugin failed to load: ${String(err.message).slice(0, 300)}`))
        })
    })

    const handle: RuntimeHandle = {
      dispose,
      call: (
        callId: string,
        tool: string,
        input: unknown,
        config: ConfigValues,
        timeoutMs: number,
        signal: AbortSignal,
        meta: CallMeta
      ) =>
        new Promise<ToolOutcome>((resolve) => {
          if (disposed)
            return resolve({ content: 'The plugin is not running.', isError: true, notSent: true })
          let settled = false
          const settle = (r: ToolOutcome): void => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            pending.delete(callId)
            signal.removeEventListener('abort', onAbort)
            resolve(r)
          }
          // Cancel, then make sure the window still answers. A busy loop
          // can't even receive the cancel, so it is killed.
          const stop = (why: string): void => {
            settle({ content: why, isError: true, interrupted: true })
            if (disposed || wc.isDestroyed()) return
            wc.send('plugin-host:cancel', callId)
            const kill = setTimeout(
              () => exit('it stopped responding after a cancel'),
              CANCEL_GRACE_MS
            )
            wc.executeJavaScript('1').then(
              () => clearTimeout(kill),
              () => undefined
            )
          }
          const timer = setTimeout(
            () =>
              stop(
                `The plugin did not answer within ${seconds(timeoutMs)}, so the call was cancelled.`
              ),
            timeoutMs
          )
          const onAbort = (): void => stop('The call was cancelled.')
          // Cancelled before it was sent: nothing reached the plugin.
          if (signal.aborted)
            return settle({ content: 'The call was cancelled.', isError: true, notSent: true })
          signal.addEventListener('abort', onAbort)
          pending.set(callId, settle)
          wc.send('plugin-host:call', callId, tool, input, config, meta)
        })
    }
    return { handle, tools }
  }

// Plugin tests run in a fresh sandbox with no bridge at all. A test that
// never finishes (a busy loop included) is ended by the timeout, by Stop
// (`signal`), or when its renderer stops responding: the renderer process is
// killed first, because destroying a window whose renderer is stuck can
// block the main process.
const TEST_TIMEOUT_MS = 30_000
const PROGRESS = 'custard-test:'

export const runTestsInSandbox: TestRunner = async (code, o = {}) => {
  const timeoutMs = o.timeoutMs ?? TEST_TIMEOUT_MS
  if (o.signal?.aborted) throw new Error('The tests were stopped before they started.')
  await lockedSession('custard-plugin-tests')
  const win = sandboxWindow('custard-plugin-tests')
  const wc = win.webContents
  const kill = (): void => {
    if (!wc.isDestroyed() && !wc.isCrashed()) wc.forcefullyCrashRenderer()
    if (!win.isDestroyed()) win.destroy()
  }
  let fail: (err: Error) => void = () => {}
  const ended = new Promise<never>((_, reject) => (fail = reject))
  ended.catch(() => {})
  // Stopping a run still reports the tests that had finished and the one that
  // was running. They come from lines the runner emits as it goes, so they
  // survive a test that never lets the page answer.
  const done: unknown[] = []
  let current: string | null = null
  wc.on('console-message', (...args: unknown[]) => {
    const e = args[0] as { message?: string }
    const text = String(e?.message ?? args[2] ?? '')
    if (!text.startsWith(PROGRESS)) return
    try {
      const m = JSON.parse(text.slice(PROGRESS.length)) as { start?: string; done?: unknown }
      if (m.start) current = String(m.start).slice(0, 200)
      else if (m.done && done.length < 2000) done.push(m.done)
    } catch {
      // Not a progress line.
    }
  })
  let stopping = false
  const end = (message: string): void => {
    if (stopping) return
    stopping = true
    const err = new Error(
      current ? `${message} It was running "${current}".` : message
    ) as Error & { partial?: unknown[] }
    err.partial = done
    fail(err)
    kill()
  }
  const timer = setTimeout(
    () =>
      end(`Tests took longer than ${Math.round(timeoutMs / 1000)} seconds, so they were stopped.`),
    timeoutMs
  )
  const onAbort = (): void => end('The tests were stopped.')
  o.signal?.addEventListener('abort', onAbort, { once: true })
  wc.on('unresponsive', () => end('The tests stopped responding, so they were stopped.'))
  wc.on('render-process-gone', () => end('The test sandbox ended before the tests finished.'))
  try {
    await Promise.race([wc.loadURL(PAGE), ended])
    const run = wc.executeJavaScript(
      `globalThis.__custardEmit = (s) => console.debug(${JSON.stringify(PROGRESS)} + s);\n${code}\n;globalThis.__custardRunTests(${JSON.stringify(o.name ?? null)})`
    )
    run.catch(() => {})
    const results = (await Promise.race([run, ended])) as {
      name: string
      ok: boolean
      error?: string
      ms?: number
      skipped?: boolean
    }[]
    return Array.isArray(results)
      ? results.map((r) => ({
          name: String(r.name),
          ok: r.ok === true,
          error: r.error ? String(r.error) : undefined,
          ms: typeof r.ms === 'number' ? r.ms : undefined,
          ...(r.skipped ? { skipped: true } : {})
        }))
      : []
  } finally {
    clearTimeout(timer)
    o.signal?.removeEventListener('abort', onAbort)
    kill()
  }
}

export const pluginPreloadPath = (): string => join(__dirname, '../preload/plugin.js')
