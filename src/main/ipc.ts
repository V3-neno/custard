import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { isPluginContents } from './plugins/runtime'
import { isWidgetContents } from './widgets/surface'
import { sameAppPage } from './appPage'

// IPC for the app window only. Plugin sandboxes and widget views can't reach
// ipcRenderer at all, but if one ever did, these channels still refuse it.
// Other untrusted contents (Design's HTML preview) register here.
const extraRefusals: ((wc: Electron.WebContents) => boolean)[] = []
export const refuseContents = (test: (wc: Electron.WebContents) => boolean): void =>
  void extraRefusals.push(test)
const refused = (wc: Electron.WebContents): boolean =>
  isPluginContents(wc) || isWidgetContents(wc) || extraRefusals.some((t) => t(wc))

// Allow-list on top of the deny-list: once the app window's page is known,
// only its top frame, on that page, is answered. A foreign page or an iframe
// in the app window is refused even if it somehow got the preload.
let appPageUrl: string | null = null
export const allowOnlyAppPage = (url: string | null): void => {
  appPageUrl = url
}
const notAppFrame = (e: {
  sender: Electron.WebContents
  senderFrame?: Electron.WebFrameMain | null
}): boolean => {
  if (appPageUrl === null) return false
  const f = e.senderFrame
  return !f || f !== e.sender.mainFrame || !sameAppPage(f.url, appPageUrl)
}

export function handle<A extends unknown[], R>(
  channel: string,
  fn: (e: IpcMainInvokeEvent, ...args: A) => R
): void {
  ipcMain.handle(channel, (e, ...args) => {
    if (refused(e.sender) || notAppFrame(e)) throw new Error('Not allowed')
    return fn(e, ...(args as A))
  })
}

export function on<A extends unknown[]>(
  channel: string,
  fn: (e: IpcMainEvent, ...args: A) => void
): void {
  ipcMain.on(channel, (e, ...args) => {
    if (refused(e.sender) || notAppFrame(e)) return
    fn(e, ...(args as A))
  })
}
