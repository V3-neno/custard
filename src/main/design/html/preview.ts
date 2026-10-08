import { randomBytes, randomUUID } from 'crypto'
import { BrowserWindow, session, WebContentsView, type Session, type WebContents } from 'electron'
import { sandboxPreferences } from '../../plugins/runtime'
import type { ArtifactStore } from '../store'
import type { PreviewCheck } from './handler'

// The HTML preview (docs/design/SANDBOX.md, docs/design/WORKSPACE.md). Each
// preview is a WebContentsView with no preload at all, Chromium's sandbox,
// context isolation and no Node.js, on its own throwaway in-memory session:
//   - The page is served from https://<random>.preview.invalid/, which only
//     this session knows: every https request on it goes to Custard's
//     handler, which serves only the files recorded on one version (hash
//     checked). `.invalid` never resolves anywhere.
//   - Every other request (http, ws, wss, file, other schemes) is cancelled
//     at the session, and its proxy is a dead address as a second lock.
//   - Navigation stays inside the version's own files; popups, downloads,
//     permissions, devices, dialogs and webviews are refused.
//   - Runtime errors come from console-message events, bounded.
// The session is dropped (and its storage cleared) when the preview closes,
// so nothing from one preview reaches another, the app, plugins or widgets.

export const PREVIEW_HOST_SUFFIX = '.preview.invalid'
const LOAD_TIMEOUT_MS = 10_000
const MAX_ERRORS = 20
const DEAD_PROXY = 'http://0.0.0.0:9'

// What the page may load: its own files, data: and blob:. connect-src 'self'
// lets it fetch its own JSON; nothing else is reachable anyway.
export const PREVIEW_CSP = [
  "default-src 'self' data: blob:",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:",
  "style-src 'self' 'unsafe-inline' data: blob:",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  "connect-src 'self' data: blob:",
  "frame-src 'self' data: blob:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  "frame-ancestors 'self'"
].join('; ')

const previews = new Set<number>()
// Preview contents are refused on the app's IPC (see main/ipc), though with
// no preload they can't reach it at all.
export const isPreviewContents = (wc: WebContents): boolean => previews.has(wc.id)

export type Target = { chat: string; artifactId: string; versionId: string }

// Serves one version's recorded files for a request, or a 404. Pure apart
// from the store, so it's tested directly.
export function serveVersion(
  artifacts: Pick<ArtifactStore, 'file' | 'read'>,
  t: Target,
  host: string,
  missed?: (path: string) => void
): (req: { url: string; method: string }) => Response {
  return (req) => {
    let url: URL
    try {
      url = new URL(req.url)
    } catch {
      return new Response(null, { status: 400 })
    }
    if (url.protocol !== 'https:' || url.hostname !== host || url.port)
      return new Response(null, { status: 404 })
    if (req.method !== 'GET' && req.method !== 'HEAD') return new Response(null, { status: 405 })
    let path: string
    try {
      path = url.pathname
        .split('/')
        .filter(Boolean)
        .map((s) => decodeURIComponent(s))
        .join('/')
    } catch {
      return new Response(null, { status: 400 })
    }
    if (!path || path.endsWith('/')) path = `${path}index.html`
    const f = artifacts.file(t.chat, t.artifactId, t.versionId, path)
    const bytes = f ? artifacts.read(t.chat, t.artifactId, t.versionId, f.record.path) : null
    if (!f || !bytes) {
      missed?.(path)
      return new Response('Not in this version.', {
        status: 404,
        headers: { 'content-type': 'text/plain', 'content-security-policy': PREVIEW_CSP }
      })
    }
    return new Response(req.method === 'HEAD' ? null : new Uint8Array(bytes), {
      headers: {
        'content-type': f.record.mime,
        'content-security-policy': PREVIEW_CSP,
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'cross-origin-resource-policy': 'same-origin'
      }
    })
  }
}

// Whether the session lets a request through: only this preview's own
// origin, data: and blob:. Everything else is cancelled here, before any
// network code sees it.
export function allowedRequest(url: string, origin: string): boolean {
  if (url.startsWith('data:') || url.startsWith('blob:')) return true
  return url === origin || url.startsWith(`${origin}/`)
}

type Sandbox = {
  ses: Session
  origin: string
  blocked: () => number
  missing: () => string[]
  dispose: () => void
}

