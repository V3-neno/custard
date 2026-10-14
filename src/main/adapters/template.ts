import type {
  BetaContentBlockParam,
  BetaMessageParam
} from '@anthropic-ai/sdk/resources/beta/messages/messages'
import type { TokenUsage } from '../../shared/pricing'
import { providerNames, type Provider } from '../../shared/providers'
import { ProviderError, toProviderError } from '../providerError'
import { capabilitiesOf } from './capabilities'
import {
  authenticateWith,
  knownModels,
  listCall,
  listingFrom,
  parseModelList,
  type RawModel
} from './common'
import type { OneShotRequest, OneShotResult, ProviderAdapter, TurnEnd, TurnRequest } from './types'

// TEMPLATE, not registered and never called by the app. A starting point for
// a provider whose API is neither Anthropic's Messages API (anthropic.ts) nor
// the OpenAI Responses API (responses.ts). Read docs/providers.md, "Adding a
// provider", first: most providers only need a profile and one of the two
// existing adapters.
//
// It compiles and is covered by typecheck. Only the parts that make no
// request are unit-tested (template.test.ts): listModels without a key,
// getCapabilities, historyStart and webSearch. The request code below has
// never been sent to any provider.
//
// Every place marked PROVIDER-SPECIFIC must be filled from the provider's
// own docs. Everything else is how every adapter behaves, and should stay.

// PROVIDER-SPECIFIC: the pinned address. Move it into endpoints.ts
// (ENDPOINTS), never into Settings: endpoints are pinned so a key can't be
// sent somewhere else.
const BASE_URL = 'https://api.example.com/v1'

// PROVIDER-SPECIFIC: the wire format. These are placeholders for a
// Chat Completions-like API.
type WireMessage = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string }
type WireReply = {
  text: string
  calls: { id: string; name: string; input: unknown }[]
  // PROVIDER-SPECIFIC: the provider's own finish reasons.
  finish: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'error'
  usage: { input: number; output: number }
}

// Stored chats are Anthropic message blocks (see types.ts). Convert them on
// the way out and drop what this provider can't read: Claude's thinking,
// redacted thinking, fallback markers and compaction blocks. Tool calls the
// chat isn't offered now were already turned into text by history.ts.
// PROVIDER-SPECIFIC: tool calls and results in the provider's own form, and
// attachments (see attachments/request.ts for the per-provider rules).
function toWire(system: string, messages: BetaMessageParam[] | string): WireMessage[] {
  const out: WireMessage[] = [{ role: 'system', content: system }]
  if (typeof messages === 'string') return [...out, { role: 'user', content: messages }]
  for (const m of messages) {
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content
    const text = blocks
      .flatMap((b) => (b.type === 'text' && 'text' in b ? [b.text] : []))
      .join('\n')
    if (text) out.push({ role: m.role, content: text })
  }
  return out
}

// The provider's reply as stored blocks: text and tool_use only. A
// provider's own reasoning is never stored (it would reach other providers).
function toStored(r: WireReply): BetaContentBlockParam[] {
  return [
    ...(r.text ? [{ type: 'text' as const, text: r.text }] : []),
    ...r.calls.map((c) => ({
      type: 'tool_use' as const,
      id: c.id,
      name: c.name,
      input: c.input as Record<string, unknown>
    }))
  ]
}

// PROVIDER-SPECIFIC: how usage is reported. Cache fields are zero unless the
// provider reports them; pricing.ts needs a price entry for every model.
const toUsage = (u: WireReply['usage']): TokenUsage => ({
  input: u.input,
  cacheWrite: 0,
  cacheRead: 0,
  output: u.output,
  webSearches: 0
})

