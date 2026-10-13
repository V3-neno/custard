import type { ResponseInputItem } from 'openai/resources/responses/responses'
import { chatModels, deepseekEffort, type Effort } from '../../shared/chat'
import { providers, type Provider } from '../../shared/providers'
import { openaiStart } from '../compaction'
import { runOpenAI, toBlocks, toInput } from '../openai'
import { responsesClient } from '../providers'
import { fromOpenAI } from '../usage'
import { capabilitiesOf } from './capabilities'
import {
  authenticateWith,
  CHECK_OPTS,
  knownModels,
  listCall,
  listingFrom,
  parseModelList,
  type RawModel
} from './common'
import type { OneShotRequest, OneShotResult, ProviderAdapter, TurnEnd, TurnRequest } from './types'

// A provider reached through the OpenAI Responses API: OpenAI itself, and
// DeepSeek. What each one leaves out is its profile's `responses` flags
// (shared/providers.ts), which runOpenAI reads; the adapter is the same code
// for both. Stored chats are converted to Responses input on the way out
// (openai.ts toInput, which drops Claude's thinking and compaction blocks)
// and replies back to stored blocks (toBlocks).

export function responsesAdapter(id: Provider): ProviderAdapter {
  // The effort a request carries: none for a model that takes none (ignored
  // without a word), and for DeepSeek one of the levels its docs list.
  const effortFor = (model: string, e: Effort | undefined): Effort | undefined => {
    if (!e || chatModels.find((m) => m.id === model)?.effort === false) return undefined
    return id === 'deepseek' ? deepseekEffort(e) : e
  }
  const streamMessage = async (turn: TurnRequest): Promise<TurnEnd> => {
    const end = await runOpenAI({
      requestId: turn.requestId,
      provider: id,
      maxSteps: turn.maxSteps,
      apiKey: turn.apiKey,
      model: turn.model,
      effort: effortFor(turn.model, turn.effort),
      instructions: turn.system.map((b) => b.text).join('\n\n'),
      history: turn.history(),
      conversation: turn.conversation,
      fits: turn.fits,
      tools: turn.tools,
      onUsage: turn.onUsage,
      signal: turn.signal,
      emit: turn.emit,
      log: turn.log,
      runRound: turn.runRound
    })
    return turn.signal.aborted ? 'stopped' : end
  }

  const sendMessage = async (req: OneShotRequest): Promise<OneShotResult> => {
    const client = responsesClient(id, req.apiKey, {
      ...(req.timeoutMs !== undefined ? { timeout: req.timeoutMs } : {}),
      ...(req.retries !== undefined ? { maxRetries: req.retries } : {})
    })
    const r = await client.responses.create(
      {
        model: req.model,
        instructions: req.system,
        input:
          typeof req.messages === 'string'
            ? req.messages
            : (toInput(req.messages) as ResponseInputItem[]),
        max_output_tokens: req.maxTokens,
        ...(effortFor(req.model, req.effort)
          ? { reasoning: { effort: effortFor(req.model, req.effort) } }
          : {}),
        store: false,
        ...(req.schema
          ? {
              text: {
                format: {
                  type: 'json_schema' as const,
                  name: req.schema.name,
                  strict: true,
                  schema: req.schema.schema
                }
              }
            }
          : {})
      },
      { signal: req.signal }
    )
    const blocks = toBlocks(r.output)
    return {
      text: r.output_text,
      calls: blocks.flatMap((b) =>
        b.type === 'tool_use' ? [{ id: b.id, name: b.name, input: b.input }] : []
      ),
      stop: r.status === 'incomplete' ? 'cut-off' : 'done',
      usage: [{ model: req.model, usage: fromOpenAI(r.usage) }]
    }
  }

  // GET /models at the provider's pinned address (DeepSeek:
  // https://api.deepseek.com/models, Bearer key; OpenAI: /v1/models).
  const listRaw = (apiKey: string, signal?: AbortSignal): Promise<RawModel[]> =>
    listCall(id, apiKey, async () =>
      parseModelList(await responsesClient(id, apiKey, CHECK_OPTS).get('/models', { signal }), id)
    )

  return {
    id,
    api: 'responses',
    authenticate: (apiKey, signal) => authenticateWith(id, apiKey, () => listRaw(apiKey, signal)),
    listModels: async (apiKey, signal) =>
      apiKey
        ? listingFrom(id, await listRaw(apiKey, signal), providers[id].discoverModels, Date.now())
        : { models: knownModels(id), checkedAt: null },
    getCapabilities: capabilitiesOf,
    sendMessage,
    streamMessage,
    historyStart: (conversation, modelId) => openaiStart(conversation, modelId).from
  }
}
