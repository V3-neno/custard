import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import type { Workspace } from './plugins'
import type { Attachment, AttachmentKind } from './attachments'

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
  { id: 'design', label: 'Design', hint: 'Shape interfaces and visuals' },
  // Was "Code". The id stays `code` so saved chats and skills' `modes:` keep
  // working.
  { id: 'code', label: 'Plugins', hint: 'Build and improve plugins' },
  { id: 'skills', label: 'Skills', hint: 'Teach Custard skills and improve your vault' }
] as const

export type Mode = (typeof modes)[number]['id']

export const isMode = (m: unknown): m is Mode => modes.some((x) => x.id === m)

export type ConversationSummary = {
  id: string
  mode: Mode
  title: string
  updatedAt: number
  // Where the chat stands, from its summary note (History shows it).
  summary?: string
  // A temporary chat: never remembered.
  temporary?: boolean
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

// too-long: the chat no longer fits what the model can take; it can go on in
// a new chat (see main/continue).
export type NoticeKind =
  | 'stopped'
  | 'error'
  | 'interrupted'
  | 'cut-off'
  | 'step-limit'
  | 'too-long'
  // Earlier attached files that weren't sent with this turn, and why.
  | 'files'

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
  // Not remembered from now on.
  off?: boolean
  // Started as a temporary chat: never remembered, from its first message.
  temporary?: boolean
  // "Forget this chat": its capture notes were deleted and it is never
  // remembered again. Nothing of what was forgotten is kept.
  forgotten?: boolean
  // Messages before this index are never captured again.
  watermark: number
  job?: CaptureJob
}

// Each chat's compacted summary, kept as one note in Custard/Chats that
// Custard rewrites as the chat goes on (see main/chatNotes).
export type ChatNote = {
  // Not written (yet), written, couldn't be written, not for this chat, or
  // changed or deleted outside Custard, so Custard leaves it alone for good.
  status: 'pending' | 'saved' | 'failed' | 'off' | 'edited' | 'deleted'
  // Vault path, once written.
  path?: string
  // Messages the note covers.
  upTo: number
  // Of the text Custard last wrote, to tell when someone else changed it.
  hash?: string
  at: number
  reason?: string
  goal?: string
  state?: string
  provider?: Provider
}

// A chat that continues an earlier one that grew too long. The earlier chat
// is left exactly as it was.
export type Continuation = {
  from: { id: string; title: string }
  // Written by a tool-less model from bounded evidence; null when the user
  // continued without one (it failed, or they chose not to wait).
  summary: {
    goal: string
    constraints: string[]
    decisions: string[]
    open: string[]
    state: string
  } | null
  // Written by code from the earlier chat's action records. Authoritative.
  ledger: string
  counts: Record<string, number>
  // Actions whose outcome is unknown, still guarded against repeats here.
  unknown: { key: string; name: string; label: string }[]
  // Files attached in the earlier chat (and the chats before it). They are
  // not carried over: the new chat can't see them.
  files?: { name: string; kind: AttachmentKind }[]
  // How many more there were than `files` lists.
  moreFiles?: number
  at: number
}

export type Conversation = ConversationSummary & {
  createdAt: number
  // Plugins mode only: which plugin's folder the file tools may touch. Fixed
  // when the conversation starts.
  workspace?: Workspace
  // Exactly what is sent to the API, so assistant turns keep their thinking
  // blocks unchanged between requests.
  messages: BetaMessageParam[]
  // By tool_use id.
  actions?: Record<string, ActionRecord>
  notices?: Notice[]
  sources?: WebSource[]
  memory?: ChatMemory
  // Its summary note in Custard/Chats.
  chatNote?: ChatNote
  continuedFrom?: Continuation
  // Open questions from automation runs shown to the model in this chat (ids).
  // Their text came from a run that read notes and plugin text.
  questions?: string[]
  // Why the chat holds text Custard can't vouch for besides web and plugin
  // results, which show in `actions`: it read notes it can't vouch for, or
  // was shown captures made from chats that held outside text.
  outside?: ('notes' | 'memory')[]
  // Where a provider's compaction summarized everything before message
  // `after`. The messages themselves are kept and shown in full.
  compactions?: Compaction[]
  // How much of the model's input budget the last request used.
  context?: ContextUse
  // Files sent with user messages (Chat mode). The bytes are in app data;
  // each request builds the provider's blocks from them.
  attachments?: Attachment[]
}

// Claude's compaction block is part of the assistant message at `after`, as
// the API requires; OpenAI's encrypted item is kept here, with the model it
// came from, and is only sent back to that model.
export type Compaction = {
  after: number
  at: number
  provider: Provider
  model: string
  item?: { id?: string; encrypted_content: string }
}

export type ContinueResult =
  { ok: true; conversation: Conversation } | { ok: false; error: string; canSkipSummary: boolean }

export type ChatLink = { id: string; title: string; mode: Mode }

export type ContextUse = {
  tokens: number
  budget: number
  // Counted by the provider's token-counting endpoint (itself documented as
  // an estimate), or Custard's own estimate.
  counted: boolean
  // Past the share of the budget where the chat says it is getting long.
  warn: boolean
  model: string
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
      // Everything the user approves, never shortened.
      detail: string
      // Set when this repeats an action whose outcome is unknown.
      warning?: string
      // Only "Allow" and "Don't allow": this kind of action asks every time.
      individual?: boolean
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
      // The chat is too long for the model: offer to continue in a new chat.
      overflow?: boolean
    }
  // The provider is summarizing earlier messages to make room.
  | { requestId: string; type: 'compacting' }

export type SendChatRequest = {
  requestId: string
  conversationId: string | null
  mode: Mode
  text: string
  settings: ChatSettings
  // For a new Code-mode conversation.
  workspace?: Workspace
  // Start the new conversation as a temporary chat, never remembered.
  temporary?: boolean
  // Chat mode: the files picked for this message, from its draft, in order.
  attachments?: { draft: string; ids: string[] }
}

export type ApprovalDecision = 'once' | 'chat' | 'deny'
