import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import http from 'http'
import type { AddressInfo } from 'net'
import type { ChatEvent, Conversation } from '../shared/chat'
import { runOpenAI } from './openai'
import { TurnLog } from './turn'

// The OpenAI loop against a local stand-in for the Responses API (mocked: no
// request reaches OpenAI). Each test queues the replies it needs.

type Reply = { status?: number; json?: unknown; events?: Record<string, unknown>[] }
const requests: { path: string; body: Record<string, unknown> }[] = []
let replies: Reply[] = []
let server: http.Server

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      requests.push({ path: req.url ?? '', body: JSON.parse(body || '{}') })
      if (req.url?.endsWith('/responses/input_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ object: 'response.input_tokens', input_tokens: 123 }))
        return
      }
      const r = replies.shift() ?? { status: 500, json: { error: { message: 'no reply queued' } } }
      if (r.events) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        for (const e of r.events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
        res.end()
        return
      }
      res.writeHead(r.status ?? 200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(r.json))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${port}/v1`
  process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${port}/deepseek`
})
afterAll(() => {
  server.close()
  delete process.env.OPENAI_BASE_URL
  delete process.env.DEEPSEEK_BASE_URL
})

const completed = (output: unknown[]): Reply => ({
  events: [{ type: 'response.completed', sequence_number: 1, response: { output } }]
})
const message = (text: string): unknown => ({
  type: 'message',
  role: 'assistant',
  id: 'm',
  status: 'completed',
  content: [{ type: 'output_text', text, annotations: [] }]
})

function turn(
  c: Conversation,
  model: string,
  over: Partial<Parameters<typeof runOpenAI>[0]> = {}
): { t: Parameters<typeof runOpenAI>[0]; events: ChatEvent[] } {
  const events: ChatEvent[] = []
  const log = new TurnLog(c, () => {})
  c.messages.push({ role: 'user', content: 'go' })
  return {
    events,
    t: {
      requestId: 'r',
      provider: 'openai',
      maxSteps: 5,
      apiKey: 'sk-test',
      model,
      effort: 'low',
      instructions: 'be brief',
      history: c.messages,
      conversation: c,
      fits: async () => true,
      tools: [{ name: 'vault_list', description: 'list', input_schema: { type: 'object' } }],
      signal: new AbortController().signal,
      emit: (e) => events.push(e),
      log,
      runRound: async (calls) =>
        calls.map((x) => ({ type: 'tool_result' as const, tool_use_id: x.id, content: 'ok' })),
      ...over
    }
  }
}

const conv = (): Conversation => ({
  id: 'c',
  mode: 'chat',
  title: 't',
  createdAt: 0,
  updatedAt: 0,
  messages: [
    { role: 'user', content: 'earlier question' },
    { role: 'assistant', content: [{ type: 'text', text: 'earlier answer' }] }
  ]
})

