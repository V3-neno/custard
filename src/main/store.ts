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
  writeFileSync
} from 'fs'
import { join } from 'path'
import {
  defaultChatSettings,
  type ChatSettings,
  type Conversation,
  type ConversationSummary,
  type Mode
} from '../shared/chat'
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

// Every mode's when `mode` is null.
export function listConversations(mode: Mode | null): ConversationSummary[] {
  return readdirSync(dir())
    .filter((f) => f.endsWith('.json'))
    .flatMap((f) => {
      try {
        const c = withMode(JSON.parse(readFileSync(join(dir(), f), 'utf8')))
        return mode === null || c.mode === mode
          ? [
              {
                id: c.id,
                mode: c.mode,
                title: c.title,
                updatedAt: c.updatedAt,
                ...(c.memory?.temporary ? { temporary: true } : {}),
                // Where the chat stands, from its note in Custard/Chats.
                ...(c.chatNote?.state &&
                (c.chatNote.status === 'saved' || c.chatNote.status === 'edited')
                  ? { summary: c.chatNote.state }
                  : {})
              }
            ]
          : []
      } catch {
        return []
      }
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

// Every saved conversation, whatever its mode (for links between chats).
// Every saved chat's id, from the file names (a file that can't be read
// still counts).
export const conversationIds = (): string[] =>
  readdirSync(dir())
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length))

export function allConversations(): Conversation[] {
  return readdirSync(dir())
    .filter((f) => f.endsWith('.json'))
    .flatMap((f) => {
      try {
        return [withMode(JSON.parse(readFileSync(join(dir(), f), 'utf8')))]
      } catch {
        return []
      }
    })
}

export function getConversation(id: string): Conversation | null {
  if (!existsSync(file(id))) return null
  return withMode(JSON.parse(readFileSync(file(id), 'utf8')))
}

export function newConversation(mode: Mode, firstMessage: string): Conversation {
  const now = Date.now()
  const title = firstMessage.trim().replace(/\s+/g, ' ').slice(0, 60) || 'New chat'
  return { id: randomUUID(), mode, title, createdAt: now, updatedAt: now, messages: [] }
}

// Saved often during a turn (after every tool call), so written to a
// temporary file and renamed: a crash mid-write leaves the last good copy.
export function saveConversation(c: Conversation): void {
  c.updatedAt = Date.now()
  const target = file(c.id)
  writeFileSync(`${target}.tmp`, JSON.stringify(c))
  renameSync(`${target}.tmp`, target)
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
    automations: normalizeAutomations(raw.automations)
  }
}

// Unknown keys in the file are kept, so settings from other versions survive.
function writeConfig(patch: Partial<Config>): void {
  const raw = readSettingsFile(settingsFile())
  writeSettingsFile(settingsFile(), { ...raw, ...readConfig(), ...patch })
}

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
