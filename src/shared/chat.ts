import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import type { Workspace } from './plugins'

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

// What became of one tool call. Saved as it changes, so a chat reloaded after
// a crash still knows which actions ran.
//   completed / failed: it ran and reported success or an error.
//   not-run: nothing was done (declined, stopped before it started, refused).
//   unknown: a write was already sent when it timed out, crashed or was
//   stopped, so it may or may not have taken effect.
export type ActionStatus = 'pending' | 'running' | 'completed' | 'failed' | 'not-run' | 'unknown'

export type ActionRecord = {
  name: string
  label: string
  write: boolean
  status: ActionStatus
  // Name and input together, to spot a repeat of an unknown-outcome action.
  key: string
  // What the call returned (or why it didn't run), as sent to the model.
  result?: string
}

export type NoticeKind = 'stopped' | 'error' | 'interrupted' | 'cut-off' | 'step-limit'

// Shown in the chat after message `after - 1`.
export type Notice = { after: number; kind: NoticeKind; text: string }

// A web page found by Custard's search or read with web_read. Shown under the
// answer as cited (the answer links it) or only consulted. Fields come from
// the provider or the page; nothing is filled in.
export type WebSource = {
  url: string
  // Index of the user message that started the turn.
  turn: number
  origin: 'search' | 'read'
  title?: string
  // Search results: the query, and the provider's own page date and cited
  // passage when it gave them.
  query?: string
  pageAge?: string
  citedText?: string
}

// Automatic memory for a chat (see main/memory). Capture only ever writes
// notes; it never runs an action.
//   pending: waiting to run (or for the vault to be connected)
//   saved: written to the notes in `notes`
//   skipped: nothing worth keeping, the user asked not to, or the vault changed
//   failed: couldn't be written; `reason` says why
//   off: memory is off for this chat or for Custard
export type CaptureStatus = 'pending' | 'saved' | 'skipped' | 'failed' | 'off'

export type CaptureJob = {
  // Chat id and message range: the same range always gets the same id.
  id: string
  from: number
  to: number
  status: CaptureStatus
  attempts: number
  // Which vault it belongs to (see memory/write vaultId), and whose cheapest
  // model summarizes it.
  vault?: string
  provider?: Provider
  // The note's parts, once summarized, so a retry after a crash writes the
  // same note instead of asking the model again. Removed once saved.
  plan?: { plugin: string; section: string; text: string }[]
  notes?: string[]
  // Why it was skipped or failed, in words for the user.
  reason?: string
  at: number
}

export type ChatMemory = {
  // "Don't remember this chat".
  off?: boolean
  // "Forget this chat": its capture notes were deleted and it is never
  // remembered again. Nothing of what was forgotten is kept.
  forgotten?: boolean
  // Messages before this index are never captured again.
  watermark: number
  job?: CaptureJob
}

export type Conversation = ConversationSummary & {
  createdAt: number
  // Code mode only: which folder the file tools may touch. Fixed when the
  // conversation starts.
  workspace?: Workspace
  // Exactly what is sent to the API, so assistant turns keep their thinking
  // blocks unchanged between requests.
  messages: BetaMessageParam[]
  // By tool_use id.
  actions?: Record<string, ActionRecord>
  notices?: Notice[]
  sources?: WebSource[]
  memory?: ChatMemory
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
      status: 'running' | 'done' | 'error' | 'not-run' | 'unknown'
      write?: boolean
    }
  // A plugin action waits for the user's go-ahead.
  | {
      requestId: string
      type: 'approval'
      id: string
      plugin: string
      label: string
      detail: string
      // Set when this repeats an action whose outcome is unknown.
      warning?: string
    }
  | { requestId: string; type: 'approval-done'; id: string }
  | { requestId: string; type: 'done'; conversation: Conversation }
  // `kept`: the turn stayed in the history (something had already happened),
  // so the message must not be put back in the box to be sent again.
  | {
      requestId: string
      type: 'error'
      message: string
      conversation: Conversation | null
      kept: boolean
    }

export type SendChatRequest = {
  requestId: string
  conversationId: string | null
  mode: Mode
  text: string
  settings: ChatSettings
  // For a new Code-mode conversation.
  workspace?: Workspace
}

export type ApprovalDecision = 'once' | 'chat' | 'deny'
