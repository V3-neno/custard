import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type {
  ChatEvent,
  ChatSettings,
  Conversation,
  ConversationSummary,
  Mode,
  Provider,
  SendChatRequest
} from '../shared/chat'
import type { VaultInfo } from '../shared/vault'
import type { ApprovalDecision } from '../shared/chat'
import type {
  PluginReview,
  PluginStatus,
  SecurityDefaults,
  TestReport,
  Workspace
} from '../shared/plugins'

// API exposed to the renderer as window.custard. The renderer never sees the
// API keys; all model calls happen in the main process.
const custard = {
  platform: process.platform,
  apiKey: {
    has: (p: Provider): Promise<boolean> => ipcRenderer.invoke('apiKey:has', p),
    set: (p: Provider, key: string): Promise<void> => ipcRenderer.invoke('apiKey:set', p, key),
    clear: (p: Provider): Promise<void> => ipcRenderer.invoke('apiKey:clear', p)
  },
  settings: {
    get: (): Promise<ChatSettings> => ipcRenderer.invoke('settings:get'),
    set: (s: ChatSettings): Promise<void> => ipcRenderer.invoke('settings:set', s)
  },
  vault: {
    get: (): Promise<VaultInfo> => ipcRenderer.invoke('vault:get'),
    pick: (): Promise<VaultInfo> => ipcRenderer.invoke('vault:pick'),
    createStarter: (): Promise<VaultInfo> => ipcRenderer.invoke('vault:createStarter'),
    clear: (): Promise<void> => ipcRenderer.invoke('vault:clear'),
    addStarterSkills: (): Promise<{ added: string[]; vault: VaultInfo }> =>
      ipcRenderer.invoke('vault:addStarterSkills')
  },
  plugins: {
    list: (): Promise<PluginStatus[]> => ipcRenderer.invoke('plugins:list'),
    status: (id: string): Promise<PluginStatus> => ipcRenderer.invoke('plugins:status', id),
    review: (id: string): Promise<PluginReview> => ipcRenderer.invoke('plugins:review', id),
    test: (id: string): Promise<TestReport> => ipcRenderer.invoke('plugins:test', id),
    activate: (id: string, buildId: string, approved: string[]): Promise<PluginStatus> =>
      ipcRenderer.invoke('plugins:activate', id, buildId, approved),
    rollback: (id: string, approved: string[] = []): Promise<PluginStatus> =>
      ipcRenderer.invoke('plugins:rollback', id, approved),
    enable: (id: string): Promise<PluginStatus> => ipcRenderer.invoke('plugins:enable', id),
    disable: (id: string): Promise<PluginStatus> => ipcRenderer.invoke('plugins:disable', id),
    uninstall: (id: string): Promise<PluginStatus> => ipcRenderer.invoke('plugins:uninstall', id),
    setConfig: (id: string, values: Record<string, unknown>): Promise<PluginStatus> =>
      ipcRenderer.invoke('plugins:setConfig', id, values),
    setAskEveryTime: (id: string, tool: string, ask: boolean): Promise<PluginStatus> =>
      ipcRenderer.invoke('plugins:setAskEveryTime', id, tool, ask),
    connect: (id: string): Promise<PluginStatus> => ipcRenderer.invoke('plugins:connect', id),
    disconnect: (id: string): Promise<PluginStatus> => ipcRenderer.invoke('plugins:disconnect', id),
    create: (id: string, name: string): Promise<PluginStatus> =>
      ipcRenderer.invoke('plugins:create', id, name),
    labels: (): Promise<Record<string, string>> => ipcRenderer.invoke('plugins:labels'),
    sourceRoot: (): Promise<string> => ipcRenderer.invoke('plugins:sourceRoot')
  },
  security: {
    get: (): Promise<SecurityDefaults> => ipcRenderer.invoke('security:get'),
    set: (s: SecurityDefaults): Promise<void> => ipcRenderer.invoke('security:set', s)
  },
  workspace: {
    pickGeneral: (): Promise<Workspace | null> => ipcRenderer.invoke('workspace:pickGeneral')
  },
  conversations: {
    list: (mode: Mode): Promise<ConversationSummary[]> =>
      ipcRenderer.invoke('conversations:list', mode),
    get: (id: string): Promise<Conversation | null> => ipcRenderer.invoke('conversations:get', id),
    delete: (id: string): Promise<void> => ipcRenderer.invoke('conversations:delete', id)
  },
  chat: {
    send: (req: SendChatRequest): void => ipcRenderer.send('chat:send', req),
    stop: (requestId: string): void => ipcRenderer.send('chat:stop', requestId),
    approve: (id: string, decision: ApprovalDecision): Promise<void> =>
      ipcRenderer.invoke('chat:approve', id, decision),
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
