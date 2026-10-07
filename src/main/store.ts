import { app } from 'electron'
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  defaultChatSettings,
  type ChatSettings,
  type Conversation,
  type ConversationSummary
} from '../shared/chat'

// Conversations are plain JSON files in the app's data folder, one per chat.
const dir = (): string => {
  const d = join(app.getPath('userData'), 'conversations')
  mkdirSync(d, { recursive: true })
  return d
}
const file = (id: string): string => join(dir(), `${id.replace(/[^\w-]/g, '')}.json`)
const settingsFile = (): string => join(app.getPath('userData'), 'settings.json')

export function listConversations(): ConversationSummary[] {
  return readdirSync(dir())
    .filter((f) => f.endsWith('.json'))
    .flatMap((f) => {
      try {
        const c = JSON.parse(readFileSync(join(dir(), f), 'utf8')) as Conversation
        return [{ id: c.id, title: c.title, updatedAt: c.updatedAt }]
      } catch {
        return []
      }
    })
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export function getConversation(id: string): Conversation | null {
  if (!existsSync(file(id))) return null
  return JSON.parse(readFileSync(file(id), 'utf8')) as Conversation
}

export function newConversation(firstMessage: string): Conversation {
  const now = Date.now()
  const title = firstMessage.trim().replace(/\s+/g, ' ').slice(0, 60) || 'New chat'
  return { id: randomUUID(), title, createdAt: now, updatedAt: now, messages: [] }
}

export function saveConversation(c: Conversation): void {
  c.updatedAt = Date.now()
  writeFileSync(file(c.id), JSON.stringify(c))
}

export function deleteConversation(id: string): void {
  rmSync(file(id), { force: true })
}

export function getChatSettings(): ChatSettings {
  try {
    return { ...defaultChatSettings, ...JSON.parse(readFileSync(settingsFile(), 'utf8')) }
  } catch {
    return defaultChatSettings
  }
}

export function setChatSettings(s: ChatSettings): void {
  writeFileSync(settingsFile(), JSON.stringify(s))
}
