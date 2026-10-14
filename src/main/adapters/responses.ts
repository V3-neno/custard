import type { ResponseInputItem } from 'openai/resources/responses/responses'
import type { Effort } from '../../shared/chat'
import { profileOf, providerEffort, sentLevel } from '../../shared/models'
import { providers, type Provider } from '../../shared/providers'
import { openaiStart } from '../compaction'
import { runOpenAI, toBlocks, toFunctionTool, toInput } from '../openai'
import { searchOpenAI } from '../web/search'
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
  // without a word), otherwise the level its profile sends for it (DeepSeek:
  // low, high or max). A model with no profile goes by its provider's levels.
  const effortFor = (model: string, e: Effort | undefined): Effort | undefined => {
    const profile = profileOf(model)
    const spec = profile ? profile.effort : providerEffort(id)
    if (!e || !spec) return undefined
    return sentLevel(spec, e)
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
        ...(req.maxTokens !== undefined ? { max_output_tokens: req.maxTokens } : {}),
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
          : {}),
        ...(req.tools?.length ? { tools: req.tools.map(toFunctionTool) } : {})
      },
      { signal: req.signal }
    )
    const blocks = toBlocks(r.output)
    return {
      text: r.output_text,
      calls: blocks.flatMap((b) =>
        b.type === 'tool_use' ? [{ id: b.id, name: b.name, input: b.input }] : []
      ),
      // A refusal part is the model declining, as Claude's refusal stop is.
      stop: r.output.some(
        (o) => o.type === 'message' && o.content.some((c) => c.type === 'refusal')
      )
        ? 'refused'
        : r.status === 'incomplete'
          ? 'cut-off'
          : r.status === 'failed'
            ? 'failed'
            : 'done',
      ...(r.status === 'failed' ? { error: r.error?.message ?? 'unknown error' } : {}),
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
    historyStart: (conversation, modelId) => openaiStart(conversation, modelId).from,
    // OpenAI's hosted search; DeepSeek has none (its models' profiles say
    // so, and getCapabilities with them).
    webSearch: async ({ model, apiKey, query, signal }) =>
      profileOf(model)?.search === 'responses'
        ? searchOpenAI(responsesClient(id, apiKey), model, query, signal)
        : {
            ran: [],
            hits: [],
            summary: '',
            error: `Web search isn't available for ${model}.`
          }
  }
}
