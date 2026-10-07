import { describe, expect, it, vi } from 'vitest'
import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import type {
  BetaContentBlock,
  BetaMessageParam
} from '@anthropic-ai/sdk/resources/beta/messages/messages'
import type { Conversation } from '../shared/chat'
import {
  budgetFor,
  capResult,
  COMPACT_TRIGGER,
  compactTrigger,
  estimateTokens,
  fromLastCompaction,
  isContextError,
  limitsFor,
  maxResultChars,
  measure
} from './context'
import {
  claudeHistory,
  compactionRefused,
  dropBeforeCompaction,
  isCompactionRejected,
  openaiStart,
  recordClaudeCompaction,
  recordOpenAICompaction,
  usesCompaction
} from './compaction'
import {
  actionLedger,
  carriedContext,
  carriedUnknown,
  continuationPrompt,
  handoffEvidence,
  HANDOFF_LIMITS,
  type HandoffSummary
} from './handoff'
import { continueChat, continuationsOf, type ContinueDeps } from './continue'
import { actionKey, repairInterrupted, TurnLog, type Call } from './turn'
import { toInput } from './openai'
import { buildEvidence, evidenceText } from './memory/evidence'
import { searchExposure } from './web'

const conv = (over: Partial<Conversation> = {}): Conversation => ({
  id: 'orig',
  mode: 'chat',
  title: 'Plan the launch',
  createdAt: 0,
  updatedAt: 0,
  messages: [],
  ...over
})

// A chat with a decision, a read, an accepted change, a failure, a decline
// and an action whose outcome is unknown.
function workedChat(): Conversation {
  const c = conv()
  const send = { to: 'team@example.com', subject: 'Launch' }
  c.messages = [
    { role: 'user', content: 'Plan the launch for Friday. Never email customers directly.' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Reading the plan.' },
        { type: 'tool_use', id: 'r1', name: 'vault_read', input: { path: 'Plan.md' } }
      ]
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'r1', content: 'SECRET PLAN CONTENTS' }]
    },
    { role: 'assistant', content: 'Decided: launch Friday 10:00.' },
    { role: 'user', content: 'Send the team email and add the calendar event.' },
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'w1', name: 'mail__send', input: send },
        { type: 'tool_use', id: 'w2', name: 'cal__add', input: { day: 'Fri' } },
        { type: 'tool_use', id: 'w3', name: 'vault_append', input: { path: 'Log.md' } },
        { type: 'tool_use', id: 'w4', name: 'crm__update', input: { id: 7 } }
      ]
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'w1', content: 'Outcome unknown: timed out' },
        { type: 'tool_result', tool_use_id: 'w2', content: 'Calendar API error 500' },
        { type: 'tool_result', tool_use_id: 'w3', content: 'Appended' },
        { type: 'tool_result', tool_use_id: 'w4', content: 'Not run: declined' }
      ]
    },
    { role: 'assistant', content: 'The email may or may not have gone out.' }
  ]
  c.actions = {
    r1: {
      name: 'vault_read',
      label: 'Read Plan.md',
      write: false,
      status: 'completed',
      key: actionKey('vault_read', { path: 'Plan.md' }),
      result: 'SECRET PLAN CONTENTS'
    },
    w1: {
      name: 'mail__send',
      label: 'Send email to team',
      write: true,
      status: 'unknown',
      key: actionKey('mail__send', send),
      result: 'Outcome unknown: timed out'
    },
    w2: {
      name: 'cal__add',
      label: 'Add calendar event',
      write: true,
      status: 'failed',
      key: actionKey('cal__add', { day: 'Fri' }),
      result: 'Calendar API error 500'
    },
    w3: {
      name: 'vault_append',
      label: 'Append to Log.md',
      write: true,
      status: 'completed',
      key: actionKey('vault_append', { path: 'Log.md' }),
      result: 'Appended'
    },
    w4: {
      name: 'crm__update',
      label: 'Update CRM record',
      write: true,
      status: 'not-run',
      key: actionKey('crm__update', { id: 7 }),
      result: 'Not run: declined'
    }
  }
  return c
}

const summary: HandoffSummary = {
  goal: 'Launch on Friday',
  constraints: ['Never email customers directly'],
  decisions: ['Launch Friday 10:00'],
  open: ['Check whether the team email went out'],
  state: 'Email outcome unknown; calendar failed.'
}

