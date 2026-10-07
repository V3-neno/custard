import type {
  BetaContentBlockParam,
  BetaMessageParam,
  BetaToolResultBlockParam
} from '@anthropic-ai/sdk/resources/beta/messages/messages'
import OpenAI from 'openai'
import type {
  FunctionTool,
  ResponseInputItem,
  ResponseOutputItem
} from 'openai/resources/responses/responses'
import type { ChatEvent, Conversation, Effort } from '../shared/chat'
import { saveConversation } from './store'
import { vaultTools } from './vault'

type Emit = (e: ChatEvent) => void

type Turn = {
  requestId: string
  maxSteps: number
  apiKey: string
  model: string
  effort: Effort
  instructions: string
  conversation: Conversation
  withTools: boolean
  signal: AbortSignal
  emit: Emit
  runTool: (id: string, name: string, input: unknown) => { content: string; isError: boolean }
  onText: (text: string) => void
}

const tools: FunctionTool[] = vaultTools.map((t) => ({
  type: 'function',
  name: t.name,
  description: t.description ?? null,
  parameters: t.input_schema as Record<string, unknown>,
  strict: false
}))

const textOf = (content: string | BetaToolResultBlockParam['content']): string =>
  typeof content === 'string'
    ? content
    : (content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('')

// Conversations are stored in Claude's message format so either provider can
// continue them. This converts that history into OpenAI Responses input.
// Claude's thinking blocks are left out: they only mean something to Claude.
function toInput(messages: BetaMessageParam[]): ResponseInputItem[] {
  const items: ResponseInputItem[] = []
  for (const m of messages) {
    if (typeof m.content === 'string') {
      items.push({ role: m.role, content: m.content })
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

// The parts of an OpenAI reply that are worth keeping, as Claude-format blocks.
function toBlocks(output: ResponseOutputItem[]): BetaContentBlockParam[] {
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
        // Leave malformed arguments empty; the tool reports what's missing.
      }
      blocks.push({ type: 'tool_use', id: item.call_id, name: item.name, input })
    }
  }
  return blocks
}

export async function runOpenAI(turn: Turn): Promise<void> {
  const { conversation, emit, requestId } = turn
  const client = new OpenAI({ apiKey: turn.apiKey })
  const input = toInput(conversation.messages)

  for (let step = 0; step < turn.maxSteps; step++) {
    const stream = await client.responses.create(
      {
        model: turn.model,
        instructions: turn.instructions,
        input,
        reasoning: { effort: turn.effort, summary: 'auto' },
        // Nothing is stored at OpenAI; reasoning is passed back encrypted so
        // the model keeps its train of thought across vault actions.
        store: false,
        include: ['reasoning.encrypted_content'],
        ...(turn.withTools ? { tools } : {}),
        stream: true
      },
      { signal: turn.signal }
    )

    let output: ResponseOutputItem[] = []
    let incomplete = false
    for await (const event of stream) {
      if (event.type === 'response.reasoning_summary_text.delta') {
        emit({ requestId, type: 'thinking', text: event.delta })
      } else if (event.type === 'response.reasoning_summary_part.done') {
        emit({ requestId, type: 'thinking', text: '\n\n' })
      } else if (event.type === 'response.output_text.delta') {
        turn.onText(event.delta)
        emit({ requestId, type: 'text', text: event.delta })
      } else if (event.type === 'response.completed') {
        output = event.response.output
      } else if (event.type === 'response.incomplete') {
        output = event.response.output
        incomplete = true
      } else if (event.type === 'response.failed') {
        throw new Error(event.response.error?.message ?? 'OpenAI could not finish the reply.')
      } else if (event.type === 'error') {
        throw new Error(event.message)
      }
    }

    const calls = output.filter((o) => o.type === 'function_call')
    if (incomplete && calls.length > 0)
      throw new Error('The reply was cut off in the middle of a vault action. Try again.')
    const blocks = toBlocks(output)
    if (blocks.length > 0) conversation.messages.push({ role: 'assistant', content: blocks })
    if (calls.length === 0) return

    const results: BetaToolResultBlockParam[] = calls.map((c) => {
      const block = blocks.find((b) => b.type === 'tool_use' && b.id === c.call_id)
      const r = turn.runTool(c.call_id, c.name, block?.type === 'tool_use' ? block.input : {})
      return {
        type: 'tool_result',
        tool_use_id: c.call_id,
        content: r.content,
        is_error: r.isError
      }
    })
    conversation.messages.push({ role: 'user', content: results })
    saveConversation(conversation)
    input.push(
      ...(output as ResponseInputItem[]),
      ...results.map((r): ResponseInputItem => ({
        type: 'function_call_output',
        call_id: r.tool_use_id,
        output: textOf(r.content)
      }))
    )
  }
}
