import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { isPluginContents } from './plugins/runtime'

// IPC for the app window only. Plugin sandboxes can't reach ipcRenderer at
// all, but if one ever did, these channels still refuse it.

export function handle<A extends unknown[], R>(
  channel: string,
  fn: (e: IpcMainInvokeEvent, ...args: A) => R
): void {
  ipcMain.handle(channel, (e, ...args) => {
    if (isPluginContents(e.sender)) throw new Error('Not allowed')
    return fn(e, ...(args as A))
  })
}

export function on<A extends unknown[]>(
  channel: string,
  fn: (e: IpcMainEvent, ...args: A) => void
): void {
  ipcMain.on(channel, (e, ...args) => {
    if (isPluginContents(e.sender)) return
    fn(e, ...(args as A))
  })
}
