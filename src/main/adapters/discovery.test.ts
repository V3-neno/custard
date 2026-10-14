import http from 'http'
import type { AddressInfo } from 'net'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { anthropicAdapter } from './anthropic'
import { CHECK_OPTS } from './common'
import { responsesAdapter } from './responses'
import { ProviderError } from '../providerError'

// Model discovery and key checks against a local stand-in for each
// provider's model list. Nothing here reaches a real provider.

const KEY = 'sk-test-SECRET-1234567890'
type Reply = { status?: number; type?: string; body: unknown; delayMs?: number }
let reply: Reply = { body: { data: [] } }
const seen: { path: string; auth?: string; xkey?: string }[] = []
const server = http.createServer((req, res) => {
  seen.push({
    path: req.url ?? '',
    auth: req.headers.authorization,
    xkey: req.headers['x-api-key'] as string | undefined
  })
  const r = typeof reply === 'function' ? (reply as (u: string) => Reply)(req.url ?? '') : reply
  setTimeout(() => {
    res.writeHead(r.status ?? 200, { 'content-type': r.type ?? 'application/json' })
    res.end(typeof r.body === 'string' ? r.body : JSON.stringify(r.body))
  }, r.delayMs ?? 0)
})
let base = ''
const logged: string[] = []
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  process.env.DEEPSEEK_BASE_URL = `${base}/deepseek`
  process.env.OPENAI_BASE_URL = `${base}/openai/v1`
  process.env.ANTHROPIC_BASE_URL = `${base}/anthropic`
  for (const level of ['log', 'warn', 'error', 'info', 'debug'] as const)
    vi.spyOn(console, level).mockImplementation((...a: unknown[]) => void logged.push(a.join(' ')))
})
afterAll(() => {
  server.close()
  vi.restoreAllMocks()
})
afterEach(() => {
  seen.length = 0
  CHECK_OPTS.timeout = 15_000
  // No key ever reaches a log line.
  expect(logged.join('\n')).not.toContain(KEY)
})

const deepseek = responsesAdapter('deepseek')
const openai = responsesAdapter('openai')
const failure = async (p: Promise<unknown>): Promise<ProviderError> => {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(ProviderError)
    return e as ProviderError
  }
  throw new Error('did not fail')
}