describe('OpenAI long chats (mocked Responses API)', () => {
  it('asks for compaction, keeps the item and sends only what follows it', async () => {
    requests.length = 0
    replies = [
      {
        events: [
          {
            type: 'response.compaction.compacting',
            item_id: 'cmp1',
            output_index: 0,
            sequence_number: 1
          },
          {
            type: 'response.completed',
            sequence_number: 2,
            response: {
              output: [
                { type: 'compaction', id: 'cmp1', encrypted_content: 'ENC' },
                { type: 'function_call', call_id: 'call1', name: 'vault_list', arguments: '{}' }
              ]
            }
          }
        ]
      },
      completed([message('done')])
    ]
    const c = conv()
    const { t, events } = turn(c, 'gpt-6-luna')
    expect(await runOpenAI(t)).toBe('done')

    const [first, second] = requests.filter((r) => r.path.endsWith('/responses'))
    expect(first.body.context_management).toEqual([
      { type: 'compaction', compact_threshold: 150_000 }
    ])
    expect(first.body.store).toBe(false)
    expect(events).toContainEqual({ requestId: 'r', type: 'compacting' })
    // Everything before the compaction item is left out within the turn.
    const input = second.body.input as { type?: string; call_id?: string; content?: string }[]
    expect(input[0]).toMatchObject({ type: 'compaction', encrypted_content: 'ENC' })
    expect(JSON.stringify(input)).not.toContain('earlier question')
    expect(input.filter((x) => x.call_id === 'call1').map((x) => x.type)).toEqual([
      'function_call',
      'function_call_output'
    ])
    // Saved, before the assistant message the same response added.
    expect(c.compactions).toEqual([
      expect.objectContaining({ provider: 'openai', model: 'gpt-6-luna', after: 3 })
    ])
    expect(c.messages[3].role).toBe('assistant')
    // The stored history keeps every message.
    expect(c.messages[0]).toEqual({ role: 'user', content: 'earlier question' })

    // The next turn starts from the saved item.
    requests.length = 0
    replies = [completed([message('again')])]
    const next = turn(c, 'gpt-6-luna')
    await runOpenAI({ ...next.t, history: c.messages })
    const sent = requests.find((r) => r.path.endsWith('/responses'))!.body.input as unknown[]
    expect(sent[0]).toMatchObject({ type: 'compaction', id: 'cmp1', encrypted_content: 'ENC' })
    expect(JSON.stringify(sent)).not.toContain('earlier question')
    expect(JSON.stringify(sent)).toContain('call1')
  })

  it('never sends a request that does not fit', async () => {
    requests.length = 0
    replies = []
    let counted = 0
    const { t } = turn(conv(), 'gpt-6-luna', {
      fits: async (_estimate, count) => {
        counted = await count()
        return false
      }
    })
    expect(await runOpenAI(t)).toBe('too-long')
    expect(requests.filter((r) => r.path.endsWith('/responses'))).toHaveLength(0)
    // The count covers instructions, tools and input.
    const count = requests.find((r) => r.path.endsWith('/responses/input_tokens'))!.body
    expect(counted).toBe(123)
    expect(count).toMatchObject({ model: 'gpt-6-luna', instructions: 'be brief' })
    expect((count.tools as unknown[]).length).toBe(1)
    expect(JSON.stringify(count.input)).toContain('earlier question')
  })

  it('goes on without compaction when a model turns it down', async () => {
    requests.length = 0
    replies = [
      {
        status: 400,
        json: {
          error: {
            message: "Unsupported parameter: 'context_management'.",
            type: 'invalid_request_error',
            param: 'context_management',
            code: 'unsupported_parameter'
          }
        }
      },
      completed([message('fine')])
    ]
    const c = conv()
    c.compactions = [
      {
        after: 1,
        at: 0,
        provider: 'openai',
        model: 'gpt-6-astra',
        item: { id: 'old', encrypted_content: 'OLD' }
      }
    ]
    const checked: number[] = []
    const { t } = turn(c, 'gpt-6-astra', {
      fits: async (estimate) => {
        checked.push(estimate)
        return true
      }
    })
    expect(await runOpenAI(t)).toBe('done')
    // The replacement request (full history) was checked against the budget too.
    expect(checked).toHaveLength(2)
    expect(checked[1]).not.toBe(checked[0])
    const [first, second] = requests.filter((r) => r.path.endsWith('/responses'))
    expect(first.body.context_management).toBeDefined()
    expect((first.body.input as { type?: string }[])[0].type).toBe('compaction')
    expect(second.body.context_management).toBeUndefined()
    // The retry sends the full history instead of the item.
    expect(JSON.stringify(second.body.input)).not.toContain('OLD')
    expect(JSON.stringify(second.body.input)).toContain('earlier question')
  })

  it('does not send the replacement when it no longer fits', async () => {
    requests.length = 0
    replies = [
      {
        status: 400,
        json: {
          error: {
            message: "Unsupported parameter: 'context_management'.",
            type: 'invalid_request_error',
            param: 'context_management',
            code: 'unsupported_parameter'
          }
        }
      }
    ]
    const c = conv()
    c.compactions = [
      {
        after: 1,
        at: 0,
        provider: 'openai',
        model: 'gpt-6.1-sol',
        item: { id: 'old', encrypted_content: 'OLD' }
      }
    ]
    let n = 0
    const { t } = turn(c, 'gpt-6.1-sol', { fits: async () => n++ === 0 })
    expect(await runOpenAI(t)).toBe('too-long')
    expect(requests.filter((r) => r.path.endsWith('/responses'))).toHaveLength(1)
  })

  it('does not retry other 400s, or errors once a reply has started', async () => {
    requests.length = 0
    replies = [
      {
        status: 400,
        json: {
          error: {
            message: 'Invalid value for compact_threshold: must be at least 1000.',
            type: 'invalid_request_error',
            param: 'context_management',
            code: 'invalid_value'
          }
        }
      }
    ]
    await expect(runOpenAI(turn(conv(), 'gpt-6-luna').t)).rejects.toThrow(/compact_threshold/)
    expect(requests.filter((r) => r.path.endsWith('/responses'))).toHaveLength(1)

    // Text has streamed, then the response fails: nothing is resent.
    requests.length = 0
    replies = [
      {
        events: [
          { type: 'response.output_text.delta', delta: 'Partial', sequence_number: 1 },
          {
            type: 'error',
            sequence_number: 2,
            code: 'unsupported_parameter',
            message: "Unsupported parameter: 'context_management'.",
            param: 'context_management'
          }
        ]
      }
    ]
    await expect(runOpenAI(turn(conv(), 'gpt-6-luna').t)).rejects.toThrow()
    const sent = requests.filter((r) => r.path.endsWith('/responses'))
    expect(sent).toHaveLength(1)
    expect(sent[0].body.context_management).toBeDefined()
  })
})