async function sandboxSession(
  artifacts: ArtifactStore,
  t: Target
): Promise<Sandbox & { partition: string }> {
  const partition = `custard-preview-${randomUUID()}`
  const host = `${randomBytes(12).toString('hex')}${PREVIEW_HOST_SUFFIX}`
  const origin = `https://${host}`
  const ses = session.fromPartition(partition, { cache: false })
  let blocked = 0
  const missing: string[] = []
  ses.webRequest.onBeforeRequest((d, cb) => {
    const ok = allowedRequest(d.url, origin)
    if (!ok) blocked++
    cb({ cancel: !ok })
  })
  ses.protocol.handle(
    'https',
    serveVersion(artifacts, t, host, (p) => {
      if (missing.length < 50 && !missing.includes(p)) missing.push(p)
    })
  )
  ses.setPermissionRequestHandler((_wc, _p, cb) => cb(false))
  ses.setPermissionCheckHandler(() => false)
  ses.setDevicePermissionHandler(() => false)
  ses.setDisplayMediaRequestHandler((_req, cb) => cb({}))
  ses.on('will-download', (e) => e.preventDefault())
  ses.setSpellCheckerEnabled(false)
  await ses.setProxy({ proxyRules: DEAD_PROXY, proxyBypassRules: '' })
  return {
    ses,
    partition,
    origin,
    blocked: () => blocked,
    missing: () => [...missing],
    dispose: () => {
      try {
        ses.protocol.unhandle('https')
      } catch {
        // Already gone.
      }
      void ses.clearStorageData().catch(() => undefined)
      void ses.clearCache().catch(() => undefined)
    }
  }
}

const preferences = (partition: string): Electron.WebPreferences => ({
  ...sandboxPreferences(partition),
  images: true,
  disableDialogs: true,
  autoplayPolicy: 'document-user-activation-required',
  backgroundThrottling: true
})

// No popups, webviews, UDP, sound or dialogs; navigation only within the
// version's own files.
function lockPreview(wc: WebContents, origin: string, errors: string[]): void {
  const inside = (url: string): boolean => url.startsWith(`${origin}/`)
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))
  wc.on('will-navigate', (e) => {
    if (!inside(e.url)) e.preventDefault()
  })
  wc.on('will-redirect', (e) => {
    if (!inside(e.url)) e.preventDefault()
  })
  wc.on('will-attach-webview', (e) => e.preventDefault())
  wc.on('will-prevent-unload', (e) => e.preventDefault())
  wc.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
  wc.setAudioMuted(true)
  void wc.setVisualZoomLevelLimits(1, 1).catch(() => undefined)
  wc.on('console-message', (...args: unknown[]) => {
    // Electron 39 passes one event with the details; older builds passed them as arguments.
    const e = args[0] as { level?: string | number; message?: string; lineNumber?: number }
    const level = e.level ?? args[1]
    const message = String(e.message ?? args[2] ?? '')
    const line = e.lineNumber ?? args[3]
    if (level !== 'error' && level !== 3) return
    if (errors.length >= MAX_ERRORS) return
    errors.push(`${message.slice(0, 300)}${line ? ` (line ${line})` : ''}`)
  })
}

// ------------------------------------------------------------- check run

// Loads a stored version once, hidden, and reports what happened: loaded or
// not, the time, runtime errors and blocked requests. Contained like the
// visible preview; a page that hangs is stopped.
export async function checkVersion(artifacts: ArtifactStore, t: Target): Promise<PreviewCheck> {
  const sb = await sandboxSession(artifacts, t)
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    webPreferences: preferences(sb.partition)
  })
  const wc = win.webContents
  previews.add(wc.id)
  const errors: string[] = []
  lockPreview(wc, sb.origin, errors)
  const started = Date.now()
  const finish = (): void => {
    previews.delete(wc.id)
    if (!wc.isDestroyed() && !wc.isCrashed()) wc.forcefullyCrashRenderer()
    if (!win.isDestroyed()) win.destroy()
    sb.dispose()
  }
  try {
    const outcome = await new Promise<'loaded' | string>((resolve) => {
      const timer = setTimeout(
        () =>
          resolve(
            `it didn't finish loading within ${LOAD_TIMEOUT_MS / 1000} s, so it was stopped.`
          ),
        LOAD_TIMEOUT_MS
      )
      wc.once('did-finish-load', () => {
        clearTimeout(timer)
        resolve('loaded')
      })
      wc.once('did-fail-load', (_e, code, desc) => {
        clearTimeout(timer)
        resolve(`it failed to load (${desc || code}).`)
      })
      wc.once('render-process-gone', (_e, d) => {
        clearTimeout(timer)
        resolve(`its page crashed (${d.reason}).`)
      })
      wc.once('unresponsive', () => {
        clearTimeout(timer)
        resolve('it stopped responding, so it was stopped.')
      })
      wc.loadURL(`${sb.origin}/index.html`).catch(() => undefined)
    })
    if (outcome !== 'loaded') return { loaded: false, reason: outcome, errors }
    const ms = Date.now() - started
    // Errors thrown just after load (timers, handlers) are still "while loading".
    await new Promise((r) => setTimeout(r, 500))
    return { loaded: true, ms, errors, blocked: sb.blocked(), missing: sb.missing() }
  } finally {
    finish()
  }
}

// ------------------------------------------------------------- visible preview

export type PreviewState = {
  // artifactId/versionId of the preview this is about.
  key: string
  status: 'loading' | 'ready' | 'failed' | 'stopped'
  message?: string
  errors: string[]
  blocked: number
  // The zoom used to fit a wider device width into the pane.
  zoom: number
}

type Box = { x: number; y: number; width: number; height: number }

type Live = {
  key: string
  view: WebContentsView
  win: BrowserWindow
  sb: Sandbox
  width: number
  box: Box | null
  state: PreviewState
  timer: NodeJS.Timeout | null
  destroy: () => void
}

