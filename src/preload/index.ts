import { contextBridge, ipcRenderer } from 'electron'
import type { MemorySettings } from '../shared/memory'
import type { Capability, ListedModel, ModelCheck } from '../shared/adapter'
import type { CapabilityScan } from '../shared/capabilityScan'
import type {
  ChatLink,
  ChatEvent,
  ChatMemory,
  ChatSettings,
  ContinueResult,
  ProposalResult,
  Conversation,
  ConversationSummary,
  Mode,
  Provider,
  SendChatRequest,
  UsageMonth
} from '../shared/chat'
import type { SkillEntry, SkillText, VaultEditEntry, VaultInfo } from '../shared/vault'
import type { VaultGrant } from '../shared/vaultGrants'
import type { AutomationView, PendingQuestion } from '../shared/automations'
import type { WidgetBounds, WidgetDisplay, WidgetPresentation, WidgetView } from '../shared/widgets'
import type { Attachment, AttachResult, DraftAttachment } from '../shared/attachments'
import type { ApprovalDecision, ModelAvailability } from '../shared/chat'
import type { ModelProfile } from '../shared/models'
import type {
  Artifact,
  ArtifactSummary,
  CapabilityReport,
  DesignEvent,
  DesignSettings,
  ExportResult,
  Job,
  ProviderListing,
  SkillChange
} from '../shared/design'
import type { PluginReview, PluginStatus, SecurityDefaults, TestReport } from '../shared/plugins'