describe('malformed tool arguments (L14)', () => {
  it('are marked so the call is refused rather than run with no arguments', async () => {
    requests.length = 0
    replies = [
      completed([
        { type: 'function_call', call_id: 'bad1', name: 'vault_list', arguments: '{"path": "x' }
      ]),
      completed([message('done')])
    ]
    const seen: unknown[] = []
    const { t } = turn(conv(), 'gpt-6-luna', {
      runRound: async (calls) => {
        seen.push(...calls.map((x) => x.input))
        return calls.map((x) => ({
          type: 'tool_result' as const,
          tool_use_id: x.id,
          content: 'ok'
        }))
      }
    })
    await runOpenAI(t)
    expect(seen).toEqual([{ __custardMalformedArguments: '{"path": "x' }])
  })
})

describe('OpenAI request features', () => {
  it('asks for reasoning summaries, encrypted reasoning and an exact count', async () => {
    requests.length = 0
    replies = [completed([message('hi')])]
    let counted = 0
    const { t } = turn(conv(), 'gpt-6-luna', {
      fits: async (_estimate, count) => ((counted = await count()), true)
    })
    await runOpenAI(t)
    expect(counted).toBe(123)
    const sent = requests.find((r) => r.path.endsWith('/responses'))!.body
    expect(sent.reasoning).toEqual({ effort: 'low', summary: 'auto' })
    expect(sent.include).toEqual(['reasoning.encrypted_content'])
    expect(sent.store).toBe(false)
  })
})

describe('DeepSeek through the same loop (mocked Responses API)', () => {
  it('asks only for what DeepSeek supports, shows its reasoning and passes it back', async () => {
    requests.length = 0
    const reasoning = {
      type: 'reasoning',
      id: 'rs_1',
      summary: [],
      content: [{ type: 'reasoning_text', text: 'Check the vault first.' }]
    }
    replies = [
      {
        events: [
          { type: 'response.reasoning_text.delta', sequence_number: 1, delta: 'Check the vault' },
          { type: 'response.reasoning_text.delta', sequence_number: 2, delta: ' first.' },
          {
            type: 'response.completed',
            sequence_number: 3,
            response: {
              output: [
                reasoning,
                { type: 'function_call', call_id: 'c1', name: 'vault_list', arguments: '{}' }
              ]
            }
          }
        ]
      },
      completed([message('Done.')])
    ]
    let counted: unknown = null
    const { t, events } = turn(conv(), 'deepseek-flash', {
      provider: 'deepseek',
      apiKey: 'sk-deepseek',
      fits: async (_estimate, count) => {
        counted = await count().catch((e: Error) => e.message)
        return true
      }
    })
    expect(await runOpenAI(t)).toBe('done')
    const sent = requests.filter((r) => r.path === '/deepseek/responses')
    // Its own address, never OpenAI's, and no counting request.
    expect(sent).toHaveLength(2)
    expect(requests.every((r) => r.path.startsWith('/deepseek/'))).toBe(true)
    expect(counted).toBe('No token counting')
    const [first, second] = sent.map((r) => r.body)
    expect(first.reasoning).toEqual({ effort: 'low' })
    expect(first).not.toHaveProperty('include')
    expect(first).not.toHaveProperty('context_management')
    expect(first.store).toBe(false)
    expect(first.instructions).toBe('be brief')
    expect(events.filter((e) => e.type === 'thinking').map((e) => e.text)).toEqual([
      'Check the vault',
      ' first.'
    ])
    // Within the turn its reasoning goes back with the tool result.
    const input = second.input as Record<string, unknown>[]
    expect(input).toContainEqual(reasoning)
    expect(input.at(-1)).toMatchObject({ type: 'function_call_output', call_id: 'c1' })
  })
})
