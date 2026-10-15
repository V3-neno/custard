import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OneShotRequest, OneShotResult } from '../adapters/types'
import { builtInProfiles, setProfiles, type Effort } from '../../shared/models'

// An automation step is one adapter.sendMessage call; what the reply means
// for the run must not depend on the provider (Phase 7).
const sent: OneShotRequest[] = []
let reply: Partial<OneShotResult> | Error = {}
vi.mock('../apiKey', () => ({ getApiKey: () => 'sk-test' }))
vi.mock('../store', () => ({ charge: vi.fn() }))
vi.mock('../adapters/registry', () => ({
  adapterFor: () => ({
    sendMessage: async (req: OneShotRequest): Promise<OneShotResult> => {
      sent.push(req)
      if (reply instanceof Error) throw reply
      return { text: '', calls: [], stop: 'done', usage: [], ...reply }
    }
  })
}))
const { CLAUDE_STEP_TOKENS, stepFor } = await import('./model')
const { charge } = await import('../store')

const run = async (model: string, effort?: Effort): Promise<unknown> => {
  const step = stepFor(model, effort)
  if (typeof step === 'string') throw new Error(step)
  return step({
    system: 's',
    messages: [{ role: 'user', content: 'go' }],
    tools: [],
    signal: new AbortController().signal
  })
}
const MODELS = ['claude-opus-5-5', 'gpt-6-astra', 'deepseek-flash']
const call = { id: 'c1', name: 'vault_list', input: {} }

describe('automation steps go through the adapter', () => {
  beforeEach(() => {
    sent.length = 0
    reply = {}
  })

  it('sends the same request shape for every provider', async () => {
    for (const m of MODELS) await run(m)
    expect(sent.map((r) => [r.model, r.stream, r.retries])).toEqual(MODELS.map((m) => [m, true, 0]))
  })

  // Automation thinking, Phase 2.
  it('Claude steps get 64,000 tokens; Responses providers no limit, as before', async () => {
    for (const m of [...MODELS, 'claude-sonnet-5-5', 'claude-haiku-4-5']) await run(m)
    expect(sent.map((r) => [r.model, r.maxTokens])).toEqual([
      ['claude-opus-5-5', 64_000],
      ['gpt-6-astra', undefined],
      ['deepseek-flash', undefined],
      ['claude-sonnet-5-5', 64_000],
      ['claude-haiku-4-5', 64_000]
    ])
  })

  it('the Claude step limit is at most every built-in Claude model’s output limit', () => {
    for (const m of builtInProfiles.filter((p) => p.provider === 'claude'))
      expect(CLAUDE_STEP_TOKENS).toBeLessThanOrEqual(m.limits.maxOutput)
  })

  it('a Claude model whose output limit is lower gets its own limit', async () => {
    setProfiles([
      ...builtInProfiles.filter((m) => m.id !== 'claude-sonnet-5-5'),
      { ...builtInProfiles[1], limits: { window: 200_000, maxOutput: 8_000 } }
    ])
    try {
      await run('claude-sonnet-5-5')
      expect(sent[0].maxTokens).toBe(8_000)
    } finally {
      setProfiles(builtInProfiles)
    }
  })

  it("passes the automation's effort when one is set, and none when not", async () => {
    for (const m of [...MODELS, 'claude-haiku-4-5']) {
      await run(m, 'high')
      await run(m)
    }
    expect(sent.map((r) => [r.model, r.effort])).toEqual([
      ['claude-opus-5-5', 'high'],
      ['claude-opus-5-5', undefined],
      ['gpt-6-astra', 'high'],
      ['gpt-6-astra', undefined],
      ['deepseek-flash', 'high'],
      ['deepseek-flash', undefined],
      // The adapter decides: Haiku 4.5's profile takes none (anthropic.ts).
      ['claude-haiku-4-5', 'high'],
      ['claude-haiku-4-5', undefined]
    ])
    expect(sent.filter((r) => !r.effort).every((r) => !('effort' in r))).toBe(true)
  })

  it('a reply with text and calls is the step', async () => {
    reply = { text: 'Listing.', calls: [call] }
    for (const m of MODELS) expect(await run(m)).toEqual({ text: 'Listing.', calls: [call] })
  })

  it('charges each model part to the month, not a chat', async () => {
    const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, webSearches: 0 }
    reply = { usage: [{ model: 'claude-opus-5-5', usage }] }
    await run('claude-opus-5-5')
    expect(charge).toHaveBeenCalledWith(null, 'claude-opus-5-5', usage)
  })

  it('ends the run the same way whichever provider answers', async () => {
    for (const m of MODELS) {
      reply = { stop: 'cut-off', calls: [call] }
      await expect(run(m)).rejects.toThrow('cut off while it was calling a tool')
      reply = { stop: 'cut-off', text: 'Partial' }
      expect(await run(m)).toEqual({ text: 'Partial', calls: [], cutOff: true })
      reply = { stop: 'too-long' }
      await expect(run(m)).rejects.toThrow('too long for the model')
      reply = { stop: 'refused' }
      await expect(run(m)).rejects.toThrow('declined this request')
      reply = { stop: 'failed', error: 'server busy' }
      await expect(run(m)).rejects.toThrow('could not finish this: server busy')
    }
  })

  it('names the provider in its errors', async () => {
    reply = { stop: 'refused' }
    await expect(run('claude-opus-5-5')).rejects.toThrow('Claude declined this request.')
    await expect(run('deepseek-flash')).rejects.toThrow('DeepSeek declined this request.')
  })

  it('refuses a model Custard no longer offers', () => {
    expect(stepFor('gpt-4')).toMatch(/isn't one Custard offers/)
  })

  // Phase A3: a profile gone from the registry stops the run the same way,
  // and nothing is sent.
  it('refuses a model whose profile is gone from the registry', () => {
    setProfiles(builtInProfiles.filter((m) => m.id !== 'deepseek-flash'))
    try {
      expect(stepFor('deepseek-flash')).toBe(
        "The model deepseek-flash isn't one Custard offers any more. Pick another."
      )
      expect(sent).toHaveLength(0)
    } finally {
      setProfiles(builtInProfiles)
    }
  })
})