// API exposed to the renderer as window.custard. The renderer never sees the
// API keys; all model calls happen in the main process.
const custard = {
  platform: process.platform,
  apiKey: {
    has: (p: Provider): Promise<boolean> => ipcRenderer.invoke('apiKey:has', p),
    set: (p: Provider, key: string): Promise<void> => ipcRenderer.invoke('apiKey:set', p, key),
    clear: (p: Provider): Promise<void> => ipcRenderer.invoke('apiKey:clear', p)
  },
  models: {
    // Every provider's models, from its adapter.
    list: (): Promise<ListedModel[]> => ipcRenderer.invoke('models:list'),
    // The model registry: the profiles Custard offers now (main/modelRegistry).
    profiles: (): Promise<ModelProfile[]> => ipcRenderer.invoke('models:profiles'),
    // Asks the provider, with the saved key. Settings' Save and Refresh only.
    check: (p: Provider): Promise<ModelCheck | null> => ipcRenderer.invoke('models:check', p),
    // From saved keys and the last check only; asks no provider.
    availability: (): Promise<ModelAvailability[]> => ipcRenderer.invoke('models:availability'),
    lastCheck: (p: Provider): Promise<ModelCheck | null> =>
      ipcRenderer.invoke('models:lastCheck', p)
  },
  // Settings → Capabilities. Read from Custard's own rules and files; asks no
  // provider.
  capabilities: {
    scan: (): Promise<CapabilityScan> => ipcRenderer.invoke('capabilities:scan'),
    // Start building: makes a new plugin for a gap and returns the starter
    // prompt for its workspace's message box.
    startPlugin: (
      provider: Provider,
      capability: Capability
    ): Promise<{ pluginId: string; name: string; request: string }> =>
      ipcRenderer.invoke('capabilities:startPlugin', provider, capability)
  },
  settings: {
    get: (): Promise<ChatSettings> => ipcRenderer.invoke('settings:get'),
    set: (s: ChatSettings): Promise<void> => ipcRenderer.invoke('settings:set', s)
  },
  automations: {
    list: (): Promise<AutomationView[]> => ipcRenderer.invoke('automations:list'),
    save: (a: unknown): Promise<{ ok: true; id: string } | { ok: false; problem: string }> =>
      ipcRenderer.invoke('automations:save', a),
    remove: (id: string): Promise<void> => ipcRenderer.invoke('automations:delete', id),
    setEnabled: (id: string, enabled: boolean): Promise<void> =>
      ipcRenderer.invoke('automations:setEnabled', id, enabled),
    resume: (id: string): Promise<void> => ipcRenderer.invoke('automations:resume', id),
    questions: (): Promise<PendingQuestion[]> => ipcRenderer.invoke('automations:questions'),
    dismissQuestion: (id: string): Promise<void> =>
      ipcRenderer.invoke('automations:dismissQuestion', id),
    runNow: (id: string): Promise<boolean> => ipcRenderer.invoke('automations:runNow', id),
    onChanged: (cb: () => void): (() => void) => {
      const h = (): void => cb()
      ipcRenderer.on('automations:changed', h)
      return () => ipcRenderer.removeListener('automations:changed', h)
    }
  },
  vault: {
    get: (): Promise<VaultInfo> => ipcRenderer.invoke('vault:get'),
    pick: (): Promise<VaultInfo> => ipcRenderer.invoke('vault:pick'),
    createStarter: (): Promise<VaultInfo> => ipcRenderer.invoke('vault:createStarter'),
    clear: (): Promise<void> => ipcRenderer.invoke('vault:clear'),
    addStarterSkills: (): Promise<{ added: string[]; vault: VaultInfo }> =>
      ipcRenderer.invoke('vault:addStarterSkills'),
    getGrants: (): Promise<VaultGrant[]> => ipcRenderer.invoke('vault:getGrants'),
    setGrants: (grants: VaultGrant[]): Promise<VaultGrant[]> =>
      ipcRenderer.invoke('vault:setGrants', grants),
    edits: (): Promise<VaultEditEntry[]> => ipcRenderer.invoke('vault:edits'),
    undoEdit: (id: string): Promise<{ ok: boolean; message: string }> =>
      ipcRenderer.invoke('vault:undoEdit', id)
  },
  skills: {
    // null when no vault is connected.
    list: (): Promise<SkillEntry[] | null> => ipcRenderer.invoke('skills:list'),
    read: (folder: string): Promise<SkillText> => ipcRenderer.invoke('skills:read', folder),
    // A new skill's folder with a draft SKILL.md; returns the folder.
    create: (name: string): Promise<string> => ipcRenderer.invoke('skills:create', name)
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
    setChatDesign: (id: string, on: boolean): Promise<PluginStatus> =>
      ipcRenderer.invoke('plugins:setChatDesign', id, on),
    connect: (id: string): Promise<PluginStatus> => ipcRenderer.invoke('plugins:connect', id),
    disconnect: (id: string): Promise<PluginStatus> => ipcRenderer.invoke('plugins:disconnect', id),
    resetSecrets: (id: string): Promise<PluginStatus> =>
      ipcRenderer.invoke('plugins:resetSecrets', id),
    create: (name: string): Promise<PluginStatus> => ipcRenderer.invoke('plugins:create', name),
    labels: (): Promise<Record<string, string>> => ipcRenderer.invoke('plugins:labels'),
    sourceRoot: (): Promise<string> => ipcRenderer.invoke('plugins:sourceRoot')
  },
  // Estimated spend this month, and the monthly budget.
  usage: {
    month: (): Promise<UsageMonth> => ipcRenderer.invoke('usage:month'),
    setBudget: (dollars: number | null): Promise<UsageMonth> =>
      ipcRenderer.invoke('usage:setBudget', dollars)
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
    providers: (): Promise<ProviderListing[]> => ipcRenderer.invoke('design:providers'),
    // Workstream A registers these in main/design/html.
    // The HTML of a version's index.html, for the Code view (text, ≤ 2 MB).
    source: (chat: string, artifactId: string, versionId: string): Promise<string | null> =>
      ipcRenderer.invoke('design:source', chat, artifactId, versionId),
    // Whether the skills behind a version changed since it was made.
    skillChanges: (chat: string, artifactId: string, versionId: string): Promise<SkillChange[]> =>
      ipcRenderer.invoke('design:skills', chat, artifactId, versionId),
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
  conversations: {
    // Every mode's chats when `mode` is null.
    list: (mode: Mode | null): Promise<ConversationSummary[]> =>
      ipcRenderer.invoke('conversations:list', mode),
    get: (id: string): Promise<Conversation | null> => ipcRenderer.invoke('conversations:get', id),
    delete: (id: string): Promise<void> => ipcRenderer.invoke('conversations:delete', id),
    continuations: (id: string): Promise<ChatLink[]> =>
      ipcRenderer.invoke('conversations:continuations', id),
    // Another model or effort for this chat's next message. No request.
    setModel: (id: string, settings: ChatSettings): Promise<Conversation> =>
      ipcRenderer.invoke('conversations:setModel', id, settings)
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
    // Yes or Not now on a Plugins hub chat's offer to enter a workspace.
    proposal: (chatId: string, proposalId: string, yes: boolean): Promise<ProposalResult> =>
      ipcRenderer.invoke('chat:proposal', chatId, proposalId, yes),
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

// The main window is sandboxed (src/main/index.ts): this preload may only
// use what Electron's sandboxed preloads offer (contextBridge, ipcRenderer,
// a reduced `process`), never Node modules. Context isolation is on, so the
// API is only ever exposed through the bridge.
contextBridge.exposeInMainWorld('custard', custard)

export type CustardAPI = typeof custard
