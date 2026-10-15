import http from 'http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Effort } from '../../shared/models'
import { adapterFor } from './registry'

// Thinking and effort in a one-shot call (automation thinking, Phase 2): the
// request an automation step sends for each provider, with the automation's
// effort set and not set, and the Claude summary request, which must not
// change. A stand-in records each request body.
const bodies: Record<string, unknown>[] = []
let server: http.Server

const claudeMessage = {
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5-5',
  content: [{ type: 'text', text: 'ok' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 }
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const body = JSON.parse(raw)
      bodies.push(body)
      if (req.url!.startsWith('/anthropic')) {
        if (!body.stream) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify(claudeMessage))
          return
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        const send = (e: Record<string, unknown>): void => {
          res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
        }
        send({
          type: 'message_start',
          message: { ...claudeMessage, content: [], stop_reason: null }
        })
        send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
        send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } })
        send({ type: 'content_block_stop', index: 0 })
        send({
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 1 }
        })
        send({ type: 'message_stop' })
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          id: 'r',
          object: 'response',
          created_at: 0,
          status: 'completed',
          model: 'm',
          output: [
            {
              type: 'message',
              id: 'm',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: 'ok', annotations: [] }]
            }
          ],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
        })
      )
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}/anthropic`
  process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${port}/deepseek`
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${port}/openai/v1`
})
afterAll(() => {
  server.close()
  delete process.env.ANTHROPIC_BASE_URL
  delete process.env.DEEPSEEK_BASE_URL
  delete process.env.OPENAI_BASE_URL
})

const PROVIDER = (model: string): 'claude' | 'openai' | 'deepseek' =>
  model.startsWith('claude') ? 'claude' : model.startsWith('gpt') ? 'openai' : 'deepseek'

// What automations/model.ts sends for a step (less tools).
const step = async (model: string, effort?: Effort): Promise<Record<string, unknown>> => {
  bodies.length = 0
  await adapterFor(PROVIDER(model)).sendMessage({
    model,
    apiKey: 'sk-test',
    system: 's',
    messages: [{ role: 'user', content: 'go' }],
    ...(PROVIDER(model) === 'claude' ? { maxTokens: 64_000 } : {}),
    ...(effort ? { effort } : {}),
    stream: true,
    retries: 0
  })
  return bodies[0]
}
const pick = (b: Record<string, unknown>): Record<string, unknown> => ({
  thinking: b.thinking,
  output_config: b.output_config,
  reasoning: b.reasoning,
  max_tokens: b.max_tokens,
  max_output_tokens: b.max_output_tokens
})

describe('an automation step, Claude', () => {
  it('Opus and Sonnet: adaptive thinking always; effort only when set', async () => {
    for (const m of ['claude-opus-5-5', 'claude-sonnet-5-5']) {
      expect(pick(await step(m))).toEqual({
        thinking: { type: 'adaptive' },
        output_config: undefined,
        reasoning: undefined,
        max_tokens: 64_000,
        max_output_tokens: undefined
      })
      expect(pick(await step(m, 'high'))).toEqual({
        thinking: { type: 'adaptive' },
        output_config: { effort: 'high' },
        reasoning: undefined,
        max_tokens: 64_000,
        max_output_tokens: undefined
      })
    }
    expect((await step('claude-opus-5-5', 'max')).output_config).toEqual({ effort: 'max' })
    expect((await step('claude-sonnet-5-5', 'low')).output_config).toEqual({ effort: 'low' })
  })

  it('Haiku 4.5: neither thinking nor effort, even when an effort is stored', async () => {
    for (const e of [undefined, 'high'] as const) {
      const b = await step('claude-haiku-4-5', e)
      expect('thinking' in b).toBe(false)
      expect('output_config' in b).toBe(false)
      expect(b.max_tokens).toBe(64_000)
    }
  })

  it('the rest of the request is as before: model, system, messages, stream', async () => {
    const b = await step('claude-opus-5-5', 'medium')
    expect(Object.keys(b).sort()).toEqual(
      ['max_tokens', 'messages', 'model', 'output_config', 'stream', 'system', 'thinking'].sort()
    )
  })
})

describe('an automation step, Responses providers', () => {
  it('OpenAI: reasoning.effort only when set; no output limit', async () => {
    expect(pick(await step('gpt-6-astra'))).toEqual({
      thinking: undefined,
      output_config: undefined,
      reasoning: undefined,
      max_tokens: undefined,
      max_output_tokens: undefined
    })
    expect(pick(await step('gpt-6-astra', 'xhigh')).reasoning).toEqual({ effort: 'xhigh' })
  })

  it('DeepSeek: a stored medium sends high (Balanced); none sends nothing', async () => {
    expect((await step('deepseek-flash', 'medium')).reasoning).toEqual({ effort: 'high' })
    expect((await step('deepseek-v4-pro', 'low')).reasoning).toEqual({ effort: 'low' })
    const none = await step('deepseek-flash')
    expect('reasoning' in none).toBe(false)
    expect('max_output_tokens' in none).toBe(false)
  })
})

describe('the Claude summary request is unchanged', () => {
  it('Haiku 4.5 with a schema and low effort: format only, no thinking', async () => {
    bodies.length = 0
    await adapterFor('claude').sendMessage({
      model: 'claude-haiku-4-5',
      apiKey: 'sk-test',
      system: 's',
      messages: 'evidence',
      schema: { name: 'memory', schema: { type: 'object' } },
      maxTokens: 2_000,
      effort: 'low',
      retries: 0
    })
    expect(bodies[0]).toEqual({
      model: 'claude-haiku-4-5',
      max_tokens: 2_000,
      system: 's',
      messages: [{ role: 'user', content: 'evidence' }],
      output_config: { format: { type: 'json_schema', schema: { type: 'object' } } }
    })
  })

  it('a model with no profile gets neither thinking nor effort', async () => {
    bodies.length = 0
    await adapterFor('claude').sendMessage({
      model: 'claude-unknown-9',
      apiKey: 'sk-test',
      system: 's',
      messages: 'hi',
      effort: 'high',
      retries: 0
    })
    expect('thinking' in bodies[0]).toBe(false)
    expect('output_config' in bodies[0]).toBe(false)
  })
})