describe('DeepSeek model discovery', () => {
  it('asks GET /models with the Bearer key, and marks known and unknown models', async () => {
    reply = {
      body: {
        object: 'list',
        data: [
          { id: 'deepseek-flash', object: 'model', owned_by: 'deepseek', name: 'DeepSeek Flash' },
          {
            id: 'deepseek-v5-preview',
            object: 'model',
            owned_by: 'deepseek',
            name: 'DeepSeek V5 Preview',
            context_window: 2_000_000,
            max_output_tokens: 500_000
          }
        ]
      }
    }
    const l = await deepseek.listModels(KEY)
    expect(seen).toEqual([{ path: '/deepseek/models', auth: `Bearer ${KEY}`, xkey: undefined }])
    expect(l.checkedAt).toBeGreaterThan(0)
    const by = Object.fromEntries(l.models.map((m) => [m.id, m]))
    expect(by['deepseek-flash']).toMatchObject({ available: true, source: 'profile' })
    expect(by['deepseek-v4-pro']).toMatchObject({ available: false, source: 'profile' })
    expect(by['deepseek-v5-preview']).toMatchObject({
      source: 'discovered',
      label: 'DeepSeek V5 Preview',
      contextWindow: 2_000_000,
      maxOutput: 500_000,
      priced: false
    })
    // An unknown model promises nothing beyond text.
    expect(by['deepseek-v5-preview'].capabilities.tool_use.supported).toBe(false)
    expect(await deepseek.authenticate(KEY)).toEqual({ ok: true })
  })

  it('with no key, returns the known models unchecked and makes no call', async () => {
    const l = await deepseek.listModels(null)
    expect(seen).toEqual([])
    expect(l.checkedAt).toBeNull()
    expect(l.models.map((m) => [m.id, m.available])).toEqual([
      ['deepseek-v4-pro', 'unchecked'],
      ['deepseek-flash', 'unchecked']
    ])
  })

  it('an empty list marks every known model unavailable and discovers nothing', async () => {
    reply = { body: { object: 'list', data: [] } }
    const l = await deepseek.listModels(KEY)
    expect(l.models.every((m) => m.source === 'profile' && m.available === false)).toBe(true)
  })

  it('tells a wrong key apart from not being able to check', async () => {
    reply = {
      status: 401,
      body: { error: { message: `Authentication Fails, Your api key: ${KEY} is invalid` } }
    }
    const e = await failure(deepseek.listModels(KEY))
    expect(e.kind).toBe('auth')
    expect(e.message).not.toContain(KEY)
    expect(await deepseek.authenticate(KEY)).toEqual({
      ok: false,
      kind: 'auth',
      message: 'Your DeepSeek API key was rejected. Check it in Settings.'
    })

    reply = { status: 500, body: { error: { message: `server broke on ${KEY}` } } }
    const s = await failure(deepseek.listModels(KEY))
    expect(s.kind).toBe('server')
    expect(s.message).not.toContain(KEY)
    expect(s.message).not.toContain('SECRET')
  })

  it('hides a key the provider echoes back, even masked', async () => {
    reply = {
      status: 400,
      body: { error: { message: 'Incorrect API key provided: sk-test-***7890. Bad request.' } }
    }
    const e = await failure(deepseek.listModels(KEY))
    expect(e.kind).toBe('bad_request')
    expect(e.message).not.toMatch(/sk-/)
    expect(e.message).toContain('[key hidden]')
  })

  it('reads a timeout and an unreachable provider as "couldn\'t check"', async () => {
    CHECK_OPTS.timeout = 200
    reply = { body: { data: [] }, delayMs: 1000 }
    expect((await failure(deepseek.listModels(KEY))).kind).toBe('timeout')

    const saved = process.env.DEEPSEEK_BASE_URL
    process.env.DEEPSEEK_BASE_URL = 'http://127.0.0.1:9/deepseek'
    const n = await failure(deepseek.listModels(KEY))
    process.env.DEEPSEEK_BASE_URL = saved
    expect(n.kind).toBe('network')
    expect(n.message).toBe("Couldn't reach DeepSeek. Check your internet connection.")
  })

  it('refuses a malformed list instead of treating it as empty', async () => {
    for (const body of [
      '<html>not json</html>',
      { models: [] },
      { data: 'x' },
      { data: [{ name: 'no id' }] }
    ]) {
      reply = typeof body === 'string' ? { type: 'text/html', body } : { body }
      const e = await failure(deepseek.listModels(KEY))
      expect(e.kind).toBe('bad_response')
      expect(e.message).toBe("DeepSeek sent a model list Custard couldn't read.")
    }
  })
})

describe('Claude and OpenAI keep their fixed lists', () => {
  it('OpenAI marks its known models and never lists unknown ones', async () => {
    reply = { body: { object: 'list', data: [{ id: 'gpt-6-luna' }, { id: 'whisper-9' }] } }
    const l = await openai.listModels(KEY)
    expect(seen.map((s) => [s.path, s.auth])).toEqual([['/openai/v1/models', `Bearer ${KEY}`]])
    expect(l.models.every((m) => m.source === 'profile')).toBe(true)
    expect(l.models.find((m) => m.id === 'gpt-6-luna')?.available).toBe(true)
    expect(l.models.find((m) => m.id === 'gpt-6-astra')?.available).toBe(false)
  })

  it('Claude reads every page with x-api-key, and never lists unknown ones', async () => {
    reply = ((url: string) =>
      url.includes('after_id=p1')
        ? {
            body: {
              data: [{ id: 'claude-haiku-4-5' }],
              has_more: false,
              last_id: 'claude-haiku-4-5'
            }
          }
        : {
            body: {
              data: [
                { id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5' },
                { id: 'claude-x' }
              ],
              has_more: true,
              last_id: 'p1'
            }
          }) as unknown as Reply
    const l = await anthropicAdapter.listModels(KEY)
    expect(seen.map((s) => s.path)).toEqual([
      '/anthropic/v1/models?limit=1000',
      '/anthropic/v1/models?limit=1000&after_id=p1'
    ])
    expect(seen.every((s) => s.xkey === KEY && s.auth === undefined)).toBe(true)
    const avail = Object.fromEntries(l.models.map((m) => [m.id, m.available]))
    expect(avail).toEqual({
      'claude-opus-5-5': true,
      'claude-sonnet-5-5': false,
      'claude-haiku-4-5': true
    })
    reply = {
      status: 401,
      body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }
    }
    expect(await anthropicAdapter.authenticate(KEY)).toMatchObject({ ok: false, kind: 'auth' })
  })
})
