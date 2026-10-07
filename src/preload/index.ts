import { contextBridge } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// API exposed to the renderer as window.custard. Mode features (chat streaming,
// Claude Code sessions) will add their IPC calls here.
const custard = {
  platform: process.platform
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('custard', custard)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.custard = custard
}

export type CustardAPI = typeof custard
