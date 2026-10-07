import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages'

export type Provider = 'claude' | 'openai'

export const providerNames: Record<Provider, string> = { claude: 'Claude', openai: 'OpenAI' }

// Picking a model picks its provider; the app's tint follows it.
export const chatModels = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5', provider: 'claude', effort: true, fallbacks: true },
  {
    id: 'claude-sonnet-5-5',
    label: 'Sonnet 5.5',
    provider: 'claude',
    effort: true,
    fallbacks: true
  },
  {
    id: 'claude-haiku-4-5',
    label: 'Haiku 4.5',
    provider: 'claude',
    effort: false,
    fallbacks: false
  },
  { id: 'gpt-6-astra', label: 'GPT-6 Astra', provider: 'openai', effort: true, fallbacks: false },
  { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', provider: 'openai', effort: true, fallbacks: false },
  { id: 'gpt-6-luna', label: 'GPT-6 Luna', provider: 'openai', effort: true, fallbacks: false }
] as const

export type ChatModel = (typeof chatModels)[number]['id']
export const providerOf = (model: string): Provider =>
  chatModels.find((m) => m.id === model)?.provider ?? 'claude'

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export const efforts: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

export type ChatSettings = { model: ChatModel; effort: Effort }

export const defaultChatSettings: ChatSettings = { model: 'claude-opus-5-5', effort: 'medium' }

export const modes = [
  { id: 'chat', label: 'Chat', hint: 'Talk anything through' },
  { id: 'code', label: 'Code', hint: 'Write, debug and explain code' },
  { id: 'design', label: 'Design', hint: 'Shape interfaces and visuals' },
  { id: 'skills', label: 'Skills', hint: 'Teach Custard skills and improve your vault' }
] as const

export type Mode = (typeof modes)[number]['id']

export type ConversationSummary = {
  id: string
  mode: Mode
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
  mode: Mode
  text: string
  settings: ChatSettings
}
