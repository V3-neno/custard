import type {
  BetaContentBlockParam,
  BetaMessageParam,
  BetaTool,
  BetaToolResultBlockParam
} from '@anthropic-ai/sdk/resources/beta/messages/messages'
import type {
  FunctionTool,
  ResponseInputContent,
  ResponseInputItem,
  ResponseOutputItem,
  ResponseStreamEvent
} from 'openai/resources/responses/responses'
import type { ChatEvent, Conversation, Effort } from '../shared/chat'
import { MALFORMED_ARGUMENTS, type TurnLog } from './turn'
import {
  compactionRefused,
  dropBeforeCompaction,
  isCompactionRejected,
  openaiStart,
  recordOpenAICompaction,
  usesCompaction
} from './compaction'
import { compactTrigger, estimateTokens, openaiCounter } from './context'
import { responsesClient } from './providers'
import { providerNames, responsesFeatures, type Provider } from '../shared/providers'
import type { TokenUsage } from '../shared/pricing'
import { fromOpenAI } from './usage'
import { fromResponsesReply, toResponsesInput } from './adapters/responsesNeutral'
import { contextByMessage } from './promptCache'
import { toolCalls, type Message } from '../shared/neutralChat'

type Emit = (e: ChatEvent) => void

const searchesIn = (output: ResponseOutputItem[]): number =>
  output.filter((o) => o.type === 'web_search_call').length

type Turn = {
  requestId: string
  // A Responses API provider (see shared/providers.ts).
  provider: Provider
  maxSteps: number
  apiKey: string
  model: string
  // None for a model that takes no effort.
  effort?: Effort
  instructions: string
  // The chat as stored, converted here (toResponsesInput) with this
  // request's files and the tools offered now.
  history: Message[]
  files: Map<number, BetaContentBlockParam[]>
  available: Set<string>
  conversation: Conversation
  // Checks a request against the model's budget before it is sent; false
  // when it is too large to send.
  fits: (estimate: number, count: () => Promise<number>) => Promise<boolean>
  tools: BetaTool[]
  // What each model call used (see usage.ts).
  onUsage?: (model: string, u: TokenUsage) => void
  signal: AbortSignal
  emit: Emit
  // Records the reply and each tool call as it happens (see turn.ts).
  log: TurnLog
  runRound: (
    calls: { id: string; name: string; input: unknown }[]
  ) => Promise<BetaToolResultBlockParam[]>
}

// How the turn ended, when not with a normal final answer.
export type OpenAIEnd = 'done' | 'cut-off' | 'cut-off-tool' | 'step-limit' | 'too-long'

export const toFunctionTool = (t: BetaTool): FunctionTool => ({
  type: 'function',
  name: t.name,
  description: t.description ?? null,
  parameters: t.input_schema as Record<string, unknown>,
  strict: false
})

