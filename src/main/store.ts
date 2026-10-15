import { app } from 'electron'
import { normalizeDesignSettings } from './design/settings'
import type { DesignSettings } from '../shared/design'
import { randomUUID } from 'crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'fs'
import { basename, join } from 'path'
import {
  defaultChatSettings,
  isMode,
  type ChatSettings,
  type Conversation,
  type ConversationSummary,
  type Mode,
  type UsageMonth
} from '../shared/chat'
import { CHAT_FORMAT, CHAT_VERSION, oldReason, type OldChat } from '../shared/neutralChat'
import { charger, normalizeBudget, UsageLedger, type Charge } from './usage'
import type { SecurityDefaults } from '../shared/plugins'
import { readSettingsFile, writeSettingsFile } from './settingsFile'
import { defaultMemorySettings, type MemorySettings } from '../shared/memory'
import { normalizeGrants, type VaultGrant } from '../shared/vaultGrants'
import { normalizeAutomations, type Automation } from '../shared/automations'

// Conversations are plain JSON files in the app's data folder, one per chat.
const dir = (): string => {
  const d = join(app.getPath('userData'), 'conversations')
  mkdirSync(d, { recursive: true })
  return d
}
const file = (id: string): string => join(dir(), `${id.replace(/[^\w-]/g, '')}.json`)
const settingsFile = (): string => join(app.getPath('userData'), 'settings.json')

// Conversations saved before modes existed belong to Chat.
const withMode = (c: Conversation): Conversation => ({ ...c, mode: c.mode ?? 'chat' })

// One file in the chats folder: a chat in Custard's format, or an old chat
// this build can't open (see neutralChat.ts). Of an old chat only the title,
// mode and date are read, for History; nothing else in it is ever used.
type ChatFile = { chat: Conversation } | { old: OldChat }

const chatFiles = (): string[] => readdirSync(dir()).filter((f) => f.endsWith('.json'))

function readChatFile(name: string): ChatFile {
  const full = join(dir(), name)
  const id = name.slice(0, -'.json'.length)
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(full, 'utf8'))
  } catch {
    parsed = undefined
  }
  const reason = parsed === undefined ? 'unreadable' : oldReason(parsed)
  if (reason === null) return { chat: withMode(parsed as Conversation) }
  const x = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>
  let updatedAt = typeof x.updatedAt === 'number' ? x.updatedAt : 0
  if (!updatedAt)
    try {
      updatedAt = statSync(full).mtimeMs
    } catch {
      // Listed last.
    }
  return {
    old: {
      id,
      mode: isMode(x.mode) ? x.mode : 'chat',
      title: typeof x.title === 'string' && x.title.trim() ? x.title : 'Untitled chat',
      updatedAt,
      old: reason
    }
  }
}