// In-memory store for continueChat; records every save.
function store(...chats: Conversation[]): ContinueDeps & {
  all: Map<string, Conversation>
  saves: string[]
} {
  const all = new Map(chats.map((c) => [c.id, c]))
  const saves: string[] = []
  let n = 0
  return {
    all,
    saves,
    load: (id) => (all.has(id) ? structuredClone(all.get(id)!) : null),
    create: (mode, title) => ({
      id: `new${++n}`,
      mode,
      title,
      createdAt: 1,
      updatedAt: 1,
      messages: []
    }),
    save: (c) => {
      saves.push(c.id)
      all.set(c.id, structuredClone(c))
    },
    summarizer: () => async () => summary,
    now: () => 42
  }
}

describe('context budget', () => {
  it('keeps output room and a margin for every model', () => {
    expect(budgetFor('claude-opus-5-5')).toBe(Math.floor((1_000_000 - 64_000) * 0.95))
    expect(budgetFor('claude-haiku-4-5')).toBe(Math.floor((200_000 - 64_000) * 0.95))
    expect(budgetFor('gpt-6-luna')).toBe(Math.floor((1_050_000 - 64_000) * 0.95))
    // Unknown models get the smallest window, not the largest.
    expect(limitsFor('some-new-model').window).toBe(200_000)
  })

  it("sets each model's compaction trigger from its own budget", () => {
    // Large models: 400,000, under half their budget.
    for (const m of ['claude-opus-5-5', 'claude-sonnet-5-5', 'gpt-6-astra', 'gpt-6-luna']) {
      expect(compactTrigger(m)).toBe(COMPACT_TRIGGER)
      expect(compactTrigger(m)).toBeLessThanOrEqual(budgetFor(m) * 0.5)
    }
    // A smaller window gets a lower trigger: half of Haiku's 129,200 budget.
    expect(compactTrigger('claude-haiku-4-5')).toBe(64_600)
    // Never below Claude's documented minimum of 50,000.
    expect(compactTrigger('claude-unknown-small')).toBeGreaterThanOrEqual(50_000)
  })

  it('estimates conservatively and only asks the provider near the limit', async () => {
    const count = vi.fn(async () => 1)
    const small = await measure('claude-haiku-4-5', 1_000, count)
    expect(count).not.toHaveBeenCalled()
    expect(small).toMatchObject({ counted: false, over: false, warn: false })

    const budget = budgetFor('claude-haiku-4-5')
    const near = await measure('claude-haiku-4-5', budget * 0.8, async () => budget * 0.8)
    expect(near).toMatchObject({ counted: true, over: false, warn: true })

    // The provider's count wins: a high estimate that counts low is not over.
    const counted = await measure('claude-haiku-4-5', budget * 1.2, async () => budget * 0.6)
    expect(counted).toMatchObject({ counted: true, over: false, warn: false })
  })

  it('falls back to the estimate when counting fails', async () => {
    const budget = budgetFor('gpt-6-astra')
    const fit = await measure('gpt-6-astra', budget + 1, async () => {
      throw new Error('rate limited')
    })
    expect(fit).toMatchObject({ counted: false, over: true, tokens: budget + 1 })
  })

  it('counts system, tools and history in the estimate', () => {
    const big = 'x'.repeat(30_000)
    expect(estimateTokens(big)).toBeGreaterThanOrEqual(10_000)
    expect(estimateTokens(big, big, [{ role: 'user', content: big }])).toBeGreaterThanOrEqual(
      30_000
    )
  })

  it('shortens an oversized tool result and says so', () => {
    const max = maxResultChars('claude-haiku-4-5')
    expect(max).toBeLessThanOrEqual(100_000)
    const out = capResult('y'.repeat(max * 3), 'claude-haiku-4-5')
    expect(out.length).toBeLessThan(max + 400)
    expect(out).toMatch(/Custard shortened this result/)
    expect(capResult('short', 'claude-haiku-4-5')).toBe('short')
  })
})

