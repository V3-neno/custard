import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Conversation } from '../shared/chat'
import { costOf, formatCost, formatTokens, noUsage, type TokenUsage } from '../shared/pricing'
import { charger, claudeParts, fromClaude, fromOpenAI, normalizeBudget, UsageLedger } from './usage'

const u = (p: Partial<TokenUsage>): TokenUsage => ({ ...noUsage(), ...p })
const M = 1_000_000

let dir: string
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), 'custard-usage-'))))
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('prices', () => {
  it('prices Claude calls at the published rates, cache and web search included', () => {
    expect(costOf('claude-opus-5-5', u({ input: M, output: M }))).toBeCloseTo(24)
    expect(costOf('claude-sonnet-5-5', u({ cacheRead: M, cacheWrite: M }))).toBeCloseTo(2.6)
    expect(costOf('claude-haiku-4-5', u({ input: M, cacheRead: M }))).toBeCloseTo(1.1)
    expect(costOf('claude-opus-5-5', u({ webSearches: 3 }))).toBeCloseTo(0.03)
    // A suffixed id is priced as its base model.
    expect(costOf('claude-opus-5-5-20261001', u({ input: M }))).toBeCloseTo(4)
  })
  it('prices OpenAI calls, with long-context rates for the whole request past 270K', () => {
    expect(costOf('gpt-6.1-sol', u({ input: 100_000, output: 10_000 }))).toBeCloseTo(0.3)
    expect(costOf('gpt-6.1-sol', u({ input: 300_000, output: 10_000 }))).toBeCloseTo(1.35)
    // Cached input counts toward the threshold.
    expect(costOf('gpt-6-luna', u({ input: 1000, cacheRead: 270_000 }))).toBeCloseTo(
      (1000 * 0.2 + 270_000 * 0.02) / M
    )
    expect(costOf('gpt-6-astra', u({ output: M }))).toBeCloseTo(50)
  })
  it('has no price for an unknown model', () => {
    expect(costOf('some-new-model', u({ input: 10 }))).toBeNull()
  })
  it('formats costs and tokens', () => {
    expect([0, 0.004, 0.034, 12.4].map(formatCost)).toEqual(['$0.00', '<$0.01', '$0.03', '$12.40'])
    expect([950, 1240, 12_400, 150_000, 1_200_000].map(formatTokens)).toEqual([
      '950',
      '1.2k',
      '12k',
      '150k',
      '1.2M'
    ])
  })
})

describe('provider usage', () => {
  it("reads Claude's usage block", () => {
    expect(
      fromClaude({
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: 3,
        cache_read_input_tokens: 7,
        server_tool_use: { web_search_requests: 2 }
      })
    ).toEqual({ input: 10, output: 5, cacheWrite: 3, cacheRead: 7, webSearches: 2 })
    expect(fromClaude(undefined)).toEqual(noUsage())
  })
  it('splits a Claude call into its server steps, each priced as its own model', () => {
    const parts = claudeParts(
      {
        input_tokens: 5,
        output_tokens: 5,
        server_tool_use: { web_search_requests: 1 },
        iterations: [
          { input_tokens: 100, output_tokens: 20, model: 'claude-opus-5-5' },
          { input_tokens: 50, output_tokens: 10, model: null }
        ]
      },
      'claude-sonnet-5-5'
    )
    expect(parts.map((p) => [p.model, p.usage.input, p.usage.output, p.usage.webSearches])).toEqual(
      [
        ['claude-opus-5-5', 100, 20, 0],
        ['claude-sonnet-5-5', 50, 10, 1]
      ]
    )
    expect(fromClaude({ iterations: [{ input_tokens: 3 }, { input_tokens: 4 }] }).input).toBe(7)
  })
  it("takes the cached part out of OpenAI's input", () => {
    expect(
      fromOpenAI(
        { input_tokens: 100, output_tokens: 9, input_tokens_details: { cached_tokens: 40 } },
        1
      )
    ).toEqual({ input: 60, output: 9, cacheWrite: 0, cacheRead: 40, webSearches: 1 })
  })
})

describe('the ledger', () => {
  it('adds up each month, keeps two years, and reads back an unreadable file as empty', () => {
    const file = join(dir, 'usage.json')
    let now = new Date(2026, 9, 12).getTime()
    const ledger = new UsageLedger(file, () => now)
    expect(ledger.add('claude-opus-5-5', u({ input: M }))).toBeCloseTo(4)
    expect(ledger.add('mystery', u({ input: M }))).toBeNull()
    expect(ledger.thisMonth(10)).toMatchObject({
      month: '2026-10',
      calls: 2,
      unpriced: 1,
      budget: 10
    })
    expect(ledger.thisMonth(null).cost).toBeCloseTo(4)
    for (let i = 1; i <= 30; i++) {
      now = new Date(2026, 9 + i, 1).getTime()
      ledger.add('claude-opus-5-5', u({ output: 1 }))
    }
    const months = Object.keys(JSON.parse(readFileSync(file, 'utf8')).months)
    expect(months).toHaveLength(24)
    expect(months).not.toContain('2026-10')
    writeFileSync(file, 'not json')
    expect(ledger.thisMonth(null)).toMatchObject({ cost: 0, calls: 0 })
  })
  it('charges a chat in place or by id, and skips empty usage', () => {
    const file = join(dir, 'usage.json')
    const saved = new Map<string, Conversation>()
    const chat = (id: string): Conversation => ({
      id,
      mode: 'chat',
      title: id,
      createdAt: 0,
      updatedAt: 0,
      messages: []
    })
    saved.set('b', chat('b'))
    const charge = charger(new UsageLedger(file), (id, change) => change(saved.get(id)!))
    const live = chat('a')
    charge(live, 'claude-sonnet-5-5', u({ input: M, output: M }))
    charge(live, 'mystery', u({ input: 5 }))
    expect(live.usage).toMatchObject({ input: M + 5, output: M, calls: 2, unpriced: 1 })
    expect(live.usage!.cost).toBeCloseTo(12)
    charge('b', 'claude-haiku-4-5', u({ output: M }))
    expect(saved.get('b')!.usage!.cost).toBeCloseTo(5)
    charge(null, 'claude-haiku-4-5', u({ output: M }))
    charge(live, 'claude-opus-5-5', noUsage())
    expect(live.usage!.calls).toBe(2)
    expect(existsSync(file)).toBe(true)
  })
  it('accepts a budget of a positive number of dollars, or none', () => {
    expect([20, 12.345, 0, -5, 'x', NaN, 2_000_000, null].map(normalizeBudget)).toEqual([
      20,
      12.35,
      null,
      null,
      null,
      null,
      null,
      null
    ])
  })
})
