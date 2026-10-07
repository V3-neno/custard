import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages'

export const chatModels = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5', effort: true, fallbacks: true },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', effort: true, fallbacks: true },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5', effort: false, fallbacks: false }
] as const

export type ChatModel = (typeof chatModels)[number]['id']
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export const efforts: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

export type ChatSettings = { model: ChatModel; effort: Effort }

export const defaultChatSettings: ChatSettings = { model: 'claude-opus-5-5', effort: 'medium' }

export type ConversationSummary = {
  id: string
  title: string
  updatedAt: number
}

export type Conversation = ConversationSummary & {
  createdAt: number
  // Exactly what is sent to the API, so assistant turns keep their thinking
  // blocks unchanged between requests.
  messages: BetaMessageParam[]
}

export type ChatEvent =
  | { requestId: string; type: 'thinking'; text: string }
  | { requestId: string; type: 'text'; text: string }
  | { requestId: string; type: 'fallback'; from: string; to: string }
  | {
      requestId: string
      type: 'tool'
      id: string
      label: string
      status: 'running' | 'done' | 'error'
    }
  | { requestId: string; type: 'done'; conversation: Conversation }
  | { requestId: string; type: 'error'; message: string; conversation: Conversation | null }

export type SendChatRequest = {
  requestId: string
  conversationId: string | null
  text: string
  settings: ChatSettings
}