const textOf = (content: string | BetaToolResultBlockParam['content']): string =>
  typeof content === 'string'
    ? content
    : (content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('')

// An attached file (see attachments/request) as Responses input: images as
// base64 data URLs with detail "high" (at most 2,500 patches, so never
// rejected for size), PDFs as base64 file data with the file's name, and
// text files as text, so both providers get exactly the same characters.
export function filePart(b: BetaContentBlockParam): ResponseInputContent | null {
  if (b.type === 'image' && b.source.type === 'base64')
    return {
      type: 'input_image',
      image_url: `data:${b.source.media_type};base64,${b.source.data}`,
      detail: 'high'
    }
  if (b.type === 'document' && b.source.type === 'base64')
    return {
      type: 'input_file',
      filename: b.title ?? 'file.pdf',
      file_data: `data:${b.source.media_type};base64,${b.source.data}`
    }
  if (b.type === 'document' && b.source.type === 'text')
    return {
      type: 'input_text',
      text: `<file name=${JSON.stringify(b.title ?? 'file')}>\n${b.source.data}\n</file>${b.context ? `\n${b.context}` : ''}`
    }
  return null
}

const hasFiles = (m: BetaMessageParam): boolean =>
  typeof m.content !== 'string' &&
  m.content.some((b) => b.type === 'image' || b.type === 'document')

// Claude-format messages as Responses input: the one-shot calls (summaries,
// automation steps) build their messages this way. Stored chats go through
// toResponsesInput (responsesNeutral.ts) instead. Claude's thinking and
// compaction blocks are left out: they only mean something to Claude.
export function toInput(messages: BetaMessageParam[]): ResponseInputItem[] {
  const items: ResponseInputItem[] = []
  for (const m of messages) {
    if (typeof m.content === 'string') {
      items.push({ role: m.role, content: m.content })
      continue
    }
    // A user message with files: one message holding the files and the text.
    if (m.role === 'user' && hasFiles(m)) {
      const parts: ResponseInputContent[] = []
      for (const b of m.content) {
        const part = b.type === 'text' ? { type: 'input_text' as const, text: b.text } : filePart(b)
        if (part) parts.push(part)
      }
      items.push({ role: 'user', content: parts })
      continue
    }
    for (const b of m.content) {
      if (b.type === 'text') items.push({ role: m.role, content: b.text })
      else if (b.type === 'tool_use')
        items.push({
          type: 'function_call',
          call_id: b.id,
          name: b.name,
          arguments: JSON.stringify(b.input)
        })
      else if (b.type === 'tool_result')
        items.push({
          type: 'function_call_output',
          call_id: b.tool_use_id,
          output: textOf(b.content)
        })
    }
  }
  return items
}

// The parts of an OpenAI reply that are worth keeping, as Claude-format blocks
// (fromResponsesReply turns them into the stored message).
export function toBlocks(output: ResponseOutputItem[]): BetaContentBlockParam[] {
  const blocks: BetaContentBlockParam[] = []
  for (const item of output) {
    if (item.type === 'message') {
      const text = item.content.map((c) => (c.type === 'output_text' ? c.text : c.refusal)).join('')
      if (text) blocks.push({ type: 'text', text })
    } else if (item.type === 'function_call') {
      let input: unknown = {}
      try {
        input = JSON.parse(item.arguments || '{}')
      } catch {
        // Refused when the call comes to run (see runTool).
        input = { [MALFORMED_ARGUMENTS]: item.arguments }
      }
      blocks.push({ type: 'tool_use', id: item.call_id, name: item.name, input })
    }
  }
  return blocks
}

export async function runOpenAI(turn: Turn): Promise<OpenAIEnd> {
  const { emit, requestId, log } = turn
  const client = responsesClient(turn.provider, turn.apiKey)
  const features = responsesFeatures(turn.provider)
  // From the newest compaction this model made, if there is one.
  const start = openaiStart(turn.conversation, turn.model)
  const context = contextByMessage(turn.conversation.messageContext)
  const convert = (range: { from?: number; to?: number }): ResponseInputItem[] =>
    toResponsesInput(turn.history, {
      files: turn.files,
      available: turn.available,
      context,
      ...range
    })
  let input: ResponseInputItem[] = [
    ...(start.item ? [start.item] : []),
    ...convert({ from: start.from })
  ]
  const tools = turn.tools.length ? { tools: turn.tools.map(toFunctionTool) } : {}
  // Without a counting endpoint the estimate decides (see context.measure).
  const count = features.tokenCount
    ? openaiCounter(client, { model: turn.model, instructions: turn.instructions, ...tools })
    : () => Promise.reject(new Error('No token counting'))

  for (let step = 0; step < turn.maxSteps; step++) {
    const sent = input
    if (!(await turn.fits(estimateTokens(turn.instructions, sent, tools), () => count(sent))))
      return 'too-long'
    const request = (compact: boolean): Promise<AsyncIterable<ResponseStreamEvent>> =>
      client.responses.create(
        {
          model: turn.model,
          instructions: turn.instructions,
          input,
          reasoning: {
            ...(turn.effort ? { effort: turn.effort } : {}),
            ...(features.reasoningSummary ? { summary: 'auto' as const } : {})
          },
          // Nothing is stored at the provider; reasoning is passed back
          // encrypted so the model keeps its train of thought across tool
          // calls.
          store: false,
          // One key per chat, so its repeated start is read from the cache.
          ...(features.promptCacheKey ? { prompt_cache_key: turn.conversation.id } : {}),
          ...(features.encryptedReasoning
            ? { include: ['reasoning.encrypted_content' as const] }
            : {}),
          ...tools,
          // The server compacts once the input passes the threshold and
          // returns an encrypted compaction item; works with store: false.
          ...(compact
            ? {
                context_management: [
                  { type: 'compaction', compact_threshold: compactTrigger(turn.model) }
                ]
              }
            : {}),
          stream: true
        },
        { signal: turn.signal }
      )
    let stream: AsyncIterable<ResponseStreamEvent>
    try {
      stream = await request(usesCompaction(turn.model))
    } catch (err) {
      if (!usesCompaction(turn.model) || !isCompactionRejected(err)) throw err
      // This model doesn't take compaction: go on without it; the budget
      // check and "Continue in a new chat" cover what it would have.
      compactionRefused(turn.model)
      const [first, ...rest] = input
      input =
        start.item && first === start.item
          ? [...convert({ to: start.from }), ...rest]
          : input.filter((x) => x.type !== 'compaction')
      // Checked against the budget again: the full history is larger.
      step--
      continue
    }

    let output: ResponseOutputItem[] = []
    let incomplete = false
    for await (const event of stream) {
      if (event.type === 'response.compaction.compacting') {
        emit({ requestId, type: 'compacting' })
      } else if (event.type === 'response.reasoning_summary_text.delta') {
        emit({ requestId, type: 'thinking', text: event.delta })
      } else if (event.type === 'response.reasoning_summary_part.done') {
        emit({ requestId, type: 'thinking', text: '\n\n' })
      } else if (event.type === 'response.reasoning_text.delta') {
        // A provider without summaries (DeepSeek) streams its reasoning itself.
        emit({ requestId, type: 'thinking', text: event.delta })
      } else if (event.type === 'response.output_text.delta') {
        log.text(event.delta)
        emit({ requestId, type: 'text', text: event.delta })
      } else if (event.type === 'response.completed') {
        output = event.response.output
        turn.onUsage?.(turn.model, fromOpenAI(event.response.usage, searchesIn(output)))
      } else if (event.type === 'response.incomplete') {
        output = event.response.output
        incomplete = true
        turn.onUsage?.(turn.model, fromOpenAI(event.response.usage, searchesIn(output)))
      } else if (event.type === 'response.failed') {
        throw new Error(
          event.response.error?.message ??
            `${providerNames[turn.provider]} could not finish the reply.`
        )
      } else if (event.type === 'error') {
        throw new Error(event.message)
      }
    }

    const calls = output.filter((o) => o.type === 'function_call')
    const compaction = output.findLast((o) => o.type === 'compaction')
    if (compaction) recordOpenAICompaction(turn.conversation, compaction, turn.model, turn.provider)
    if (incomplete && calls.length > 0) return 'cut-off-tool'
    const reply = fromResponsesReply(output, turn.provider, turn.model)
    log.addAssistant(reply)
    if (incomplete) return 'cut-off'
    if (calls.length === 0) return 'done'

    // One after another, in order.
    const results = await turn.runRound(
      calls.map((c) => ({
        id: c.call_id,
        name: c.name,
        input: toolCalls(reply).find((x) => x.id === c.call_id)?.input ?? {}
      }))
    )
    if (turn.signal.aborted) return 'done'
    input = dropBeforeCompaction([
      ...input,
      ...(output as ResponseInputItem[]),
      ...results.map((r): ResponseInputItem => ({
        type: 'function_call_output',
        call_id: r.tool_use_id,
        output: textOf(r.content)
      }))
    ])
  }
  return 'step-limit'
}