describe('context errors', () => {
  const anthropic = (status: number, message: string): Error =>
    Anthropic.APIError.generate(
      status,
      { type: 'error', error: { type: 'invalid_request_error', message } },
      message,
      new Headers()
    )
  const openai = (status: number, code: string | undefined, message: string): Error =>
    OpenAI.APIError.generate(
      status,
      { error: { message, code, type: 'invalid_request_error' } },
      message,
      new Headers()
    )

  it('recognizes a request that is too large', () => {
    expect(isContextError(anthropic(400, 'prompt is too long: 1200000 tokens > 1000000'))).toBe(
      true
    )
    expect(isContextError(anthropic(413, 'request_too_large'))).toBe(true)
    expect(isContextError(openai(400, 'context_length_exceeded', 'Too long'))).toBe(true)
  })

  it('leaves other errors alone', () => {
    expect(isContextError(anthropic(400, 'tools.0: invalid schema'))).toBe(false)
    expect(isContextError(anthropic(429, 'rate limited'))).toBe(false)
    expect(isContextError(openai(400, 'invalid_value', 'bad model'))).toBe(false)
    expect(isContextError(new Error('prompt is too long'))).toBe(false)
  })

  it('retries without compaction only on a definite "not supported" 400', () => {
    expect(
      isCompactionRejected(anthropic(400, 'context_management: Extra inputs are not permitted'))
    ).toBe(true)
    expect(
      isCompactionRejected(anthropic(400, 'compact_20260112 is not supported on this model'))
    ).toBe(true)
    const param = OpenAI.APIError.generate(
      400,
      {
        error: {
          message: "Unsupported parameter: 'context_management'.",
          type: 'invalid_request_error',
          param: 'context_management',
          code: 'unsupported_parameter'
        }
      },
      undefined,
      new Headers()
    )
    expect(isCompactionRejected(param)).toBe(true)
  })

  it('never treats ambiguous failures as "not supported"', () => {
    // A 400 about compaction that isn't "unsupported" (a bad value).
    expect(
      isCompactionRejected(
        anthropic(400, 'context_management.edits.0.trigger.value: must be >= 50000')
      )
    ).toBe(false)
    // Too long, even when the message mentions compaction.
    expect(
      isCompactionRejected(anthropic(400, 'prompt is too long; compaction not supported'))
    ).toBe(false)
    // Server errors, rate limits and timeouts may have done work or may pass.
    expect(isCompactionRejected(anthropic(500, 'context_management not supported'))).toBe(false)
    expect(isCompactionRejected(anthropic(529, 'Overloaded'))).toBe(false)
    expect(isCompactionRejected(openai(429, 'rate_limit_exceeded', 'compaction unsupported'))).toBe(
      false
    )
    expect(isCompactionRejected(new Anthropic.APIConnectionTimeoutError())).toBe(false)
    expect(isCompactionRejected(new OpenAI.APIConnectionError({ message: 'reset' }))).toBe(false)
    // An error without a status (e.g. an error event mid-stream) is not it.
    expect(isCompactionRejected(new Error('context_management is not supported'))).toBe(false)
  })
})

