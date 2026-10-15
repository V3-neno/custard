import { beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Attachment } from '../shared/attachments'
import type { Conversation } from '../shared/chat'
import { textOf, userMessage, type Writer } from '../shared/neutralChat'
import { atMessage, callOutcomes, turnProposals, turnSources } from '../shared/chatLayout'
import { fromClaudeReply } from './adapters/anthropicNeutral'
import { echoableContent } from './adapters/anthropic'
import { claudeFilesFrom } from './attachments/request'
import { ChatNotes } from './chatNotes'
import { openaiStart, recordClaudeCompaction, recordOpenAICompaction } from './compaction'
import { buildEvidence } from './memory/evidence'
import { TurnLog } from './turn'
import { searchExposure, turnHasOutsideContent } from './web/index'
import { runProposeTool } from './workspace/propose'

// B3: every record kept by message index (or by tool call id) still points at
// the right message in the neutral format. Each chat is built by the code
// that writes it (TurnLog, the converters, the record functions), the way
// chat.ts runs a turn, and read by the code that reads it (the window's
// placement in messageItems.ts, and the main process readers).

const OPUS: Writer = { provider: 'claude', model: 'claude-opus-5-5' }

const newChat = (): Conversation => ({
  format: 'custard-chat',
  version: 1,
  id: 'chat-index',
  mode: 'chat',
  title: 'Index test',
  createdAt: 0,
  updatedAt: 0,
  messages: []
})

const reply = (blocks: unknown[]): ReturnType<typeof fromClaudeReply> =>
  fromClaudeReply(echoableContent(blocks as never), OPUS.model)

// One turn as chat.ts runs it: the user's message, a reply calling a tool,
// the round, then the answer. Returns the index of the user's message.
async function toolTurn(
  c: Conversation,
  text: string,
  id: string,
  name: string,
  result: string,
  answer: string
): Promise<number> {
  const log = new TurnLog(c, () => undefined, OPUS)
  const start = log.startLength
  c.messages.push(userMessage(text))
  log.addAssistant(reply([{ type: 'tool_use', id, name, input: { q: text } }]))
  await log.runRound(
    [{ id, name, input: { q: text }, label: name, write: false }],
    async () => ({ content: result, isError: false }),
    new AbortController().signal
  )
  log.addAssistant(reply([{ type: 'text', text: answer }]))
  return start
}

// A turn stopped while the answer was streaming.
function stoppedTurn(c: Conversation, text: string, streamed: string): number {
  const log = new TurnLog(c, () => undefined, OPUS)
  const start = log.startLength
  c.messages.push(userMessage(text))
  log.text(streamed)
  log.interrupt('stopped', 'Stopped by you.')
  return start
}

