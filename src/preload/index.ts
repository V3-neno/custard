import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type {
  ChatEvent,
  ChatSettings,
  Conversation,
  ConversationSummary,
  SendChatRequest
} from '../shared/chat'

// API exposed to the renderer as window.custard. The renderer never sees the
// API key; all Claude calls happen in the main process.
const custard = {
  platform: process.platform,
  apiKey: {
    has: (): Promise<boolean> => ipcRenderer.invoke('apiKey:has'),
    set: (key: string): Promise<void> => ipcRenderer.invoke('apiKey:set', key),
    clear: (): Promise<void> => ipcRenderer.invoke('apiKey:clear')
  },
  settings: {
    get: (): Promise<ChatSettings> => ipcRenderer.invoke('settings:get'),
    set: (s: ChatSettings): Promise<void> => ipcRenderer.invoke('settings:set', s)
  },
  conversations: {
    list: (): Promise<ConversationSummary[]> => ipcRenderer.invoke('conversations:list'),
    get: (id: string): Promise<Conversation | null> => ipcRenderer.invoke('conversations:get', id),
    delete: (id: string): Promise<void> => ipcRenderer.invoke('conversations:delete', id)
  },
  chat: {
    send: (req: SendChatRequest): void => ipcRenderer.send('chat:send', req),
    stop: (requestId: string): void => ipcRenderer.send('chat:stop', requestId),
    onEvent: (cb: (e: ChatEvent) => void): (() => void) => {
      const listener = (_: unknown, e: ChatEvent): void => cb(e)
      ipcRenderer.on('chat:event', listener)
      return () => ipcRenderer.removeListener('chat:event', listener)
    }
  }
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
