import { app } from 'electron'
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
import { defaultMemorySettings, type MemorySettings } from '../shared/memory'

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

export function listConversations(mode: Mode): ConversationSummary[] {
  return readdirSync(dir())
    .filter((f) => f.endsWith('.json'))
    .flatMap((f) => {
      try {
        const c = withMode(JSON.parse(readFileSync(join(dir(), f), 'utf8')))
        return c.mode === mode
          ? [
              {
                id: c.id,
                mode: c.mode,
                title: c.title,
                updatedAt: c.updatedAt,
                ...(c.memory?.temporary ? { temporary: true } : {})
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
  vaultPath: string | null
  security: SecurityDefaults
  memory: MemorySettings
}

const defaultSecurity: SecurityDefaults = { askBeforeWriteTools: true }

function readConfig(): Config {
  let raw: Partial<Config> & Partial<ChatSettings> = {}
  try {
    raw = JSON.parse(readFileSync(settingsFile(), 'utf8'))
  } catch {
    // First run or unreadable file: use defaults.
  }
  // Older versions stored the chat settings at the top level.
  const legacy: Partial<ChatSettings> = raw.model ? { model: raw.model } : {}
  if (raw.effort) legacy.effort = raw.effort
  return {
    chat: { ...defaultChatSettings, ...legacy, ...raw.chat },
    vaultPath: raw.vaultPath ?? null,
    security: { ...defaultSecurity, ...raw.security },
    memory: { ...defaultMemorySettings, ...raw.memory }
  }
}

// Unknown keys in the file are kept, so settings from other versions survive.
function writeConfig(patch: Partial<Config>): void {
  let raw: Record<string, unknown> = {}
  try {
    raw = JSON.parse(readFileSync(settingsFile(), 'utf8'))
  } catch {
    // First write.
  }
  writeFileSync(settingsFile(), JSON.stringify({ ...raw, ...readConfig(), ...patch }))
}

export const getChatSettings = (): ChatSettings => readConfig().chat
export const setChatSettings = (chat: ChatSettings): void => writeConfig({ chat })
export const getVaultPath = (): string | null => readConfig().vaultPath
export const setVaultPath = (vaultPath: string | null): void => writeConfig({ vaultPath })
export const getSecurityDefaults = (): SecurityDefaults => readConfig().security
export const setSecurityDefaults = (security: SecurityDefaults): void => writeConfig({ security })
export const getMemorySettings = (): MemorySettings => readConfig().memory
export const setMemorySettings = (memory: MemorySettings): void => writeConfig({ memory })
