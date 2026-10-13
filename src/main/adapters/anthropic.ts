import Anthropic from '@anthropic-ai/sdk'
import type {
  BetaContentBlock,
  BetaContentBlockParam,
  MessageCreateParamsStreaming
} from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { chatModels } from '../../shared/chat'
import { claudeFilesFrom } from '../attachments/request'
import {
  claudeHistory,
  compactionRefused,
  isCompactionRejected,
  recordClaudeCompaction,
  usesCompaction
} from '../compaction'
import {
  claudeCounter,
  COMPACTION_INSTRUCTIONS,
  compactTrigger,
  estimateTokens,
  fromLastCompaction
} from '../context'
import { anthropicEndpoint } from '../endpoints'
import { claudeParts, fromClaude } from '../usage'
import { authenticateWith, knownModels } from './common'
import { capabilitiesOf } from './capabilities'
import type { OneShotRequest, OneShotResult, ProviderAdapter, TurnEnd, TurnRequest } from './types'

// Claude, through Anthropic's Messages API. The stored chat format is this
// API's own, so history goes out as it is (less compaction blocks for a model
// that doesn't compact).

// After a mid-answer fallback, blocks the declining model produced before the
// last `fallback` marker (other than text) must not be sent back to the API.
export function echoableContent(content: BetaContentBlock[]): BetaContentBlockParam[] {
  const boundary = content.map((b) => b.type).lastIndexOf('fallback')
  return content.filter(
    (b, i) =>
      i >= boundary ||
      !(b.type === 'thinking' || b.type === 'redacted_thinking' || b.type === 'tool_use')
  ) as BetaContentBlockParam[]
}

const client = (apiKey: string, opts: { timeout?: number; maxRetries?: number } = {}): Anthropic =>
  new Anthropic({ apiKey, ...opts, ...anthropicEndpoint() })

async function streamMessage(turn: TurnRequest): Promise<TurnEnd> {
  const { requestId, emit, log, signal } = turn
  const model = chatModels.find((m) => m.id === turn.model) ?? chatModels[0]
  const history = (): TurnRequest['conversation']['messages'] =>
    claudeHistory(turn.history(), model.id)
  const params: MessageCreateParamsStreaming = {
    model: model.id,
    max_tokens: 64000,
    system: turn.system,
    messages: history(),
    cache_control: { type: 'ephemeral' },
    stream: true
  }
  if (turn.tools.length) params.tools = turn.tools
  if (model.effort) {
    params.thinking = { type: 'adaptive', display: 'summarized' }
    params.output_config = { effort: turn.effort }
  }
  if (model.fallbacks) {
    // If a safety classifier declines, the API retries on Anthropic's
    // recommended fallback model instead of returning a refusal.
    params.betas = ['server-side-fallback-2026-07-01']
    params.fallbacks = 'default'
  }
  // Claude summarizes earlier messages itself once the input passes the
  // trigger, and returns a compaction block that is kept in the history.
  const compact = (on: boolean): void => {
    params.betas = (params.betas ?? []).filter((b) => b !== 'compact-2026-01-12')
    if (on) {
      params.betas.push('compact-2026-01-12')
      params.context_management = {
        edits: [
          {
            type: 'compact_20260112',
            trigger: { type: 'input_tokens', value: compactTrigger(model.id) },
            instructions: COMPACTION_INSTRUCTIONS
          }
        ]
      }
    } else delete params.context_management
    if (!params.betas.length) delete params.betas
  }
  compact(usesCompaction(model.id))

  const api = client(turn.apiKey)
  for (let step = 0; ; step++) {
    if (step === turn.maxSteps) return 'step-limit'
    params.messages = history()
    const { messages, system: sys, tools: offered, thinking, betas } = params
    const count = claudeCounter(api, {
      model: params.model,
      system: sys,
      ...(offered ? { tools: offered } : {}),
      ...(thinking ? { thinking } : {}),
      ...(betas ? { betas } : {}),
      ...(params.context_management ? { context_management: params.context_management } : {})
    })
    const estimate = estimateTokens(sys, offered, fromLastCompaction(messages))
    if (!(await turn.fits(estimate, () => count(messages)))) return 'too-long'
    const stream = api.beta.messages.stream(params, { signal })
    let streamed = false
    let message: Awaited<ReturnType<typeof stream.finalMessage>>
    try {
      for await (const event of stream) {
        streamed = true
        if (event.type === 'content_block_start' && event.content_block.type === 'compaction') {
          emit({ requestId, type: 'compacting' })
        } else if (
          event.type === 'content_block_start' &&
          event.content_block.type === 'fallback'
        ) {
          const { from, to } = event.content_block
          emit({ requestId, type: 'fallback', from: from.model, to: to.model })
        } else if (event.type === 'content_block_delta') {
          if (event.delta.type === 'thinking_delta') {
            emit({ requestId, type: 'thinking', text: event.delta.thinking })
          } else if (event.delta.type === 'text_delta') {
            log.text(event.delta.text)
            emit({ requestId, type: 'text', text: event.delta.text })
          }
        }
      }
      message = await stream.finalMessage()
      for (const part of claudeParts(message.usage, message.model || model.id))
        turn.onUsage(part.model, part.usage)
    } catch (err) {
      // The model doesn't take compaction: send without it from now on.
      if (streamed || !params.context_management || !isCompactionRejected(err)) throw err
      compactionRefused(model.id)
      compact(false)
      step--
      continue
    }
    if (message.stop_reason === 'refusal') {
      const category = message.stop_details?.category
      return { refused: `Claude declined this request${category ? ` (${category})` : ''}.` }
    }
    const toolUses = message.content.filter((b) => b.type === 'tool_use')
    const full = message.stop_reason === 'model_context_window_exceeded'
    if (toolUses.length > 0 && (message.stop_reason === 'max_tokens' || full))
      return full ? 'full-window-tool' : 'cut-off-tool'
    // Before the message goes in, so the record points at it.
    recordClaudeCompaction(turn.conversation, message.content, model.id)
    log.addAssistant(echoableContent(message.content))
    if (full) return 'full-window'
    if (message.stop_reason === 'max_tokens') return 'cut-off'
    if (message.stop_reason !== 'tool_use') return 'done'
    await turn.runRound(toolUses)
    if (signal.aborted) return 'stopped'
  }
}