describe('provider history', () => {
  const compaction = {
    type: 'compaction' as const,
    content: 'Summary of earlier messages',
    encrypted_content: 'enc'
  }
  const history: BetaMessageParam[] = [
    { role: 'user', content: 'one' },
    { role: 'assistant', content: [{ type: 'text', text: 'two' }] },
    { role: 'user', content: 'three' },
    {
      role: 'assistant',
      content: [
        compaction,
        { type: 'thinking', thinking: 't', signature: 'sig' },
        { type: 'tool_use', id: 'u1', name: 'vault_list', input: {} }
      ]
    },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u1', content: 'ok' }] }
  ]

  it('keeps compaction blocks, unchanged, for Claude models that compact', () => {
    expect(claudeHistory(history, 'claude-opus-5-5')).toBe(history)
    expect(fromLastCompaction(history)).toEqual([history[3], history[4]])
  })

  it('leaves them out for Haiku without touching anything else', () => {
    const h = claudeHistory(history, 'claude-haiku-4-5')
    expect(h).toHaveLength(5)
    const last = h[3].content as { type: string }[]
    expect(last.map((b) => b.type)).toEqual(['thinking', 'tool_use'])
    // The stored history is not changed.
    expect((history[3].content as { type: string }[])[0].type).toBe('compaction')
    // Thinking and the tool_use/tool_result pair are left as they were.
    expect(h[3].content).toContainEqual({ type: 'thinking', thinking: 't', signature: 'sig' })
    expect(h[4]).toBe(history[4])
  })

  it('gives OpenAI no Claude compaction or thinking, and keeps call pairs', () => {
    const items = toInput(history)
    expect(items.some((x) => x.type === 'compaction')).toBe(false)
    expect(JSON.stringify(items)).not.toContain('Summary of earlier messages')
    const call = items.find((x) => x.type === 'function_call')
    const out = items.find((x) => x.type === 'function_call_output')
    expect(call && 'call_id' in call && call.call_id).toBe('u1')
    expect(out && 'call_id' in out && out.call_id).toBe('u1')
  })

  it('records where Claude compacted', () => {
    const c = conv({ messages: history.slice(0, 3) })
    const content = [compaction, { type: 'text', text: 'hi' }] as unknown as BetaContentBlock[]
    expect(recordClaudeCompaction(c, content, 'claude-opus-5-5', 5)).toBe(true)
    expect(c.compactions).toEqual([
      { after: 3, at: 5, provider: 'claude', model: 'claude-opus-5-5' }
    ])
    expect(recordClaudeCompaction(c, [], 'claude-opus-5-5')).toBe(false)
  })

  it("starts OpenAI from its newest compaction, and only the same model's", () => {
    const c = conv({ messages: history.slice(0, 3) })
    recordOpenAICompaction(
      c,
      { id: 'cmp_1', type: 'compaction', encrypted_content: 'E1' },
      'gpt-6-astra',
      1
    )
    c.messages.push({ role: 'assistant', content: [{ type: 'text', text: 'four' }] })
    expect(c.compactions?.[0].after).toBe(3)
    const start = openaiStart(c, 'gpt-6-astra')
    expect(start).toEqual({
      item: { type: 'compaction', id: 'cmp_1', encrypted_content: 'E1' },
      from: 3
    })
    // Another OpenAI model gets the full history.
    expect(openaiStart(c, 'gpt-6-luna')).toEqual({ item: null, from: 0 })
  })

  it('drops input before the newest OpenAI compaction item within a turn', () => {
    const input = [
      { role: 'user' as const, content: 'old' },
      { type: 'compaction' as const, encrypted_content: 'E' },
      { role: 'user' as const, content: 'new' }
    ]
    expect(dropBeforeCompaction(input)).toEqual(input.slice(1))
    expect(dropBeforeCompaction(input.slice(2))).toEqual(input.slice(2))
  })

  it('stops using compaction for a model that turned it down', () => {
    expect(usesCompaction('gpt-6.1-sol')).toBe(true)
    compactionRefused('gpt-6.1-sol')
    expect(usesCompaction('gpt-6.1-sol')).toBe(false)
    const c = conv()
    recordOpenAICompaction(
      c,
      { id: 'x', type: 'compaction', encrypted_content: 'E' },
      'gpt-6.1-sol'
    )
    expect(openaiStart(c, 'gpt-6.1-sol').item).toBeNull()
  })
})

describe('action record', () => {
  it('keeps unknown, failed, declined and accepted actions apart', () => {
    const { text, counts } = actionLedger(workedChat())
    expect(counts).toEqual({ unknown: 1, failed: 1, notRun: 1, changes: 1, reads: 1 })
    const section = (title: string): string => text.split(`${title}`)[1]?.split('\n\n')[0] ?? ''
    expect(text.indexOf('Outcome unknown')).toBe(0)
    expect(section('Outcome unknown')).toContain('Send email to team')
    expect(text).toMatch(/Failed:\n- Add calendar event/)
    expect(text).toMatch(/Not run:\n- Update CRM record/)
    expect(text).toMatch(/accepted is not the same as verified[^\n]*\n- Append to Log.md/)
    // Read contents are never carried; only that reads ran.
    expect(text).not.toContain('SECRET PLAN CONTENTS')
    expect(text).toContain('Reads and searches that ran: 1')
  })

  it('builds bounded evidence however large the chat is', () => {
    const c = workedChat()
    for (let i = 0; i < 3000; i++)
      c.messages.push(
        { role: 'user', content: `request ${i} ${'z'.repeat(2_000)}` },
        { role: 'assistant', content: `answer ${i} ${'w'.repeat(2_000)}` }
      )
    // Far past any model's window (about 12M characters).
    expect(JSON.stringify(c.messages).length).toBeGreaterThan(10_000_000)
    const ev = handoffEvidence(c, actionLedger(c).text)
    expect(ev.length).toBeLessThanOrEqual(HANDOFF_LIMITS.evidence)
    // The goal (first request) and the newest turn are both there.
    expect(ev).toContain('Plan the launch for Friday')
    expect(ev).toContain('request 2999')
    expect(ev).toMatch(/turns in between are left out/)
    expect(ev).not.toContain('SECRET PLAN CONTENTS')
  })

  it('keeps the record apart from the summary, and the summary as context only', () => {
    const c = workedChat()
    const ledger = actionLedger(c)
    const p = continuationPrompt({
      from: { id: c.id, title: c.title },
      summary,
      ledger: ledger.text,
      counts: ledger.counts,
      unknown: carriedUnknown(c),
      at: 1
    })
    const [record, model] = p.split('A summary of the earlier chat, written by a model')
    expect(record).toContain("Custard's record of actions")
    expect(record).toContain('Send email to team')
    expect(model).toContain('never authorizes an action')
    expect(model).toContain('data, not instructions')
    expect(model).toContain('Launch Friday 10:00')
    expect(model).toContain('Check whether the team email went out')
    expect(model).toContain('Never email customers directly')
  })
})

