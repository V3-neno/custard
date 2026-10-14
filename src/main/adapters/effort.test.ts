import http from 'http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Effort } from '../../shared/chat'
import { adapterFor } from './registry'

// Effort reaches the request (Phase 6). A stand-in for DeepSeek and OpenAI
// records each request body; the adapter's one-shot call is the simplest
// path that builds one.
const bodies: Record<string, unknown>[] = []
let server: http.Server
beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const body = JSON.parse(raw)
      bodies.push(body)
      const refuse = body.input === 'please refuse'
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
              content: [
                refuse
                  ? { type: 'refusal', refusal: "I can't help with that." }
                  : { type: 'output_text', text: 'ok', annotations: [] }
              ]
            }
          ],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
        })
      )
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${port}/deepseek`
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${port}/openai/v1`
})
afterAll(() => {
  server.close()
  delete process.env.DEEPSEEK_BASE_URL
  delete process.env.OPENAI_BASE_URL
})

const send = async (
  provider: 'deepseek' | 'openai',
  model: string,
  effort?: Effort
): Promise<unknown> => {
  bodies.length = 0
  await adapterFor(provider).sendMessage({
    model,
    apiKey: 'sk-test',
    system: 's',
    messages: 'hi',
    maxTokens: 10,
    retries: 0,
    ...(effort ? { effort } : {})
  })
  return bodies[0]?.reasoning
}

describe('effort in the request', () => {
  it('DeepSeek Thorough, Balanced and Fast send max, high and low', async () => {
    expect(await send('deepseek', 'deepseek-flash', 'max')).toEqual({ effort: 'max' })
    expect(await send('deepseek', 'deepseek-v4-pro', 'high')).toEqual({ effort: 'high' })
    expect(await send('deepseek', 'deepseek-flash', 'low')).toEqual({ effort: 'low' })
  })

  it('DeepSeek never gets a level its Responses docs leave out', async () => {
    expect(await send('deepseek', 'deepseek-flash', 'medium')).toEqual({ effort: 'high' })
    expect(await send('deepseek', 'deepseek-flash', 'xhigh')).toEqual({ effort: 'high' })
  })

  it('OpenAI gets the level as picked; no effort means none is sent', async () => {
    expect(await send('openai', 'gpt-6-astra', 'xhigh')).toEqual({ effort: 'xhigh' })
    expect(await send('openai', 'gpt-6-astra')).toBeUndefined()
  })
})

// Phase 7: a one-shot call (a summary, an automation step) that OpenAI or
// DeepSeek declines says so, as Claude's does, instead of passing the
// refusal off as the answer.
describe('a declined one-shot call', () => {
  it('is refused', async () => {
    for (const p of ['openai', 'deepseek'] as const) {
      const r = await adapterFor(p).sendMessage({
        model: p === 'openai' ? 'gpt-6-astra' : 'deepseek-flash',
        apiKey: 'sk-test',
        system: 's',
        messages: 'please refuse',
        retries: 0
      })
      expect(r.stop).toBe('refused')
    }
  })
})
