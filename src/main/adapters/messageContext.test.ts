import { describe, expect, it } from 'vitest'
import type { BetaContentBlockParam } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import type { MessageContext } from '../../shared/chat'
import type { Message } from '../../shared/neutralChat'
import { withFiles } from '../attachments/request'
import { claudeHistory } from '../compaction'
import { withoutUnavailableTools } from '../history'
import { toInput } from '../openai'
import { contextByMessage, withMessageContext } from '../promptCache'
import { toClaudeHistory, toClaudeMessage } from './anthropicNeutral'
import { toResponsesInput } from './responsesNeutral'

// Plugin context on earlier messages (token efficiency phase 1) with chats
// stored in Custard's format (B3): the adapters must send what the
// token-efficiency branch sent from the Claude-shaped history, where the
// context went in front of a message after its files were added and calls
// to tools not offered were turned into text.

const IMAGE: BetaContentBlockParam = {
  type: 'image',
  source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' }
}
const TEXT_FILE: BetaContentBlockParam = {
  type: 'document',
  source: { type: 'text', media_type: 'text/plain', data: 'line one' },
  title: 'notes.txt'
}

const history: Message[] = [
  { role: 'user', parts: [{ type: 'text', text: 'play something' }] },
  {
    role: 'assistant',
    parts: [
      { type: 'text', text: 'Searching.' },
      { type: 'tool_call', id: 'a', name: 'spotify_search', input: { q: 'x' } }
    ],
    by: { provider: 'claude', model: 'claude-opus-5-5' }
  },
  {
    role: 'user',
    parts: [{ type: 'tool_result', callId: 'a', text: 'found 3', isError: false }]
  },
  {
    role: 'assistant',
    parts: [{ type: 'text', text: 'Here they are.' }],
    by: { provider: 'claude', model: 'claude-opus-5-5' }
  },
  // A message with nothing typed (files only).
  { role: 'user', parts: [{ type: 'text', text: '' }] },
  {
    role: 'assistant',
    parts: [{ type: 'text', text: 'Got the file.' }],
    by: { provider: 'openai', model: 'gpt-6-astra' }
  },
  { role: 'user', parts: [{ type: 'text', text: 'and now?' }] }
]

const ctx = (...at: number[]): MessageContext[] =>
  at.map((i) => ({ at: i, plugin: `p${i}`, text: `notes for message ${i}` }))

const contexts: [string, MessageContext[]][] = [
  ['none', []],
  ['on a typed message', ctx(0)],
  ['on tool results', ctx(2)],
  ['on an empty message', ctx(4)],
  ['two on one message, and others', [...ctx(6), ...ctx(6), ...ctx(0, 2, 4)]]
]
const fileSets: [string, Map<number, BetaContentBlockParam[]>][] = [
  ['no files', new Map()],
  ['files', new Map([[4, [IMAGE, TEXT_FILE]]])],
  [
    'files on the first and last',
    new Map([
      [0, [TEXT_FILE]],
      [6, [IMAGE]]
    ])
  ]
]
const availables: [string, Set<string>][] = [
  ['tool offered', new Set(['spotify_search'])],
  ['tool not offered', new Set()]
]

const legacy = history.map(toClaudeMessage)

describe('context on earlier messages, in the stored format', () => {
  for (const [c, context] of contexts)
    for (const [f, files] of fileSets)
      for (const [a, available] of availables) {
        const before = withMessageContext(
          withoutUnavailableTools(withFiles(legacy, files), available),
          context
        )
        it(`Claude: ${c}, ${f}, ${a}`, () => {
          for (const model of ['claude-opus-5-5', 'claude-haiku-4-5'])
            expect(toClaudeHistory(history, { model, files, available, context })).toEqual(
              claudeHistory(before, model)
            )
        })
        it(`Responses: ${c}, ${f}, ${a}`, () => {
          expect(
            toResponsesInput(history, { files, available, context: contextByMessage(context) })
          ).toEqual(toInput(before))
        })
      }
})