describe('index fields in the neutral format', () => {
  let c: Conversation
  let first: number
  let second: number
  let third: number

  beforeEach(async () => {
    c = newChat()
    first = await toolTurn(c, 'Find calm music', 'toolu_a', 'web_search', 'results', 'Found it.')
    second = await toolTurn(c, 'Read my note', 'toolu_b', 'vault_read', 'note', 'Read it.')
    third = stoppedTurn(c, 'Say more', 'I was say')
  })

  it('the turns are where the records say: one stored message per step', () => {
    expect([first, second, third]).toEqual([0, 4, 8])
    expect(c.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
      'assistant'
    ])
    expect(textOf(c.messages[9])).toBe('I was say')
  })

  it('notices: after the message they follow, in the window and for memory', () => {
    expect(c.notices).toEqual([{ after: 10, kind: 'stopped', text: 'Stopped by you.' }])
    expect(atMessage(c, 9).notices).toEqual(c.notices)
    for (let i = 0; i < 9; i++) expect(atMessage(c, i).notices).toEqual([])
    // Memory reads the notices inside its range only.
    expect(buildEvidence(c, third, 10).notices).toEqual(['Stopped by you.'])
    expect(buildEvidence(c, 0, third).notices).toEqual([])
  })

  it('sources: by the turn that found them, shown where that turn ends with its answer', () => {
    c.sources = [{ url: 'https://example.com/calm', turn: first, origin: 'search' }]
    const shown = turnSources(c)
    expect([...shown.keys()]).toEqual([3])
    expect(shown.get(3)).toEqual({ sources: c.sources, answer: 'Found it.' })
  })

  it('memory watermark and job range: evidence reads exactly the messages in the range', () => {
    // As capture.ts reads it: from the watermark to the end.
    const e = buildEvidence(c, second, third)
    expect(e.requests).toEqual(['Read my note'])
    expect(e.actions.map((a) => a.tool)).toEqual(['vault_read'])
    expect(e.answer).toBe('Read it.')
    expect(buildEvidence(c, 0, second).requests).toEqual(['Find calm music'])
  })

  it('chatNote.upTo: the note covers the chat up to its stored length', async () => {
    const root = mkdtempSync(join(tmpdir(), 'custard-index-'))
    const vault = join(root, 'vault')
    mkdirSync(vault)
    const chats = new Map([[c.id, c]])
    const seen: string[] = []
    const n = new ChatNotes({
      load: (id) => (chats.get(id) ? JSON.parse(JSON.stringify(chats.get(id))) : null),
      update: (id, change) => {
        const x = chats.get(id)
        if (!x) return null
        change(x)
        return x
      },
      vaultPath: () => vault,
      auto: () => true,
      summarizer: () => async (evidence) => {
        seen.push(evidence)
        return { goal: 'Music', constraints: [], decisions: [], open: [], state: 'Going.' }
      },
      queueFile: join(root, 'queue.json'),
      delayMs: () => 60_000,
      now: () => 0
    })
    try {
      n.afterTurn(c, 'claude')
      await n.runAll()
      expect(c.chatNote).toMatchObject({ status: 'saved', upTo: c.messages.length })
      expect(seen[0]).toContain('Find calm music')
      expect(seen[0]).toContain('Say more')
      // Nothing new: no second note.
      n.afterTurn(c, 'claude')
      await n.runAll()
      expect(seen).toHaveLength(1)
    } finally {
      n.cancelAll()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('compactions.after: Claude and OpenAI records point at the message they precede', () => {
    const blocks = [
      { type: 'compaction', content: 'So far.', encrypted_content: null },
      { type: 'text', text: 'Compacted.' }
    ]
    c.messages.push(userMessage('Go on'))
    expect(recordClaudeCompaction(c, blocks as never, OPUS.model, 1)).toBe(true)
    c.messages.push(reply(blocks))
    const at = c.messages.length - 1
    expect(c.compactions![0].after).toBe(at)
    // The window draws the line before that message; files before it aren't
    // sent to Claude any more.
    expect(atMessage(c, at).compaction).toBe(c.compactions![0])
    expect(claudeFilesFrom(c.messages)).toBe(at)
    // A Responses compaction item: the next request starts at the message it
    // stands before.
    recordOpenAICompaction(
      c,
      { type: 'compaction', id: 'cmp_1', encrypted_content: 'E' } as never,
      'gpt-6-astra',
      'openai',
      2
    )
    expect(openaiStart(c, 'gpt-6-astra')).toEqual({
      item: { type: 'compaction', id: 'cmp_1', encrypted_content: 'E' },
      from: c.messages.length
    })
  })

  it('references: shown with the user message they were sent with', () => {
    c.references = [
      { chat: 'other', title: 'Earlier', mode: 'chat', message: second, text: 'n', outside: false }
    ]
    expect(atMessage(c, second).references).toEqual(c.references)
    expect(atMessage(c, first).references).toEqual([])
  })

  it('proposals: one per turn, shown where the turn ends', () => {
    const r = runProposeTool(
      c,
      { action: 'create', name: 'Calm', request: 'Make a calm plugin' },
      second,
      'plugin',
      []
    )
    expect(r.isError).toBe(false)
    expect(c.proposals![0].turn).toBe(second)
    expect([...turnProposals(c).keys()]).toEqual([7])
    // A second offer in the same turn is refused.
    expect(
      runProposeTool(c, { action: 'create', name: 'X', request: 'y' }, second, 'plugin', []).isError
    ).toBe(true)
  })

  it('attachments: shown with their user message, and seen by memory from that message on', () => {
    const a: Attachment = {
      id: 'f1',
      name: 'plan.pdf',
      kind: 'pdf',
      message: second
    } as Attachment
    c.attachments = [a]
    expect(atMessage(c, second).files).toEqual([a])
    expect(atMessage(c, first).files).toEqual([])
    // Before the message with the file, memory sees no files; from it on, it
    // leaves the answer out.
    expect(buildEvidence(c, 0, second).fileSafe).toBeUndefined()
    expect(buildEvidence(c, second, third).fileSafe).toBe(true)
  })

  it('actions: by tool call id, matched to the stored calls and results', () => {
    expect(Object.keys(c.actions!)).toEqual(['toolu_a', 'toolu_b'])
    expect(c.actions!.toolu_a.status).toBe('completed')
    expect(callOutcomes(c).toolu_b).toMatchObject({ status: 'completed', result: 'note' })
    // A failed result with no record still shows as failed.
    c.messages.push({
      role: 'user',
      parts: [{ type: 'tool_result', callId: 'toolu_gone', text: 'x', isError: true }]
    })
    expect(callOutcomes(c).toolu_gone.status).toBe('failed')
    // The web tools find this turn's and earlier turns' actions by call id.
    expect(turnHasOutsideContent(c, second)).toBe(true)
    expect(searchExposure(c, second, [])).toEqual([
      'results of tools from earlier in this chat',
      'results of tools from this turn'
    ])
  })
})