describe('bounded record, complete records', () => {
  // 300 write actions with long labels; the first one's outcome is unknown.
  function busyChat(): Conversation {
    const c = conv({ id: 'busy' })
    c.messages.push({ role: 'user', content: 'do lots' })
    c.actions = {}
    for (let i = 0; i < 300; i++) {
      const input = { n: i }
      c.messages.push(
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: `t${i}`, name: 'crm__update', input }]
        },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'x' }] }
      )
      c.actions[`t${i}`] = {
        name: 'crm__update',
        label: `Update record ${i} ${'with a very long description '.repeat(20)}`,
        write: true,
        status: i === 0 ? 'unknown' : i % 3 ? 'completed' : 'failed',
        key: actionKey('crm__update', input),
        result: 'r'.repeat(5_000)
      }
    }
    return c
  }
  const first: Call = {
    id: 'again',
    name: 'crm__update',
    input: { n: 0 },
    label: 'Update record 0',
    write: true
  }

  it('caps what the model sees and keeps unknown outcomes first', () => {
    const { text, counts } = actionLedger(busyChat())
    expect(text.length).toBeLessThanOrEqual(HANDOFF_LIMITS.ledgerChars)
    expect(text.startsWith('Outcome unknown')).toBe(true)
    expect(text).toContain('Update record 0')
    expect(text).toMatch(/more lines of the record left out for length/)
    // The counts are complete even where the lines were cut.
    expect(counts).toMatchObject({ unknown: 1, failed: 99, changes: 200 })
  })

  it('keeps every record in the chat itself', async () => {
    const c = busyChat()
    const s = store(c)
    const r = await continueChat(s, 'busy')
    if (!r.ok) throw new Error()
    expect(Object.keys(s.all.get('busy')!.actions!)).toHaveLength(300)
    expect(s.all.get('busy')!.actions!.t5.result).toHaveLength(5_000)
    // The carried guard list is complete, not the shown text.
    expect(r.conversation.continuedFrom!.unknown.map((u) => u.key)).toEqual([
      actionKey('crm__update', { n: 0 })
    ])
  })

  it('blocks a repeat in code even when the text never mentions it', async () => {
    const c = busyChat()
    // 80 more unknown outcomes push action 0 out of the shown record.
    for (let i = 300; i < 380; i++) {
      c.messages.push({
        role: 'assistant',
        content: [{ type: 'tool_use', id: `t${i}`, name: 'crm__update', input: { n: i } }]
      })
      c.messages.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'x' }]
      })
      c.actions![`t${i}`] = {
        name: 'crm__update',
        label: `Update record ${i}`,
        write: true,
        status: 'unknown',
        key: actionKey('crm__update', { n: i })
      }
    }
    const s = store(c)
    const r = await continueChat(s, 'busy')
    if (!r.ok) throw new Error()
    expect(r.conversation.continuedFrom!.ledger).not.toMatch(/Update record 0 /)
    // Saved and loaded again, as after a restart: the guard still holds.
    const reloaded = JSON.parse(JSON.stringify(r.conversation)) as Conversation
    expect(new TurnLog(reloaded, () => {}).unknownRepeat(first)).toBe(true)
  })

  it('holds across compaction and a crash mid-action', () => {
    const c = busyChat()
    // Custard was killed while action 0 ran; it was saved as running.
    c.actions!.t0.status = 'running'
    c.messages = c.messages.slice(0, 2)
    recordClaudeCompaction(
      c,
      [{ type: 'compaction', content: 'Summary', encrypted_content: 'e' }] as BetaContentBlock[],
      'claude-opus-5-5'
    )
    const reloaded = JSON.parse(JSON.stringify(c)) as Conversation
    expect(repairInterrupted(reloaded)).toBe(true)
    expect(reloaded.actions!.t0.status).toBe('unknown')
    expect(new TurnLog(reloaded, () => {}).unknownRepeat(first)).toBe(true)
  })
})

