import type {
  BetaMessageParam,
  BetaTool,
  BetaToolResultBlockParam
} from '@anthropic-ai/sdk/resources/beta/messages/messages'
import type { ModelCapabilities, ModelInfo, ProviderErrorKind } from '../../shared/adapter'
import type { ChatEvent, Conversation, Effort } from '../../shared/chat'
import type { TokenUsage } from '../../shared/pricing'
import type { Provider, ProviderApi } from '../../shared/providers'
import type { TurnLog } from '../turn'

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

// listModels(): the models Custard offers for this provider, each marked with
// whether the key can use it, plus any the provider lists that Custard has no
// profile for.
export type ModelListing = {
  models: (ModelInfo & { available: boolean | 'unchecked' })[]
  // When the list came from the provider, or null when it couldn't be asked
  // (no key, no list endpoint, offline) and only Custard's profiles are shown.
  checkedAt: number | null
}

// sendMessage(): one call, not streamed to the user. Background summaries
// (captures, chat notes, Continue), chat titles and automation steps.
export type OneShotRequest = {
  model: string
  apiKey: string
  system: string
  messages: BetaMessageParam[]
  tools?: BetaTool[]
  // Ask for JSON matching this schema (structured output).
  schema?: { name: string; schema: Record<string, unknown> }
  maxTokens: number
  effort?: Effort
  timeoutMs?: number
  retries?: number
  signal?: AbortSignal
}

export type OneShotResult = {
  text: string
  calls: { id: string; name: string; input: unknown }[]
  // done; cut-off (output limit); refused (the model declined); too-long
  // (the context window filled).
  stop: 'done' | 'cut-off' | 'refused' | 'too-long'
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
  instructions: string
  history: BetaMessageParam[]
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

// How a turn ended. Custard turns each into the notice the user sees.
export type TurnEnd =
  | 'done'
  | 'cut-off'
  // Cut off while calling a tool, so nothing was run.
  | 'cut-off-tool'
  | 'step-limit'
  // Too long to send, found before sending.
  | 'too-long'
  // The reply filled the model's context window.
  | 'full-window'
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
}