// Every mode's when `mode` is null. Old chats are listed with their title
// only.
export function listConversations(mode: Mode | null): ConversationSummary[] {
  return chatFiles()
    .flatMap((f): ConversationSummary[] => {
      let file: ChatFile
      try {
        file = readChatFile(f)
      } catch {
        return []
      }
      if ('old' in file) {
        const o = file.old
        return mode === null || o.mode === mode
          ? [{ id: o.id, mode: o.mode, title: o.title, updatedAt: o.updatedAt, old: o.old }]
          : []
      }
      const c = file.chat
      return mode === null || c.mode === mode
        ? [
            {
              id: c.id,
              mode: c.mode,
              title: c.title,
              updatedAt: c.updatedAt,
              ...(c.memory?.temporary ? { temporary: true } : {}),
              ...(c.workspace?.kind === 'internal' ? { pluginId: c.workspace.pluginId } : {}),
              ...(c.skill ? { skill: c.skill } : {}),
              // Where the chat stands, from its note in Custard/Chats.
              ...(c.chatNote && (c.chatNote.status === 'saved' || c.chatNote.status === 'edited')
                ? {
                    ...(c.chatNote.state ? { summary: c.chatNote.state } : {}),
                    ...(c.chatNote.title ? { noteTitle: c.chatNote.title } : {}),
                    ...(c.chatNote.goal ? { goal: c.chatNote.goal } : {}),
                    ...(c.chatNote.tags?.length ? { tags: c.chatNote.tags } : {})
                  }
                : {})
            }
          ]
        : []
    })
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

// Conversations with a turn in progress are held in memory by the chat and
// saved whole; anything else that changes them (memory capture) must change
// that copy, or its change would be overwritten by the chat's next save.
const live = new Map<string, Conversation>()
export const holdConversation = (c: Conversation): void => void live.set(c.id, c)
export const releaseConversation = (id: string): void => void live.delete(id)

// How many messages a conversation has now, counting a turn in progress.
export function messageCount(id: string): number {
  try {
    return (live.get(id) ?? getConversation(id))?.messages.length ?? 0
  } catch {
    return 0
  }
}

// A conversation's mode, counting one whose first turn is still in progress.
export function conversationMode(id: string): Mode | null {
  try {
    return (live.get(id) ?? getConversation(id))?.mode ?? null
  } catch {
    return null
  }
}

// Applies a change to the current copy of a conversation and saves it.
export function updateConversation(
  id: string,
  change: (c: Conversation) => void
): Conversation | null {
  const c = live.get(id) ?? getConversation(id)
  if (!c) return null
  change(c)
  saveConversation(c)
  return c
}

// Every saved chat's id, from the file names (a file that can't be read, and
// an old chat, still count: the startup sweeps keep their files).
export const conversationIds = (): string[] => chatFiles().map((f) => f.slice(0, -'.json'.length))

// Whether there is a chat file for this id, old or new.
export const conversationExists = (id: string): boolean => existsSync(file(id))

// Every chat in Custard's format, whatever its mode (for links between
// chats). Old chats are left out.
export function allConversations(): Conversation[] {
  return chatFiles().flatMap((f) => {
    try {
      const r = readChatFile(f)
      return 'chat' in r ? [r.chat] : []
    } catch {
      return []
    }
  })
}

// A chat in Custard's format, or null: there is no such chat, or it is an
// old chat (see oldChat), which nothing may read as a chat.
export function getConversation(id: string): Conversation | null {
  if (!existsSync(file(id))) return null
  const r = readChatFile(`${basename(file(id))}`)
  return 'chat' in r ? r.chat : null
}

// The old chat with this id, or null.
export function oldChat(id: string): OldChat | null {
  if (!existsSync(file(id))) return null
  const r = readChatFile(`${basename(file(id))}`)
  return 'old' in r ? r.old : null
}

// Every old chat's id.
export const oldChatIds = (): string[] =>
  chatFiles().flatMap((f) => {
    try {
      const r = readChatFile(f)
      return 'old' in r ? [r.old.id] : []
    } catch {
      return []
    }
  })

export function newConversation(mode: Mode, firstMessage: string): Conversation {
  const now = Date.now()
  const title = firstMessage.trim().replace(/\s+/g, ' ').slice(0, 60) || 'New chat'
  return {
    format: CHAT_FORMAT,
    version: CHAT_VERSION,
    id: randomUUID(),
    mode,
    title,
    createdAt: now,
    updatedAt: now,
    messages: []
  }
}

// Saved often during a turn (after every tool call), so written to a
// temporary file and renamed: a crash mid-write leaves the last good copy.
export function saveConversation(c: Conversation): void {
  c.updatedAt = Date.now()
  const target = file(c.id)
  writeFileSync(`${target}.tmp`, JSON.stringify(c))
  renameSync(`${target}.tmp`, target)
}

// Removes the prompt-cache snapshot (see main/promptCache) from every chat,
// saved or in a turn: it holds a copy of the memory the chat last sent, so
// after a Forget nothing forgotten stays on disk there. Each chat's next
// message rebuilds its prompt (one cache write). Saved without touching
// updatedAt, so the history order doesn't change.
export function clearPromptSnapshots(): void {
  for (const c of live.values()) delete c.promptCache
  for (const f of readdirSync(dir()).filter((f) => f.endsWith('.json'))) {
    const path = join(dir(), f)
    try {
      const c = JSON.parse(readFileSync(path, 'utf8')) as Conversation
      if (!c.promptCache) continue
      delete c.promptCache
      writeFileSync(`${path}.tmp`, JSON.stringify(c))
      renameSync(`${path}.tmp`, path)
    } catch (err) {
      console.error('Clearing a prompt snapshot:', f, err)
    }
  }
}

export function deleteConversation(id: string): void {
  rmSync(file(id), { force: true })
}

type Config = {
  chat: ChatSettings
  design: DesignSettings
  vaultPath: string | null
  security: SecurityDefaults
  memory: MemorySettings
  vaultGrants: VaultGrant[]
  automations: Automation[]
  // Monthly spending budget in dollars, or null for none.
  budget: number | null
}

const defaultSecurity: SecurityDefaults = { askBeforeWriteTools: true }

function readConfig(): Config {
  // First run: defaults. An unreadable file is kept aside (see settingsFile).
  const raw = readSettingsFile(settingsFile()) as Partial<Config> & Partial<ChatSettings>
  // Older versions stored the chat settings at the top level.
  const legacy: Partial<ChatSettings> = raw.model ? { model: raw.model } : {}
  if (raw.effort) legacy.effort = raw.effort
  return {
    chat: { ...defaultChatSettings, ...legacy, ...raw.chat },
    design: normalizeDesignSettings(raw.design),
    vaultPath: raw.vaultPath ?? null,
    security: { ...defaultSecurity, ...raw.security },
    memory: { ...defaultMemorySettings, ...raw.memory },
    vaultGrants: normalizeGrants(raw.vaultGrants).grants,
    automations: normalizeAutomations(raw.automations),
    budget: normalizeBudget(raw.budget)
  }
}

// Unknown keys in the file are kept, so settings from other versions survive.
function writeConfig(patch: Partial<Config>): void {
  const raw = readSettingsFile(settingsFile())
  writeSettingsFile(settingsFile(), { ...raw, ...readConfig(), ...patch })
}

export const getBudget = (): number | null => readConfig().budget
export const setBudget = (budget: unknown): number | null => {
  const b = normalizeBudget(budget)
  writeConfig({ budget: b })
  return b
}

// What model calls used and cost (see usage.ts).
let ledger: UsageLedger | null = null
export const usageLedger = (): UsageLedger =>
  (ledger ??= new UsageLedger(join(app.getPath('userData'), 'usage.json')))
export const charge: Charge = (chat, model, u) =>
  charger(usageLedger(), updateConversation)(chat, model, u)
export const usageThisMonth = (): UsageMonth => usageLedger().thisMonth(getBudget())

export const getDesignSettings = (): DesignSettings => readConfig().design
export const setDesignSettings = (design: unknown): void =>
  writeConfig({ design: normalizeDesignSettings(design) })
export const getChatSettings = (): ChatSettings => readConfig().chat
export const setChatSettings = (chat: ChatSettings): void => writeConfig({ chat })
export const getVaultPath = (): string | null => readConfig().vaultPath
export const setVaultPath = (vaultPath: string | null): void => writeConfig({ vaultPath })
export const getSecurityDefaults = (): SecurityDefaults => readConfig().security
export const setSecurityDefaults = (security: SecurityDefaults): void => writeConfig({ security })
export const getMemorySettings = (): MemorySettings => readConfig().memory
export const setMemorySettings = (memory: MemorySettings): void => writeConfig({ memory })

// Folders the user lets Claude change without asking about each edit.
export const getVaultGrants = (): VaultGrant[] => readConfig().vaultGrants
export const setVaultGrants = (grants: unknown): VaultGrant[] => {
  const vaultGrants = normalizeGrants(grants).grants
  writeConfig({ vaultGrants })
  return vaultGrants
}

// Where the record of Claude's changes to notes is kept: app data, not the vault.
export const vaultEditsDir = (): string => join(app.getPath('userData'), 'vault-edits')

// Automations the user created in Settings, and where their run records go.
export const getAutomations = (): Automation[] => readConfig().automations
export const setAutomations = (automations: Automation[]): void =>
  writeConfig({ automations: normalizeAutomations(automations) })
export const automationRunsDir = (): string => join(app.getPath('userData'), 'automation-runs')
export const automationQuestionsFile = (): string =>
  join(app.getPath('userData'), 'automation-questions.json')