describe('continue in a new chat', () => {
  it('creates a linked chat and never writes the original', async () => {
    const original = workedChat()
    const before = JSON.stringify(original)
    const s = store(original)
    const r = await continueChat(s, 'orig')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(s.saves).toEqual([r.conversation.id])
    expect(JSON.stringify(s.all.get('orig'))).toBe(before)
    const k = r.conversation.continuedFrom!
    expect(k.from).toEqual({ id: 'orig', title: 'Plan the launch' })
    expect(k.summary).toEqual(summary)
    expect(k.unknown).toEqual([
      {
        key: actionKey('mail__send', { to: 'team@example.com', subject: 'Launch' }),
        name: 'mail__send',
        label: 'Send email to team'
      }
    ])
    expect(r.conversation.messages).toEqual([])
    expect(r.conversation.title).toBe('Plan the launch (continued)')
  })

  it('leaves only the original when the summary fails, and can retry or skip', async () => {
    const original = workedChat()
    const before = JSON.stringify(original)
    const s = store(original)
    s.summarizer = () => async () => {
      throw new Error('overloaded')
    }
    const r = await continueChat(s, 'orig')
    expect(r).toEqual({
      ok: false,
      error: "Couldn't write the summary: overloaded",
      canSkipSummary: true
    })
    expect(s.saves).toEqual([])
    expect(s.all.size).toBe(1)
    expect(JSON.stringify(s.all.get('orig'))).toBe(before)

    // Without a summary: the record still comes along.
    const skip = await continueChat(s, 'orig', { withoutSummary: true })
    expect(skip.ok && skip.conversation.continuedFrom?.summary).toBeNull()
    expect(skip.ok && skip.conversation.continuedFrom?.ledger).toContain('Send email to team')
    expect(skip.ok && continuationPrompt(skip.conversation.continuedFrom!)).toMatch(
      /There is no summary/
    )

    // A retry after the failure works normally.
    s.summarizer = () => async () => summary
    expect((await continueChat(s, 'orig')).ok).toBe(true)
  })

  it('needs a key for a summary but not to skip one', async () => {
    const s = store(workedChat())
    s.summarizer = () => null
    const r = await continueChat(s, 'orig')
    expect(r).toMatchObject({ ok: false, canSkipSummary: true })
    expect((await continueChat(s, 'orig', { withoutSummary: true })).ok).toBe(true)
  })

  it('sends the summarizer only bounded evidence, with no tools to run', async () => {
    const s = store(workedChat())
    const seen: string[] = []
    s.summarizer = () => async (evidence) => {
      seen.push(evidence)
      return summary
    }
    await continueChat(s, 'orig')
    expect(seen).toHaveLength(1)
    expect(seen[0].length).toBeLessThanOrEqual(HANDOFF_LIMITS.evidence)
    // Continuing never runs a tool: nothing in the original changes status.
    expect(s.all.get('orig')?.actions?.w1.status).toBe('unknown')
  })

  it('carries memory settings over and never makes a chat rememberable', async () => {
    const temp = workedChat()
    temp.memory = { off: true, temporary: true, watermark: 0 }
    const off = { ...workedChat(), id: 'off', memory: { off: true, watermark: 3 } }
    const forgotten = {
      ...workedChat(),
      id: 'gone',
      memory: { off: true, forgotten: true, watermark: 0 }
    }
    const normal = { ...workedChat(), id: 'normal' }
    const s = store(temp, off, forgotten, normal)
    const get = async (id: string): Promise<Conversation> => {
      const r = await continueChat(s, id)
      if (!r.ok) throw new Error(r.error)
      return r.conversation
    }
    expect((await get('orig')).memory).toEqual({ off: true, temporary: true, watermark: 0 })
    expect((await get('off')).memory).toEqual({ off: true, watermark: 0 })
    expect((await get('gone')).memory).toEqual({ off: true, watermark: 0 })
    expect((await get('normal')).memory).toBeUndefined()
  })

  it('never puts the handoff in what memory capture reads', async () => {
    const s = store(workedChat())
    const r = await continueChat(s, 'orig')
    if (!r.ok) throw new Error(r.error)
    const next = r.conversation
    next.messages.push(
      { role: 'user', content: 'What next?' },
      { role: 'assistant', content: 'Check the email first.' }
    )
    const text = evidenceText(buildEvidence(next, 0, next.messages.length))
    expect(text).not.toContain('Launch Friday 10:00')
    expect(text).not.toContain('Send email to team')
    expect(text).toContain('What next?')
  })

  it('finds every chat that continues one, for Forget', async () => {
    const s = store(workedChat())
    const a = await continueChat(s, 'orig')
    if (!a.ok) throw new Error()
    const b = await continueChat(s, a.conversation.id)
    if (!b.ok) throw new Error()
    const all = [...s.all.values()]
    expect(continuationsOf(all, 'orig').map((c) => c.id)).toEqual([
      a.conversation.id,
      b.conversation.id
    ])
    expect(continuationsOf(all, b.conversation.id)).toEqual([])
    // The chat two steps on still carries the first chat's unknown action
    // and its record.
    expect(b.conversation.continuedFrom?.unknown.map((u) => u.name)).toEqual(['mail__send'])
    expect(b.conversation.continuedFrom?.ledger).toContain('From the chat before that')
  })
})