export function templateAdapter(id: Provider): ProviderAdapter {
  const name = providerNames[id]

  // One request. Errors become a ProviderError with the key hidden; a 401
  // must come out as kind 'auth' so Settings says the key was rejected.
  // PROVIDER-SPECIFIC: auth header, path and body.
  async function call(
    apiKey: string,
    path: string,
    body: unknown,
    signal?: AbortSignal
  ): Promise<unknown> {
    let res: Response
    try {
      res = await fetch(`${BASE_URL}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' })
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(signal ? { signal } : {})
      })
    } catch (err) {
      throw signal?.aborted
        ? new ProviderError('aborted', name, 'Stopped.')
        : new ProviderError('network', name, `Couldn't reach ${name}.`, undefined, undefined, err)
    }
    if (res.status === 401) throw new ProviderError('auth', name, `${name} rejected the key.`, 401)
    if (!res.ok)
      throw new ProviderError('server', name, `${name} answered ${res.status}.`, res.status)
    return res.json()
  }

  // PROVIDER-SPECIFIC: the request body and reading the reply. Tools are
  // offered as the provider's function tools; effort maps to the provider's
  // documented levels (see the effort levels in a model's profile,
  // shared/models.ts).
  async function complete(
    apiKey: string,
    model: string,
    messages: WireMessage[],
    opts: { tools?: unknown[]; maxTokens?: number; signal?: AbortSignal }
  ): Promise<WireReply> {
    const raw = await call(
      apiKey,
      '/chat',
      {
        model,
        messages,
        ...(opts.tools?.length ? { tools: opts.tools } : {}),
        ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {})
      },
      opts.signal
    )
    return raw as WireReply
  }

  // Background summaries and automation steps. Map every way the reply can
  // end to `stop`: callers rely on 'refused', 'cut-off', 'too-long' and
  // 'failed' to never keep a partial or declined text as the answer.
  async function sendMessage(req: OneShotRequest): Promise<OneShotResult> {
    // PROVIDER-SPECIFIC: structured output (req.schema) and req.effort.
    const r = await complete(req.apiKey, req.model, toWire(req.system, req.messages), {
      ...(req.tools ? { tools: req.tools } : {}),
      ...(req.maxTokens !== undefined ? { maxTokens: req.maxTokens } : {}),
      ...(req.signal ? { signal: req.signal } : {})
    })
    return {
      text: r.text,
      calls: r.calls,
      stop:
        r.finish === 'content_filter'
          ? 'refused'
          : r.finish === 'length'
            ? 'cut-off'
            : r.finish === 'error'
              ? 'failed'
              : 'done',
      ...(r.finish === 'error' ? { error: 'The provider could not finish.' } : {}),
      usage: [{ model: req.model, usage: toUsage(r.usage) }]
    }
  }

  // A chat turn. The loop, the stop rules and the events are the same for
  // every adapter; only the request and the stream parsing differ.
  // PROVIDER-SPECIFIC: streaming (this sketch waits for each whole reply),
  // reasoning shown as 'thinking' events, and turn.fits with the provider's
  // token counter if it has one (otherwise an estimate, see context.ts).
  async function streamMessage(turn: TurnRequest): Promise<TurnEnd> {
    const { requestId, emit, log, signal } = turn
    const instructions = turn.system.map((b) => b.text).join('\n\n')
    for (let step = 0; ; step++) {
      if (step === turn.maxSteps) return 'step-limit'
      const messages = toWire(instructions, turn.history())
      let r: WireReply
      try {
        r = await complete(turn.apiKey, turn.model, messages, { tools: turn.tools, signal })
      } catch (err) {
        if (signal.aborted) return 'stopped'
        throw toProviderError(err, name, turn.apiKey)
      }
      turn.onUsage(turn.model, toUsage(r.usage))
      if (r.finish === 'content_filter') return { refused: `${name} declined this request.` }
      // Cut off while calling a tool: nothing is run, the turn is taken back.
      if (r.finish === 'length' && r.calls.length) return 'cut-off-tool'
      if (r.text) {
        log.text(r.text)
        emit({ requestId, type: 'text', text: r.text })
      }
      log.addAssistant(toStored(r))
      if (r.finish === 'length') return 'cut-off'
      if (!r.calls.length) return 'done'
      // Approvals, the chat guard and the tools themselves run here, above
      // the adapter. The results land in the history read at the next step.
      await turn.runRound(r.calls)
      if (signal.aborted) return 'stopped'
    }
  }

  // The key check is the model list (Save/Refresh in Settings only).
  // PROVIDER-SPECIFIC: the list's path and shape; parseModelList reads
  // `{ data: [{ id, … }] }`.
  const listRaw = (apiKey: string, signal?: AbortSignal): Promise<RawModel[]> =>
    listCall(id, apiKey, async () =>
      parseModelList(await call(apiKey, '/models', undefined, signal), id)
    )

  return {
    id,
    // PROVIDER-SPECIFIC: ProviderApi in shared/providers.ts gains a value for
    // a new API.
    api: 'responses',
    authenticate: (apiKey, signal) => authenticateWith(id, apiKey, () => listRaw(apiKey, signal)),
    listModels: async (apiKey, signal) =>
      apiKey
        ? listingFrom(
            id,
            await listRaw(apiKey, signal),
            // From the profile: whether unknown models are listed in Settings.
            false,
            Date.now()
          )
        : { models: knownModels(id), checkedAt: null },
    // Never from the provider: the local rules in capabilities.ts.
    getCapabilities: capabilitiesOf,
    sendMessage,
    streamMessage,
    // PROVIDER-SPECIFIC: where this provider's history starts after its own
    // compaction. 0 means the whole chat is sent.
    historyStart: () => 0,
    // PROVIDER-SPECIFIC: hosted search, if the provider has one. Also turn on
    // search in webTools (web/index.ts), which decides whether the tool is
    // offered at all.
    webSearch: async ({ model }) => ({
      ran: [],
      hits: [],
      summary: '',
      error: `Web search isn't available for ${model}.`
    })
  }
}