let live: Live | null = null
// The last box the app reported, kept across previews.
let lastBox: Box | null = null

export const previewKey = (t: Target): string => `${t.artifactId}/${t.versionId}`

// Where the view goes inside the box the app reports, and the zoom: a device
// width wider than the box is scaled down to fit rather than cut off.
export function layout(
  box: Box,
  deviceWidth: number,
  appZoom: number
): { bounds: Box; zoom: number } {
  const b = {
    x: Math.round(box.x * appZoom),
    y: Math.round(box.y * appZoom),
    width: Math.max(0, Math.round(box.width * appZoom)),
    height: Math.max(0, Math.round(box.height * appZoom))
  }
  if (!deviceWidth || b.width >= deviceWidth) {
    const width = deviceWidth ? Math.min(deviceWidth, b.width) : b.width
    return { bounds: { ...b, x: b.x + Math.round((b.width - width) / 2), width }, zoom: 1 }
  }
  return { bounds: b, zoom: b.width / deviceWidth }
}

function place(l: Live): void {
  if (l.win.isDestroyed() || l.view.webContents?.isDestroyed() !== false) return
  const box = l.box
  if (!box || box.width <= 0 || box.height <= 0) {
    l.view.setVisible(false)
    return
  }
  const { bounds, zoom } = layout(box, l.width, l.win.webContents.getZoomFactor())
  l.view.setBounds(bounds)
  if (!l.view.webContents.isDestroyed()) l.view.webContents.setZoomFactor(zoom)
  l.view.setVisible(true)
  if (l.state.zoom !== zoom) update(l, { zoom })
}

let notify: ((s: PreviewState) => void) | null = null
function update(l: Live, patch: Partial<PreviewState>): void {
  l.state = { ...l.state, ...patch }
  notify?.(l.state)
}

export async function showPreview(
  artifacts: ArtifactStore,
  win: BrowserWindow,
  t: Target,
  deviceWidth: number,
  onState: (s: PreviewState) => void
): Promise<void> {
  notify = onState
  const key = previewKey(t)
  if (live && live.key === key && live.win === win && !live.view.webContents.isDestroyed()) {
    live.width = deviceWidth
    place(live)
    notify(live.state)
    return
  }
  hidePreview()
  const sb = await sandboxSession(artifacts, t)
  const view = new WebContentsView({ webPreferences: preferences(sb.partition) })
  const wc = view.webContents
  previews.add(wc.id)
  const errors: string[] = []
  lockPreview(wc, sb.origin, errors)
  view.setBackgroundColor('#ffffff')
  view.setVisible(false)
  win.contentView.addChildView(view)
  let destroyed = false
  const l: Live = {
    key,
    view,
    win,
    sb,
    width: deviceWidth,
    box: lastBox,
    state: { key, status: 'loading', errors, blocked: 0, zoom: 1 },
    timer: null,
    destroy: () => {
      if (destroyed) return
      destroyed = true
      if (live === l) live = null
      if (l.timer) clearTimeout(l.timer)
      previews.delete(wc.id)
      // Kill the renderer first: closing one stuck in a loop can block.
      if (!wc.isDestroyed() && !wc.isCrashed()) wc.forcefullyCrashRenderer()
      if (!win.isDestroyed()) win.contentView.removeChildView(view)
      if (!wc.isDestroyed()) wc.close()
      sb.dispose()
    }
  }
  live = l
  const stop = (message: string): void => {
    if (destroyed) return
    update(l, { status: 'stopped', message, blocked: sb.blocked() })
    l.destroy()
  }
  wc.on('render-process-gone', (_e, d) => stop(`The preview crashed (${d.reason}).`))
  wc.on('unresponsive', () => stop('The preview stopped responding, so it was stopped.'))
  wc.on('console-message', () => {
    if (!destroyed) update(l, { errors: [...errors], blocked: sb.blocked() })
  })
  wc.on('did-finish-load', () => {
    if (l.timer) clearTimeout(l.timer)
    if (!destroyed) update(l, { status: 'ready', errors: [...errors], blocked: sb.blocked() })
  })
  wc.on('did-fail-load', (_e, code, desc, _url, mainFrame) => {
    if (mainFrame && !destroyed)
      update(l, { status: 'failed', message: `It failed to load (${desc || code}).` })
  })
  l.timer = setTimeout(() => {
    if (l.state.status === 'loading')
      stop(`It didn't finish loading within ${LOAD_TIMEOUT_MS / 1000} s, so it was stopped.`)
  }, LOAD_TIMEOUT_MS)
  // Blocked requests keep counting after load (timers, clicks).
  const tick = setInterval(() => {
    if (destroyed) return clearInterval(tick)
    if (sb.blocked() !== l.state.blocked) update(l, { blocked: sb.blocked() })
  }, 1000)
  notify(l.state)
  place(l)
  wc.loadURL(`${sb.origin}/index.html`).catch(() => undefined)
}

export function previewBounds(box: Box): void {
  lastBox = box
  if (!live) return
  live.box = box
  place(live)
}

export function hidePreview(): void {
  const l = live
  live = null
  l?.destroy()
}
