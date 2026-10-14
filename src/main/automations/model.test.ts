import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OneShotRequest, OneShotResult } from '../adapters/types'

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
const { stepFor } = await import('./model')
const { charge } = await import('../store')

const run = async (model: string): Promise<unknown> => {
  const step = stepFor(model)
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
    expect(sent.map((r) => [r.model, r.stream, r.retries, r.maxTokens])).toEqual(
      MODELS.map((m) => [m, true, 0, undefined])
    )
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
      expect(await run(m)).toEqual({ text: 'Partial', calls: [] })
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
})
