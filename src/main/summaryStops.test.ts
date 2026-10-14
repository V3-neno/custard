import { describe, expect, it, vi } from 'vitest'
import type { OneShotResult } from './adapters/types'

// A one-shot summary that didn't finish (declined, cut off, too long, failed)
// must never be parsed and written as the summary (Phase 8). Both
// summarizers throw, and every caller treats a throw as "no summary".
let reply: Partial<OneShotResult> = {}
vi.mock('./adapters/registry', () => ({
  adapterFor: () => ({
    sendMessage: async (): Promise<OneShotResult> => ({
      text: '',
      calls: [],
      stop: 'done',
      usage: [],
      ...reply
    })
  })
}))
const { summarizer } = await import('./memory/summarize')
const { handoffSummarizer, CHAT_NOTE_SCHEMA } = await import('./handoff')

// Text that would parse as a summary, so only the stop can reject it.
const memoryJson = JSON.stringify({
  save: true,
  decisions: ['Keep it'],
  preferences: [],
  facts: [],
  workflows: [],
  resolutions: [],
  unresolved: []
})
const handoffJson = JSON.stringify({ goal: 'Plan the launch', title: 'Launch plan' })

const callers = [
  ['memory capture', () => summarizer('openai', 'k')('EVIDENCE'), memoryJson],
  ['Continue', () => handoffSummarizer('deepseek', 'k')('EVIDENCE'), handoffJson],
  [
    'chat notes (summary and title)',
    () => handoffSummarizer('claude', 'k', 'notes', undefined, CHAT_NOTE_SCHEMA)('EVIDENCE'),
    handoffJson
  ]
] as const

describe('a summary that did not finish is never returned', () => {
  for (const [name, call, text] of callers) {
    it.each([
      ['refused', 'The summary was declined.'],
      ['cut-off', 'The summary was cut off.'],
      ['too-long', 'The chat was too long to summarize.'],
      ['failed', 'The summary failed: server_error']
    ] as const)(`${name}: %s throws`, async (stop, message) => {
      reply = { stop, text, error: 'server_error' }
      await expect(call()).rejects.toThrow(message)
    })

    it(`${name}: a finished reply is parsed`, async () => {
      reply = { stop: 'done', text }
      await expect(call()).resolves.toBeTruthy()
    })
  }
})
