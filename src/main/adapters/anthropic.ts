import Anthropic from '@anthropic-ai/sdk'
import type {
  BetaContentBlock,
  BetaContentBlockParam,
  BetaMessageParam,
  MessageCreateParamsStreaming
} from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { profileOf, requireProfile, sentLevel, type ModelProfile } from '../../shared/models'
import { claudeFilesFrom } from '../attachments/request'
import {
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
import { searchClaude } from '../web/search'
import { claudeParts } from '../usage'
import {
  authenticateWith,
  CHECK_OPTS,
  knownModels,
  listCall,
  listingFrom,
  parseModelList,
  type RawModel
} from './common'
import { capabilitiesOf } from './capabilities'
import { fromClaudeReply, toClaudeHistory } from './anthropicNeutral'
import type { OneShotRequest, OneShotResult, ProviderAdapter, TurnEnd, TurnRequest } from './types'

// Claude, through Anthropic's Messages API. Stored chats are converted with
// toClaudeHistory (anthropicNeutral.ts): Claude's own replies go back as the
// blocks it returned (`raw`), less compaction blocks for a model that doesn't
// compact; everything else is rebuilt from its parts.

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
  // A model with no profile fails here, loudly, rather than going to
  // another model (chat.ts refuses it before this).
  const model: ModelProfile = requireProfile(turn.model)
  const history = (): BetaMessageParam[] =>
    toClaudeHistory(turn.history(), {
      model: model.id,
      files: turn.files,
      available: turn.available,
      context: turn.conversation.messageContext
    })
  const params: MessageCreateParamsStreaming = {
    model: model.id,
    max_tokens: 64000,
    system: turn.system,
    messages: history(),
    cache_control: { type: 'ephemeral' },
    stream: true
  }
  if (turn.tools.length) params.tools = turn.tools
  if (model.thinking) params.thinking = { type: 'adaptive', display: 'summarized' }
  if (model.effort) params.output_config = { effort: sentLevel(model.effort, turn.effort) }
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
    log.addAssistant(fromClaudeReply(echoableContent(message.content), model.id))
    if (full) return 'full-window'
    if (message.stop_reason === 'max_tokens') return 'cut-off'
    if (message.stop_reason !== 'tool_use') return 'done'
    await turn.runRound(toolUses)
    if (signal.aborted) return 'stopped'
  }
}

// Thinking and effort as the chat turn sends them, from the model's profile:
// adaptive thinking for a model whose profile thinks (no `display`: nobody
// reads a one-shot call's thinking, so it stays the API's default), and
// `output_config.effort` only when the caller asks for one and the model
// takes effort. Haiku 4.5 (the Claude summary model) takes neither, so its
// requests are unchanged; automation steps on Opus and Sonnet get both.
async function sendMessage(req: OneShotRequest): Promise<OneShotResult> {
  const api = client(req.apiKey, {
    ...(req.timeoutMs !== undefined ? { timeout: req.timeoutMs } : {}),
    ...(req.retries !== undefined ? { maxRetries: req.retries } : {})
  })
  const messages =
    typeof req.messages === 'string'
      ? [{ role: 'user' as const, content: req.messages }]
      : (req.messages as Anthropic.MessageParam[])
  const maxTokens = req.maxTokens ?? 16000
  const tools = req.tools?.length ? { tools: req.tools } : {}
  const profile = profileOf(req.model)
  const thinking = profile?.thinking ? { thinking: { type: 'adaptive' as const } } : {}
  const effort =
    profile?.effort && req.effort ? { effort: sentLevel(profile.effort, req.effort) } : null
  const m = req.stream
    ? await api.beta.messages
        .stream(
          {
            model: req.model,
            max_tokens: maxTokens,
            system: req.system,
            messages: messages as BetaMessageParam[],
            ...tools,
            ...thinking,
            ...(effort ? { output_config: effort } : {})
          },
          { signal: req.signal }
        )
        .finalMessage()
    : await api.messages.create(
        {
          model: req.model,
          max_tokens: maxTokens,
          system: req.system,
          messages,
          ...(tools as { tools?: Anthropic.Tool[] }),
          ...thinking,
          ...(req.schema || effort
            ? {
                output_config: {
                  ...(req.schema
                    ? { format: { type: 'json_schema' as const, schema: req.schema.schema } }
                    : {}),
                  ...effort
                }
              }
            : {})
        },
        { signal: req.signal }
      )
  const content = m.content as {
    type: string
    text?: string
    id?: string
    name?: string
    input?: unknown
  }[]
  return {
    text: content.map((b) => (b.type === 'text' ? (b.text ?? '') : '')).join(''),
    calls: content.flatMap((b) =>
      b.type === 'tool_use' ? [{ id: b.id!, name: b.name!, input: b.input }] : []
    ),
    stop:
      m.stop_reason === 'refusal'
        ? 'refused'
        : m.stop_reason === 'max_tokens'
          ? 'cut-off'
          : m.stop_reason === 'model_context_window_exceeded'
            ? 'too-long'
            : 'done',
    // Split by model when a fallback answered part of it.
    usage: claudeParts(m.usage, m.model || req.model)
  }
}

// GET /v1/models, every page (at most 5 of 1,000).
const listRaw = (apiKey: string, signal?: AbortSignal): Promise<RawModel[]> =>
  listCall('claude', apiKey, async () => {
    const api = client(apiKey, CHECK_OPTS)
    const out: RawModel[] = []
    let after: string | undefined
    for (let page = 0; page < 5; page++) {
      const body = await api.get('/v1/models', {
        query: { limit: 1000, ...(after ? { after_id: after } : {}) },
        signal
      })
      out.push(...parseModelList(body, 'claude'))
      const b = body as { has_more?: unknown; last_id?: unknown }
      if (b.has_more !== true || typeof b.last_id !== 'string') break
      after = b.last_id
    }
    return out
  })

export const anthropicAdapter: ProviderAdapter = {
  id: 'claude',
  api: 'anthropic',
  authenticate: (apiKey, signal) =>
    authenticateWith('claude', apiKey, () => listRaw(apiKey, signal)),
  listModels: async (apiKey, signal) =>
    apiKey
      ? listingFrom('claude', await listRaw(apiKey, signal), false, Date.now())
      : { models: knownModels('claude'), checkedAt: null },
  getCapabilities: capabilitiesOf,
  sendMessage,
  streamMessage,
  webSearch: ({ model, apiKey, query, signal }) =>
    searchClaude(client(apiKey), model, query, signal),
  historyStart: (conversation, modelId) =>
    usesCompaction(modelId) ? claudeFilesFrom(conversation.messages) : 0
}
