import { app, BrowserWindow, Menu, nativeImage, Notification, powerMonitor, Tray } from 'electron'
import icon from '../../resources/icon.png?asset'
import { handle } from './ipc'
import { getBackground, setBackground } from './store'
import type { BackgroundSettings, BackgroundView } from '../shared/background'
import { NoticeGate, noticeFor, type Notice } from './automations/notices'
import type { SchedulerReport } from './automations/scheduler'
import { localDay } from './automations/schedule'
import { trayMenu, trayTooltip, withDot, type TrayState } from './trayMenu'

// Running in the background (docs/automations.md): the tray icon, closing the
// window to the tray, starting at login, and notifications about runs. All of
// it is off by default except notifications.

let tray: Tray | null = null
let images: { idle: Electron.NativeImage; running: Electron.NativeImage } | null = null
let mainWindow: BrowserWindow | null = null
let createWindow: (() => void) | null = null
let trayState: () => TrayState = () => ({ running: null, on: 0, paused: [], last: null })
// Set when Custard is really quitting, so closing the window doesn't hide it.
let quitting = false
let hiddenNoticeShown = false
const gate = new NoticeGate(() => localDay(Date.now()))

// Electron starts Custard at login on Windows and macOS only, and a
// development build would register bare Electron, so only the installed app.
const loginSupported = (): boolean =>
  app.isPackaged && (process.platform === 'win32' || process.platform === 'darwin')

const LOGIN_ARG = '--hidden'

// Started at login: the first window stays hidden in the tray. Asked once.
let askedHidden = false
export function startHidden(): boolean {
  if (askedHidden) return false
  askedHidden = true
  if (!getBackground().keepInTray || !tray) return false
  if (process.argv.includes(LOGIN_ARG)) return true
  return process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin === true
}

export function showWindow(): void {
  const w = mainWindow
  if (!w || w.isDestroyed()) return createWindow?.()
  if (w.isMinimized()) w.restore()
  w.show()
  w.focus()
}

// The main window: closing it hides it while Custard is kept in the tray.
export function trackWindow(w: BrowserWindow, factory: () => void): void {
  mainWindow = w
  createWindow = factory
  w.on('close', (e) => {
    if (quitting || !tray || !getBackground().keepInTray) return
    e.preventDefault()
    w.hide()
    if (!hiddenNoticeShown) {
      hiddenNoticeShown = true
      show({
        title: 'Custard is still running',
        body: 'Automations keep to their schedule. Quit Custard from the tray icon’s menu.'
      })
    }
  })
  // Windows logging off or shutting down: let the window close.
  w.on('session-end', () => {
    quitting = true
  })
}

// Where the tray menu's lines come from (automations/index.ts).
export function setTrayState(source: () => TrayState): void {
  trayState = source
  refreshTray()
}

export function refreshTray(): void {
  if (!tray || tray.isDestroyed()) return
  const s = trayState()
  tray.setToolTip(trayTooltip(s))
  if (images) tray.setImage(s.running ? images.running : images.idle)
  tray.setContextMenu(
    Menu.buildFromTemplate(
      trayMenu(s).map((i) =>
        i.kind === 'separator'
          ? { type: 'separator' as const }
          : i.kind === 'info'
            ? { label: i.label, enabled: false }
            : { label: i.label, click: i.kind === 'open' ? showWindow : () => app.quit() }
      )
    )
  )
}

function trayImages(): { idle: Electron.NativeImage; running: Electron.NativeImage } {
  const size = 32
  const idle = nativeImage.createFromPath(icon).resize({ width: size, height: size })
  const running = nativeImage.createFromBitmap(Buffer.from(withDot(idle.toBitmap(), size)), {
    width: size,
    height: size
  })
  return { idle, running }
}

function applyTray(on: boolean): void {
  if (!on) {
    tray?.destroy()
    tray = null
    return
  }
  if (tray && !tray.isDestroyed()) return
  try {
    images ??= trayImages()
    tray = new Tray(images.idle)
    tray.on('click', showWindow)
    refreshTray()
  } catch (err) {
    // No tray on this system: closing the window quits, as before.
    console.error("The tray icon couldn't be created", err)
    tray = null
  }
}

function applyLogin(s: BackgroundSettings): void {
  if (!loginSupported()) return
  app.setLoginItemSettings({
    openAtLogin: s.openAtLogin,
    ...(process.platform === 'win32' ? { args: [LOGIN_ARG] } : {})
  })
}

function show(n: Notice): void {
  if (!getBackground().notify || !Notification.isSupported()) return
  const note = new Notification({ title: n.title, body: n.body, icon })
  note.on('click', () => {
    showWindow()
    mainWindow?.webContents.send('app:openSettings')
  })
  note.show()
}

// A run ended or a slot was skipped (automations/index.ts).
export function reportRun(e: SchedulerReport): void {
  const n = noticeFor(e)
  if (n && gate.pass(e)) show(n)
  refreshTray()
}

const view = (): BackgroundView => ({
  settings: getBackground(),
  loginSupported: loginSupported()
})

export function startBackground(): void {
  applyTray(getBackground().keepInTray)
  app.on('before-quit', () => {
    quitting = true
  })
  // macOS and Linux shutting down: let the window close.
  powerMonitor.on('shutdown', () => {
    quitting = true
  })
}

export function registerBackgroundHandlers(): void {
  handle('background:get', () => view())
  handle('background:set', (_, raw: unknown) => {
    const before = getBackground()
    const s = setBackground(raw)
    applyTray(s.keepInTray)
    if (s.openAtLogin !== before.openAtLogin) applyLogin(s)
    return view()
  })
}