describe('repeat protection and search gate across compaction and continuation', () => {
  const mail: Call = {
    id: 'n1',
    name: 'mail__send',
    input: { subject: 'Launch', to: 'team@example.com' },
    label: 'Send email to team',
    write: true
  }

  it('warns before repeating an unknown action in a continuation chat', async () => {
    const s = store(workedChat())
    const r = await continueChat(s, 'orig')
    if (!r.ok) throw new Error()
    const log = new TurnLog(r.conversation, () => {})
    expect(log.unknownRepeat(mail)).toBe(true)
    expect(log.unknownRepeat({ ...mail, input: { subject: 'Other', to: 'x' } })).toBe(false)
  })

  it('still warns after a compaction: the records are not summarized away', () => {
    const c = workedChat()
    recordClaudeCompaction(
      c,
      [{ type: 'compaction', content: 'All done.', encrypted_content: null }] as BetaContentBlock[],
      'claude-opus-5-5'
    )
    c.messages.push({
      role: 'assistant',
      content: [{ type: 'compaction', content: 'All done.', encrypted_content: null }]
    })
    expect(new TurnLog(c, () => {}).unknownRepeat(mail)).toBe(true)
    // The model is given Custard's own record next to the summary.
    const carried = carriedContext(c)
    expect(carried.system.join('\n')).toMatch(/OUTCOME UNKNOWN/)
    expect(carried.injected).toContain('a summary of earlier messages')
  })

  it('keeps searches asking after a compaction', () => {
    const c = workedChat()
    recordClaudeCompaction(
      c,
      [{ type: 'compaction', content: 's', encrypted_content: null }] as BetaContentBlock[],
      'claude-opus-5-5'
    )
    c.messages.push({ role: 'user', content: 'Search the web for launch tips' })
    const turn = c.messages.length - 1
    const reasons = searchExposure(c, turn, carriedContext(c).injected)
    expect(reasons).toContain('a summary of earlier messages')
    expect(reasons).toContain('results of tools from earlier in this chat')
  })

  it('keeps searches asking in a continuation, even without a summary', async () => {
    const s = store(workedChat())
    const r = await continueChat(s, 'orig', { withoutSummary: true })
    if (!r.ok) throw new Error()
    const c = r.conversation
    c.messages.push({ role: 'user', content: 'Search the web' })
    expect(searchExposure(c, 0, carriedContext(c).injected)).toEqual([
      'a summary of an earlier chat'
    ])
    // A fresh chat with nothing carried has no reason to ask.
    expect(searchExposure(conv({ messages: [{ role: 'user', content: 'x' }] }), 0, [])).toEqual([])
  })
})
