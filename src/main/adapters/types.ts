import type {
  BetaMessageParam,
  BetaTextBlockParam,
  BetaTool,
  BetaToolResultBlockParam
} from '@anthropic-ai/sdk/resources/beta/messages/messages'
import type { ListedModel, ModelCapabilities, ProviderErrorKind } from '../../shared/adapter'
import type { ChatEvent, Conversation, Effort } from '../../shared/chat'
import type { TokenUsage } from '../../shared/pricing'
import type { Provider, ProviderApi } from '../../shared/providers'
import type { TurnLog } from '../turn'
import type { SearchOutcome } from '../web/search'

// The one interface every provider implements. Custard's own work (vault
// tools, plugins, approvals, memory, chat notes, the cost meter) sits above
// it and never asks which provider it is talking to; an adapter only turns
// Custard's requests into its provider's API and back.
//
// Conversations stay in one stored format (Anthropic's message blocks) so any
// provider can continue any chat; an adapter converts on the way out and the
// way back. Failures are thrown as ProviderError (see providerError.ts).
//
// Keys come from apiKey.ts for each call and are never kept by an adapter.

// authenticate(): whether a key works, checked with the cheapest call the
// provider offers (its model list).
export type AuthResult =
  | { ok: true }
  // `kind` from ProviderError: 'auth' means the key is wrong; 'network',
  // 'timeout' and the rest mean it couldn't be checked.
  | { ok: false; kind: ProviderErrorKind; message: string }

// listModels(): with no key, Custard's own models marked unchecked, and no
// call. With a key, one call to the provider's model list: each of Custard's
// models marked available or not for this key, plus (where the provider
// profile says discoverModels) the ones Custard has no profile for, as
// source 'discovered'. Throws a ProviderError, with the key hidden, when the
// list can't be had.
export type ModelListing = {
  models: ListedModel[]
  // When the list came from the provider, or null when it wasn't asked.
  checkedAt: number | null
}

// sendMessage(): one call, not streamed to the user. Background summaries
// (captures, chat notes and their titles, Continue) and automation steps.
export type OneShotRequest = {
  model: string
  apiKey: string
  system: string
  // A bare string is one user message.
  messages: BetaMessageParam[] | string
  // Ask for JSON matching this schema (structured output).
  schema?: { name: string; schema: Record<string, unknown> }
  // Tools the model may call; the calls come back in `calls`, unrun.
  tools?: BetaTool[]
  // The output limit. Without one, Claude gets 16,000 (its API needs a
  // limit) and a Responses provider gets none.
  maxTokens?: number
  // Claude: wait for the reply over a stream, as long replies need (the SDK
  // refuses a plain request it expects to run past its timeout). A Responses
  // provider sends one plain request either way.
  stream?: boolean
  // Responses providers only; Claude's one-shot model (Haiku 4.5) takes none.
  effort?: Effort
  timeoutMs?: number
  retries?: number
  signal?: AbortSignal
}

export type OneShotResult = {
  text: string
  calls: { id: string; name: string; input: unknown }[]
  // done; cut-off (output limit); refused (the model declined); too-long
  // (the context window filled); failed (the provider says it couldn't
  // finish, with its reason in `error`).
  stop: 'done' | 'cut-off' | 'refused' | 'too-long' | 'failed'
  error?: string
  // What each model used, already split by model when a fallback answered.
  usage: { model: string; usage: TokenUsage }[]
}

// streamMessage(): a chat turn, streamed through `emit`, running tool rounds
// through Custard's `runRound` (which owns approvals and the chat guard).
export type TurnRequest = {
  requestId: string
  model: string
  apiKey: string
  effort: Effort
  system: BetaTextBlockParam[]
  // The chat as it stands, in the stored format, read again before each
  // model call (tool rounds add to it). The adapter drops what its provider
  // can't take.
  history: () => BetaMessageParam[]
  conversation: Conversation
  tools: BetaTool[]
  maxSteps: number
  // Checks a request against the model's budget before it is sent.
  fits: (estimate: number, count: () => Promise<number>) => Promise<boolean>
  onUsage: (model: string, u: TokenUsage) => void
  signal: AbortSignal
  emit: (e: ChatEvent) => void
  log: TurnLog
  runRound: (
    calls: { id: string; name: string; input: unknown }[]
  ) => Promise<BetaToolResultBlockParam[]>
}

// How a turn ended. Custard turns each into the notice the user sees; the
// ones marked "taken back" end it the way a failure does.
export type TurnEnd =
  | 'done'
  // The output limit cut the answer.
  | 'cut-off'
  // Cut off while calling a tool, so nothing was run (taken back).
  | 'cut-off-tool'
  | 'step-limit'
  // Too long to send, found before sending (taken back).
  | 'too-long'
  // The reply filled the model's context window.
  | 'full-window'
  // The reply filled the window while calling a tool (taken back).
  | 'full-window-tool'
  // The user stopped it (taken back).
  | 'stopped'
  // The model declined; the sentence for the user (taken back).
  | { refused: string }

export interface ProviderAdapter {
  readonly id: Provider
  readonly api: ProviderApi
  authenticate(apiKey: string, signal?: AbortSignal): Promise<AuthResult>
  listModels(apiKey: string | null, signal?: AbortSignal): Promise<ModelListing>
  // From Custard's own rules, so it never disagrees with what a request does.
  getCapabilities(modelId: string): ModelCapabilities
  sendMessage(req: OneShotRequest): Promise<OneShotResult>
  streamMessage(turn: TurnRequest): Promise<TurnEnd>
  // Where the history this provider sees for a chat starts: after the
  // newest compaction it can read, or 0. Attached files before it aren't
  // sent again.
  historyStart(conversation: Conversation, modelId: string): number
  // One web search for the web_search tool, in a call of its own that holds
  // only the query (see web/search.ts). Whether a model has search at all is
  // in getCapabilities; a model without it gets an outcome saying so, and is
  // never offered the tool.
  webSearch(req: WebSearchRequest): Promise<SearchOutcome>
}

export type WebSearchRequest = {
  model: string
  apiKey: string
  query: string
  signal: AbortSignal
}