// Effort isn't sent: the one-shot calls use Haiku 4.5, which doesn't take
// it.
async function sendMessage(req: OneShotRequest): Promise<OneShotResult> {
  const api = client(req.apiKey, {
    ...(req.timeoutMs !== undefined ? { timeout: req.timeoutMs } : {}),
    ...(req.retries !== undefined ? { maxRetries: req.retries } : {})
  })
  const m = await api.messages.create(
    {
      model: req.model,
      max_tokens: req.maxTokens,
      system: req.system,
      messages:
        typeof req.messages === 'string'
          ? [{ role: 'user', content: req.messages }]
          : (req.messages as Anthropic.MessageParam[]),
      ...(req.schema
        ? { output_config: { format: { type: 'json_schema', schema: req.schema.schema } } }
        : {})
    },
    { signal: req.signal }
  )
  return {
    text: m.content.map((b) => (b.type === 'text' ? b.text : '')).join(''),
    calls: m.content.flatMap((b) =>
      b.type === 'tool_use' ? [{ id: b.id, name: b.name, input: b.input }] : []
    ),
    stop:
      m.stop_reason === 'refusal'
        ? 'refused'
        : m.stop_reason === 'max_tokens'
          ? 'cut-off'
          : m.stop_reason === 'model_context_window_exceeded'
            ? 'too-long'
            : 'done',
    usage: [{ model: m.model || req.model, usage: fromClaude(m.usage) }]
  }
}

export const anthropicAdapter: ProviderAdapter = {
  id: 'claude',
  api: 'anthropic',
  authenticate: (apiKey, signal) =>
    authenticateWith('claude', () =>
      client(apiKey, { maxRetries: 0 }).models.list({ limit: 1 }, { signal })
    ),
  listModels: async () => ({ models: knownModels('claude'), checkedAt: null }),
  getCapabilities: capabilitiesOf,
  sendMessage,
  streamMessage,
  historyStart: (conversation, modelId) =>
    usesCompaction(modelId) ? claudeFilesFrom(conversation.messages) : 0
}
