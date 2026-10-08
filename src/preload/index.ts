import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { MemorySettings } from '../shared/memory'
import type {
  ChatLink,
  ChatEvent,
  ChatMemory,
  ChatSettings,
  ContinueResult,
  Conversation,
  ConversationSummary,
  Mode,
  Provider,
  SendChatRequest
} from '../shared/chat'
import type { VaultInfo } from '../shared/vault'
import type { WidgetBounds, WidgetDisplay, WidgetPresentation, WidgetView } from '../shared/widgets'
import type { Attachment, AttachResult, DraftAttachment } from '../shared/attachments'
import type { ApprovalDecision } from '../shared/chat'
import type {
  Artifact,
  ArtifactSummary,
  CapabilityReport,
  DesignEvent,
  DesignSettings,
  ExportResult,
  Job
} from '../shared/design'
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
    resetSecrets: (id: string): Promise<PluginStatus> =>
      ipcRenderer.invoke('plugins:resetSecrets', id),
    create: (id: string, name: string): Promise<PluginStatus> =>
      ipcRenderer.invoke('plugins:create', id, name),
    labels: (): Promise<Record<string, string>> => ipcRenderer.invoke('plugins:labels'),
    sourceRoot: (): Promise<string> => ipcRenderer.invoke('plugins:sourceRoot')
  },
  memory: {
    getSettings: (): Promise<MemorySettings> => ipcRenderer.invoke('memory:getSettings'),
    setSettings: (s: MemorySettings): Promise<void> => ipcRenderer.invoke('memory:setSettings', s),
    setChat: (id: string, off: boolean): Promise<ChatMemory | null> =>
      ipcRenderer.invoke('memory:setChat', id, off),
    forgetChat: (id: string): Promise<ChatMemory | null> =>
      ipcRenderer.invoke('memory:forgetChat', id),
    onUpdate: (cb: (u: { conversationId: string; memory?: ChatMemory }) => void): (() => void) => {
      const listener = (_: unknown, u: { conversationId: string; memory?: ChatMemory }): void =>
        cb(u)
      ipcRenderer.on('memory:update', listener)
      return () => ipcRenderer.removeListener('memory:update', listener)
    }
  },
  // Plugin widgets next to the message box (see main/widgets).
  widgets: {
    display: (d: WidgetDisplay): void => ipcRenderer.send('widgets:display', d),
    bounds: (b: WidgetBounds): void => ipcRenderer.send('widgets:bounds', b),
    dismiss: (instanceId: string): Promise<void> =>
      ipcRenderer.invoke('widgets:dismiss', instanceId),
    presentation: (instanceId: string, p: WidgetPresentation): Promise<void> =>
      ipcRenderer.invoke('widgets:presentation', instanceId, p),
    decide: (approvalId: string, allow: boolean): Promise<void> =>
      ipcRenderer.invoke('widgets:decide', approvalId, allow),
    onState: (cb: (view: WidgetView | null) => void): (() => void) => {
      const listener = (_: unknown, v: WidgetView | null): void => cb(v)
      ipcRenderer.on('widgets:state', listener)
      return () => ipcRenderer.removeListener('widgets:state', listener)
    }
  },
  // Design mode's outputs, jobs and settings (see main/design). Export is
  // added by Workstream A as design.export.
  design: {
    subscribe: (): Promise<void> => ipcRenderer.invoke('design:subscribe'),
    list: (chat: string): Promise<ArtifactSummary[]> => ipcRenderer.invoke('design:list', chat),
    get: (chat: string, artifactId: string): Promise<Artifact | null> =>
      ipcRenderer.invoke('design:get', chat, artifactId),
    select: (chat: string, artifactId: string, versionId: string): Promise<Artifact> =>
      ipcRenderer.invoke('design:select', chat, artifactId, versionId),
    jobs: (chat: string): Promise<Job[]> => ipcRenderer.invoke('design:jobs', chat),
    job: (
      chat: string,
      action: 'check' | 'cancel' | 'stop',
      id: string
    ): Promise<{ job: Job; text: string } | { error: string }> =>
      ipcRenderer.invoke('design:job', chat, action, id),
    settings: {
      get: (): Promise<DesignSettings> => ipcRenderer.invoke('design:settings:get'),
      set: (s: DesignSettings): Promise<void> => ipcRenderer.invoke('design:settings:set', s)
    },
    capabilities: (): Promise<CapabilityReport> => ipcRenderer.invoke('design:capabilities'),
    // Workstream A registers these in main/design/html.
    export: (chat: string, artifactId: string, versionId: string): Promise<ExportResult> =>
      ipcRenderer.invoke('design:export', chat, artifactId, versionId),
    preview: {
      show: (p: {
        chat: string
        artifactId: string
        versionId: string
        width: number
      }): Promise<void> => ipcRenderer.invoke('design:preview:show', p),
      bounds: (r: { x: number; y: number; width: number; height: number }): void =>
        ipcRenderer.send('design:preview:bounds', r),
      hide: (): Promise<void> => ipcRenderer.invoke('design:preview:hide'),
      onState: (cb: (s: unknown) => void): (() => void) => {
        const listener = (_: unknown, s: unknown): void => cb(s)
        ipcRenderer.on('design:preview:state', listener)
        return () => ipcRenderer.removeListener('design:preview:state', listener)
      }
    },
    onEvent: (cb: (e: DesignEvent) => void): (() => void) => {
      const listener = (_: unknown, e: DesignEvent): void => cb(e)
      ipcRenderer.on('design:event', listener)
      return () => ipcRenderer.removeListener('design:event', listener)
    }
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
    delete: (id: string): Promise<void> => ipcRenderer.invoke('conversations:delete', id),
    continuations: (id: string): Promise<ChatLink[]> =>
      ipcRenderer.invoke('conversations:continuations', id)
  },
  // Files for a Chat-mode message (see main/attachments). A draft is one
  // message's files before it is sent.
  attachments: {
    pick: (draft: string): Promise<AttachResult[]> => ipcRenderer.invoke('attachments:pick', draft),
    add: (draft: string, name: string, bytes: Uint8Array): Promise<AttachResult> =>
      ipcRenderer.invoke('attachments:add', draft, name, bytes),
    remove: (draft: string, id: string): Promise<void> =>
      ipcRenderer.invoke('attachments:remove', draft, id),
    discard: (draft: string): Promise<void> => ipcRenderer.invoke('attachments:discard', draft),
    list: (draft: string): Promise<DraftAttachment[]> =>
      ipcRenderer.invoke('attachments:list', draft),
    preview: (
      where: { chat?: string; draft?: string },
      a: Pick<Attachment, 'id' | 'ext' | 'mime' | 'kind'>
    ): Promise<string | null> => ipcRenderer.invoke('attachments:preview', where, a)
  },
  chat: {
    send: (req: SendChatRequest): void => ipcRenderer.send('chat:send', req),
    stop: (requestId: string): void => ipcRenderer.send('chat:stop', requestId),
    approve: (id: string, decision: ApprovalDecision): Promise<void> =>
      ipcRenderer.invoke('chat:approve', id, decision),
    // Continue a chat that grew too long in a new one; the original is kept.
    continue: (id: string, withoutSummary?: boolean): Promise<ContinueResult> =>
      ipcRenderer.invoke('chat:continue', id, withoutSummary),
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
