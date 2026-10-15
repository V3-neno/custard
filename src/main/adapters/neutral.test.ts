import { readdirSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import type {
  BetaContentBlockParam,
  BetaMessageParam
} from '@anthropic-ai/sdk/resources/beta/messages/messages'
import type { ResponseInputItem, ResponseOutputItem } from 'openai/resources/responses/responses'
import type { Conversation } from '../../shared/chat'
import type { AssistantMessage, Message, Writer } from '../../shared/neutralChat'
import { user } from '../../../test/neutral/builders'
import { withFiles } from '../attachments/request'
import { claudeHistory, openaiStart } from '../compaction'
import { withoutUnavailableTools } from '../history'
import { toBlocks, toInput } from '../openai'
import { actionKey, MALFORMED_ARGUMENTS, TurnLog } from '../turn'
import { echoableContent } from './anthropic'
import { fromClaudeReply, toClaudeHistory, toClaudeMessage } from './anthropicNeutral'
import { fromResponsesReply, toResponsesInput } from './responsesNeutral'
import { isStoredChat } from '../../shared/neutralChat'
import { legacyToNeutral, NotStoredShape } from '../../../test/neutral/legacy'

// B2, kept after B3: the neutral format's converters must send exactly what
// Custard sent before B3. For every history below, the old path (the stored
// Anthropic messages through withFiles, withoutUnavailableTools and
// claudeHistory or toInput) and the new path (the neutral messages through
// the converter) must give byte-identical `messages` (Claude) and `input`
// (OpenAI, DeepSeek), for every prefix of the history, every model, with and
// without files, and with every tool, no tool or some tools still offered.
// Nothing else in a request body is built from the stored messages.
//
// Since B3 the app stores neutral messages. A history in that format is
// compared through what the old format stored for the same messages:
// toClaudeMessage of each, which is exactly what TurnLog and the adapters
// wrote before B3 (checked below for every message the app writes).

const CLAUDE = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5']
const RESPONSES = [
  { provider: 'openai' as const, model: 'gpt-6-astra' },
  { provider: 'deepseek' as const, model: 'deepseek-flash' }
]

// Files as prepareFiles builds them: an image, a PDF, a text file and the
// note for a file that can't go.
const IMAGE: BetaContentBlockParam = {
  type: 'image',
  source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' }
}
const PDF: BetaContentBlockParam = {
  type: 'document',
  source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0xLjQ=' },
  title: 'plan.pdf'
}
const TEXT_FILE: BetaContentBlockParam = {
  type: 'document',
  source: { type: 'text', media_type: 'text/plain', data: 'line one\nline two' },
  title: 'notes.txt',
  context: 'Content of a file the user attached.'
}
const NOTE: BetaContentBlockParam = {
  type: 'text',
  text: '[Attached file "old.png" (image): Custard\'s copy is missing or changed, so it is no longer included.]'
}

type Files = Map<number, BetaContentBlockParam[]>

const typedAt = (h: BetaMessageParam[]): number[] =>
  h.flatMap((m, i) => (m.role === 'user' && typeof m.content === 'string' ? [i] : []))

function fileVariants(h: BetaMessageParam[]): [string, Files][] {
  const typed = typedAt(h)
  if (!typed.length) return [['no files', new Map()]]
  return [
    ['no files', new Map()],
    ['files on every typed message', new Map(typed.map((i) => [i, [IMAGE, PDF, TEXT_FILE]]))],
    ['a missing file', new Map([[typed[0], [NOTE]]])],
    ['a text file only', new Map([[typed[typed.length - 1], [TEXT_FILE]]])]
  ]
}

function toolNames(h: BetaMessageParam[]): string[] {
  const names = new Set<string>()
  for (const m of h)
    if (typeof m.content !== 'string')
      for (const b of m.content) if (b.type === 'tool_use') names.add(b.name)
  return [...names]
}

function availableVariants(h: BetaMessageParam[]): [string, Set<string>][] {
  const names = toolNames(h)
  return [
    ['every tool offered', new Set(names)],
    ['no tool offered', new Set()],
    ['some tools offered', new Set(names.filter((_, i) => i % 2 === 0))]
  ]
}

const todayClaude = (
  h: BetaMessageParam[],
  model: string,
  files: Files,
  available: Set<string>
): BetaMessageParam[] =>
  claudeHistory(withoutUnavailableTools(withFiles(h, files), available), model)

function todayResponses(
  h: BetaMessageParam[],
  files: Files,
  available: Set<string>,
  start: { item: ResponseInputItem | null; from: number }
): ResponseInputItem[] {
  const history = withoutUnavailableTools(withFiles(h, files), available)
  return [...(start.item ? [start.item] : []), ...toInput(history.slice(start.from))]
}

function newResponses(
  n: Message[],
  files: Files,
  available: Set<string>,
  start: { item: ResponseInputItem | null; from: number }
): ResponseInputItem[] {
  return [
    ...(start.item ? [start.item] : []),
    ...toResponsesInput(n, { files, available, from: start.from })
  ]
}

type Tally = { histories: number; requests: number; mismatches: string[] }

// A stored history in either format: the old one (Anthropic messages) and
// the neutral one, for the same messages.
const isNeutral = (h: unknown[]): h is Message[] =>
  h.every((m) => Array.isArray((m as { parts?: unknown }).parts))
const legacyOf = (n: Message[]): BetaMessageParam[] => n.map(toClaudeMessage)

// Every prefix, model, file and tool variant of one stored history.
function compareAll(
  name: string,
  stored: BetaMessageParam[] | Message[],
  tally: Tally,
  opts: { by?: (i: number) => Writer | undefined; compactions?: Conversation['compactions'] } = {}
): void {
  tally.histories++
  const h = isNeutral(stored) ? legacyOf(stored) : stored
  const neutral = isNeutral(stored) ? stored : legacyToNeutral(stored, opts.by)
  for (let len = 1; len <= h.length; len++) {
    const stored = h.slice(0, len)
    const n = neutral.slice(0, len)
    for (const [fl, files] of fileVariants(stored))
      for (const [al, available] of availableVariants(stored)) {
        for (const model of CLAUDE) {
          tally.requests++
          const a = JSON.stringify(todayClaude(stored, model, files, available))
          const b = JSON.stringify(toClaudeHistory(n, { model, files, available }))
          if (a !== b) tally.mismatches.push(`${name} [${len}] ${model}, ${fl}, ${al}`)
        }
        for (const { provider, model } of RESPONSES) {
          const c = { messages: n, compactions: opts.compactions } as Conversation
          const starts = [{ item: null, from: 0 }, openaiStart(c, model)]
          for (const start of starts) {
            tally.requests++
            const a = JSON.stringify(todayResponses(stored, files, available, start))
            const b = JSON.stringify(newResponses(n, files, available, start))
            if (a !== b) tally.mismatches.push(`${name} [${len}] ${provider}, ${fl}, ${al}`)
          }
        }
      }
  }
}

// Decision 2: where both apply, rebuilding from `raw` for its own provider
// and rebuilding from `parts` agree. `parts` are exactly what the raw blocks
// say, and the text and tool calls in `raw` are the ones `parts` send.
function consistent(m: Message): string | null {
  if (m.role !== 'assistant' || !m.raw) return null
  if (m.raw.provider !== 'claude') return 'raw from a provider other than Claude'
  const again = fromClaudeReply(m.raw.blocks as BetaContentBlockParam[], m.raw.model)
  if (JSON.stringify(again.parts) !== JSON.stringify(m.parts)) return 'parts differ from raw'
  const core = (m.raw.blocks as { type: string; [k: string]: unknown }[]).flatMap((b): unknown[] =>
    b.type === 'text'
      ? [{ type: 'text', text: b.text }]
      : b.type === 'tool_use'
        ? [{ type: 'tool_use', id: b.id, name: b.name, input: b.input }]
        : []
  )
  const fromParts = toClaudeMessage({ ...m, raw: undefined }).content
  if (JSON.stringify(core) !== JSON.stringify(fromParts)) return 'text or calls differ'
  return null
}

// Messages without `raw` rebuild exactly what is stored today.
function rebuildsStored(stored: BetaMessageParam, m: Message): boolean {
  return JSON.stringify(toClaudeMessage(m)) === JSON.stringify(stored)
}

const GOLDENS = join(__dirname, '../../../test/e2e')

describe('the goldens: every stored chat they record', () => {
  const files = [
    ['claude-turn.golden.json', 'claude-opus-5-5'],
    ['claude-turn-claude-sonnet-5-5.golden.json', 'claude-sonnet-5-5'],
    ['claude-turn-claude-haiku-4-5.golden.json', 'claude-haiku-4-5'],
    ['responses-turn.golden.json', null]
  ] as const
  for (const [file, model] of files)
    it(`${file}: identical requests and consistent messages`, () => {
      const g = JSON.parse(readFileSync(join(GOLDENS, file), 'utf8')) as Record<
        string,
        { chat: { messages: BetaMessageParam[] | Message[] } | null }
      >
      const tally: Tally = { histories: 0, requests: 0, mismatches: [] }
      for (const [k, v] of Object.entries(g)) {
        if (!v.chat) continue
        const writer: Writer = model
          ? { provider: 'claude', model }
          : {
              provider: k.startsWith('deepseek') ? 'deepseek' : 'openai',
              model: k.startsWith('deepseek') ? 'deepseek-flash' : 'gpt-6-astra'
            }
        const stored = v.chat.messages
        compareAll(`${file} ${k}`, stored, tally, { by: () => writer })
        const n = isNeutral(stored) ? stored : legacyToNeutral(stored, () => writer)
        const h = isNeutral(stored) ? legacyOf(stored) : stored
        for (const [i, m] of n.entries()) {
          expect(consistent(m), `${k} [${i}]`).toBeNull()
          if (m.role === 'assistant' && !m.raw) expect(rebuildsStored(h[i], m)).toBe(true)
          if (!model && m.role === 'assistant') expect(m.raw).toBeUndefined()
        }
      }
      console.log(`${file}: ${tally.histories} histories, ${tally.requests} requests compared`)
      expect(tally.mismatches).toEqual([])
      expect(tally.histories).toBeGreaterThan(0)
    })
})

describe('the unit tests: every history they send or store', () => {
  // Captured from the whole unit suite (see test/neutral/capture.setup.ts),
  // including longchat.test and the adapter tests. Strings over 4 KB (file
  // data) were shortened when captured; both paths get the same strings.
  type Captured = {
    from: string[]
    at: string
    messages: BetaMessageParam[]
    files?: [number, BetaContentBlockParam[]][]
    available?: string[]
    model?: string
  }
  const all = JSON.parse(
    readFileSync(join(__dirname, '../../../test/neutral/unit-histories.json'), 'utf8')
  ) as Captured[]

  it('covers longchat.test and the adapter tests', () => {
    const files = new Set(all.flatMap((c) => c.from.map((f) => f.split(' ')[0])))
    for (const f of [
      'src/main/longchat.test.ts',
      'src/main/openai.test.ts',
      'src/main/adapters/oneShot.test.ts',
      'src/main/history.test.ts',
      'src/main/turn.test.ts',
      'src/main/attachments/request.test.ts'
    ])
      expect(files).toContain(f)
  })

  it('sends identical requests for every history in a shape Custard stores', () => {
    const tally: Tally = { histories: 0, requests: 0, mismatches: [] }
    const skipped: string[] = []
    for (const c of all) {
      try {
        compareAll(c.from[0], c.messages, tally)
        // The files and tools that test itself used.
        if (c.files || c.available) {
          const files = new Map(c.files ?? [])
          const available = new Set(c.available ?? toolNames(c.messages))
          const n = legacyToNeutral(c.messages)
          for (const model of CLAUDE)
            if (
              JSON.stringify(todayClaude(c.messages, model, files, available)) !==
              JSON.stringify(toClaudeHistory(n, { model, files, available }))
            )
              tally.mismatches.push(`${c.from[0]} (its own files/tools) ${model}`)
          const start = { item: null, from: 0 }
          if (
            JSON.stringify(todayResponses(c.messages, files, available, start)) !==
            JSON.stringify(newResponses(n, files, available, start))
          )
            tally.mismatches.push(`${c.from[0]} (its own files/tools) responses`)
        }
      } catch (err) {
        if (!(err instanceof NotStoredShape)) throw err
        skipped.push(`${c.from.join(' | ')}: ${err.message}`)
      }
    }
    expect(tally.mismatches).toEqual([])
    // Histories the tests write in shapes Custard never stores (listed in the
    // B2 review). Each is also checked with the one difference made as
    // TurnLog writes it, below.
    const reasons = skipped.map((x) => x.replace(/^.*: message \d+: /, ''))
    expect(new Set(reasons)).toEqual(
      new Set(['tool_result not as TurnLog writes it', 'user block text at 0'])
    )
    console.log(
      `unit histories: ${tally.histories} compared (${tally.requests} requests), ${skipped.length} not in a stored shape`
    )
    expect(tally.histories).toBeGreaterThan(50)
  }, 120_000)

  it('and the same histories, with tool results written as TurnLog writes them', () => {
    // The only shape the tests use that Custard doesn't store: a tool_result
    // with no is_error. TurnLog always writes is_error.
    const tally: Tally = { histories: 0, requests: 0, mismatches: [] }
    let skipped = 0
    for (const c of all) {
      const fixed = c.messages.map((m) =>
        typeof m.content === 'string'
          ? m
          : {
              ...m,
              content: m.content.map((b) =>
                b.type === 'tool_result' && b.is_error === undefined
                  ? {
                      type: b.type,
                      tool_use_id: b.tool_use_id,
                      content: b.content,
                      is_error: false
                    }
                  : b
              )
            }
      ) as BetaMessageParam[]
      try {
        compareAll(c.from[0], fixed, tally)
      } catch (err) {
        if (!(err instanceof NotStoredShape)) throw err
        // Only the request.test histories that already have their files in
        // front (toInput called on them directly) are left.
        expect(err.message).toMatch(/user block text at 0/)
        skipped++
      }
    }
    console.log(
      `with is_error added: ${tally.histories} compared (${tally.requests} requests), ${skipped} not in a stored shape`
    )
    expect(tally.mismatches).toEqual([])
  }, 120_000)
})

// The cases the brief names, each built with the code that writes them
// (TurnLog, the adapters' converters). Each history is compared through what
// the old code stored for the same messages: legacyOf (toClaudeMessage of
// each), which must turn back into the same neutral messages through the B2
// legacy converter, and which for each reply is what the old writer stored.
describe('named cases', () => {
  const conv = (): Conversation => ({
    format: 'custard-chat',
    version: 1,
    id: 'c',
    mode: 'chat',
    title: 't',
    createdAt: 0,
    updatedAt: 0,
    messages: []
  })
  const claudeReply = (blocks: unknown[]): BetaContentBlockParam[] =>
    echoableContent(blocks as never)
  const OPUS: Writer = { provider: 'claude', model: 'claude-opus-5-5' }
  const OPENAI: Writer = { provider: 'openai', model: 'gpt-6-astra' }
  const DEEPSEEK: Writer = { provider: 'deepseek', model: 'deepseek-flash' }

  // A Claude reply as the Claude adapter stores it, checked against what the
  // old adapter stored (the echoable blocks themselves).
  const fromClaude = (blocks: unknown[], w: Writer = OPUS): AssistantMessage => {
    const old = claudeReply(blocks)
    const m = fromClaudeReply(old, w.model)
    expect(toClaudeMessage(m)).toEqual({ role: 'assistant', content: old })
    return m
  }
  // A Responses reply as the Responses adapter stores it, checked against
  // what the old adapter stored (toBlocks of the same output).
  const fromResponses = (output: unknown[], w: Writer): AssistantMessage => {
    const items = output as ResponseOutputItem[]
    const m = fromResponsesReply(items, w.provider, w.model)
    expect(toClaudeMessage(m)).toEqual({ role: 'assistant', content: toBlocks(items) })
    return m
  }

  async function toolRound(
    c: Conversation,
    id: string,
    name: string,
    out: string,
    err = false
  ): Promise<void> {
    const log = new TurnLog(c, () => undefined)
    await log.runRound(
      [{ id, name, input: { path: 'Notes.md' }, label: name, write: false }],
      async () => ({ content: out, isError: err }),
      new AbortController().signal
    )
  }

  const cases: Record<string, () => Promise<Message[]>> = {
    'plain chat': async () => [user('Hi'), fromClaude([{ type: 'text', text: 'Hello.' }])],
    'plain chat, text with fields the API adds': async () => [
      user('Hi'),
      fromClaude([{ type: 'text', text: 'Hello.', citations: null }])
    ],
    'tool chat': async () => {
      const c = conv()
      c.messages.push(user('Read my notes'))
      c.messages.push(
        fromClaude([
          { type: 'text', text: 'Reading.' },
          { type: 'tool_use', id: 'toolu_1', name: 'vault_read', input: { path: 'Notes.md' } }
        ])
      )
      await toolRound(c, 'toolu_1', 'vault_read', 'note text')
      c.messages.push(fromClaude([{ type: 'text', text: 'Done.' }]))
      return c.messages
    },
    'thinking and redacted thinking': async () => [
      user('Think'),
      fromClaude([
        { type: 'thinking', thinking: 'Let me see.', signature: 'sig1' },
        { type: 'redacted_thinking', data: 'ENCRYPTED' },
        { type: 'text', text: 'Answer.' }
      ]),
      user('Again')
    ],
    compaction: async () => [
      user('one'),
      fromClaude([
        { type: 'compaction', content: 'Summary so far.', encrypted_content: null },
        { type: 'text', text: 'two' }
      ]),
      user('three')
    ],
    // What the declining model produced before the marker is dropped by
    // echoableContent, as before.
    fallback: async () => [
      user('Risky'),
      fromClaude([
        { type: 'thinking', thinking: 'declined', signature: 's0' },
        { type: 'tool_use', id: 'toolu_x', name: 'vault_list', input: {} },
        {
          type: 'fallback',
          from: { model: 'claude-opus-5-5' },
          to: { model: 'claude-sonnet-5-5' },
          trigger: { type: 'refusal' }
        },
        { type: 'thinking', thinking: 'fine', signature: 's1' },
        { type: 'text', text: 'Here.' }
      ]),
      user('Thanks')
    ],
    'partial reply and a stopped round': async () => {
      const c = conv()
      const log = new TurnLog(c, () => undefined, OPUS)
      c.messages.push(user('Go'))
      log.addAssistant(
        fromClaude([{ type: 'tool_use', id: 'toolu_2', name: 'mail__send', input: { to: 'a' } }])
      )
      c.actions = {
        toolu_2: {
          name: 'mail__send',
          label: 'Send',
          write: true,
          status: 'pending',
          key: actionKey('mail__send', { to: 'a' })
        }
      }
      log.adoptOpenRound([
        { id: 'toolu_2', name: 'mail__send', input: { to: 'a' }, label: 'Send', write: true }
      ])
      log.text('I was say')
      log.interrupt('stopped', 'Stopped by you.')
      c.messages.push(user('Carry on'))
      return c.messages
    },
    'OpenAI refusal stored as text, and malformed arguments': async () => {
      const refusal = fromResponses(
        [
          {
            type: 'message',
            id: 'm1',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'refusal', refusal: "I can't help with that." }]
          }
        ],
        OPENAI
      )
      const bad = fromResponses(
        [
          {
            type: 'function_call',
            id: 'fc1',
            call_id: 'call_1',
            name: 'vault_read',
            arguments: '{"path": "Notes.md"'
          }
        ],
        OPENAI
      )
      expect(JSON.stringify(bad)).toContain(MALFORMED_ARGUMENTS)
      const c = conv()
      c.messages.push(user('Do it'), refusal, user('Read it'), bad)
      await toolRound(c, 'call_1', 'vault_read', 'Not run: arguments were not valid JSON', true)
      return c.messages
    },
    'round trip Claude, DeepSeek, OpenAI, Claude': async () => {
      const c = conv()
      const call = (id: string, name: string, input: unknown): unknown => ({
        type: 'function_call',
        id: `fc_${id}`,
        call_id: id,
        name,
        arguments: JSON.stringify(input)
      })
      const text = (t: string): unknown => ({
        type: 'message',
        id: 'm',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: t, annotations: [] }]
      })
      c.messages.push(user('round trip one'))
      c.messages.push(
        fromClaude([
          { type: 'thinking', thinking: 'Claude thinks.', signature: 'sig' },
          { type: 'tool_use', id: 'toolu_list', name: 'vault_list', input: {} }
        ])
      )
      await toolRound(c, 'toolu_list', 'vault_list', 'a.md')
      c.messages.push(
        fromClaude([
          { type: 'compaction', content: 'Claude summary so far.', encrypted_content: null },
          { type: 'text', text: 'Claude found it.' }
        ])
      )
      c.messages.push(user('round trip two'))
      c.messages.push(fromResponses([call('call_ds1', 'vault_list', {})], DEEPSEEK))
      await toolRound(c, 'call_ds1', 'vault_list', 'a.md')
      c.messages.push(fromResponses([text('DeepSeek found it.')], DEEPSEEK))
      c.messages.push(user('round trip three'))
      c.messages.push(fromResponses([call('call_oa1', 'web_search', { q: 'x' })], OPENAI))
      await toolRound(c, 'call_oa1', 'web_search', 'results')
      c.messages.push(fromResponses([text('OpenAI found it.')], OPENAI))
      c.messages.push(user('round trip four'))
      return c.messages
    }
  }

  const byOf =
    (n: Message[]) =>
    (i: number): Writer | undefined =>
      n[i].role === 'assistant' ? (n[i] as AssistantMessage).by : undefined

  for (const [name, build] of Object.entries(cases))
    it(name, async () => {
      const n = await build()
      // What the old code stored for these messages reads back as them.
      expect(legacyToNeutral(legacyOf(n), byOf(n))).toEqual(n)
      const tally: Tally = { histories: 0, requests: 0, mismatches: [] }
      compareAll(name, n, tally)
      console.log(`named case ${name}: ${tally.requests} requests compared`)
      expect(tally.mismatches).toEqual([])
      for (const m of n) expect(consistent(m)).toBeNull()
    })

  it('the cut-off reply says which model wrote it', async () => {
    const n = await cases['partial reply and a stopped round']()
    expect(n.find((m) => m.role === 'assistant' && m.partial)).toMatchObject({ by: OPUS })
  })

  it('raw goes back to its own provider; only the parts go to another', async () => {
    const n = await cases['round trip Claude, DeepSeek, OpenAI, Claude']()
    const available = new Set(['vault_list', 'web_search'])
    const claude = JSON.stringify(toClaudeHistory(n, { model: 'claude-opus-5-5', available }))
    const openai = JSON.stringify(toResponsesInput(n, { available }))
    // Claude gets its thinking and compaction back, with the signature.
    expect(claude).toContain('"signature":"sig"')
    expect(claude).toContain('"type":"compaction"')
    // OpenAI gets neither, but every call, Claude's and DeepSeek's included.
    expect(openai).not.toContain('Claude thinks.')
    expect(openai).not.toContain('Claude summary so far.')
    for (const id of ['toolu_list', 'call_ds1', 'call_oa1']) expect(openai).toContain(id)
    // DeepSeek's and OpenAI's replies have nothing only they can read.
    for (const m of n)
      if (m.role === 'assistant' && m.by?.provider !== 'claude') expect(m.raw).toBeUndefined()
    // A Claude reply with thinking keeps raw; a plain Claude text reply doesn't.
    expect((n[1] as { raw?: unknown }).raw).toBeDefined()
    const plain = fromClaudeReply([{ type: 'text', text: 'hi' }], 'claude-opus-5-5')
    expect(plain.raw).toBeUndefined()
  })

  it('the messages before a refused compaction item: the same as the old slice', async () => {
    // openai.ts: when the model turns compaction down, the messages the item
    // stood for are sent instead (toResponsesInput with `to`).
    const n = await cases['round trip Claude, DeepSeek, OpenAI, Claude']()
    const available = new Set(['vault_list'])
    const files = new Map([[0, [TEXT_FILE]]])
    for (let to = 0; to <= n.length; to++) {
      const old = toInput(
        withoutUnavailableTools(withFiles(legacyOf(n), files), available).slice(0, to)
      )
      expect(toResponsesInput(n, { files, available, to })).toEqual(old)
    }
  })

  it('a reply converts the same way the stored blocks do', () => {
    const output = [
      {
        type: 'message',
        id: 'm',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'Hi', annotations: [] }]
      },
      { type: 'function_call', id: 'f', call_id: 'call_9', name: 'vault_list', arguments: '{}' },
      { type: 'reasoning', id: 'r', summary: [], encrypted_content: 'E' }
    ] as unknown as ResponseOutputItem[]
    const neutral = fromResponsesReply(output, 'openai', 'gpt-6-astra')
    expect(neutral).toEqual({
      role: 'assistant',
      by: { provider: 'openai', model: 'gpt-6-astra' },
      parts: [
        { type: 'text', text: 'Hi' },
        { type: 'tool_call', id: 'call_9', name: 'vault_list', input: {} }
      ]
    })
    expect(
      legacyToNeutral([{ role: 'assistant', content: toBlocks(output) }], () => ({
        provider: 'openai',
        model: 'gpt-6-astra'
      }))[0]
    ).toEqual(neutral)
  })
})

// Optional: every stored chat and every request body from an e2e run (run
// the e2e suites first, then NEUTRAL_E2E_DIR=<the run's out dir>). Not part
// of the normal suite, because the files are not in the repository.
const E2E = process.env.NEUTRAL_E2E_DIR
type E2EChat = Omit<Conversation, 'messages' | 'format'> & {
  format?: string
  messages: BetaMessageParam[] | Message[]
}
describe.runIf(!!E2E)('an e2e run: every stored chat and every request it sent', () => {
  const dir = E2E as string
  const suites = E2E ? readdirSync(dir).filter((s) => existsSync(join(dir, s, 'run.log'))) : []
  // Each suite's app data folders (cfg-*/custard/conversations).
  const chatsOf = (suite: string): E2EChat[] => {
    const found: string[] = []
    const walk = (d: string, depth: number): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (!e.isDirectory()) continue
        const p = join(d, e.name)
        if (e.name === 'conversations') found.push(p)
        else if (depth < 3 && (depth > 0 || e.name.startsWith('cfg'))) walk(p, depth + 1)
      }
    }
    walk(join(dir, suite), 0)
    return found.flatMap((conv) =>
      readdirSync(conv)
        .filter((f) => f.endsWith('.json'))
        .flatMap((f): E2EChat[] => {
          try {
            return [JSON.parse(readFileSync(join(conv, f), 'utf8'))]
          } catch {
            // A file old-chats.mjs left unreadable on purpose.
            return []
          }
        })
        // An old chat a suite wrote on purpose (old-chat checks) is never sent.
        .filter((c) => Array.isArray(c.messages) && (isStoredChat(c) || !c.format))
    )
  }
  // A run from before B3 stores Anthropic messages; one from B3 on, neutral.
  const both = (c: E2EChat): { h: BetaMessageParam[]; n: Message[] } =>
    isNeutral(c.messages)
      ? { h: legacyOf(c.messages), n: c.messages }
      : { h: c.messages, n: legacyToNeutral(c.messages) }

  it('every stored chat sends identical requests', () => {
    const tally: Tally = { histories: 0, requests: 0, mismatches: [] }
    const skipped: string[] = []
    for (const s of suites)
      for (const c of chatsOf(s))
        try {
          compareAll(`${s}/${c.id}`, c.messages, tally, { compactions: c.compactions })
          for (const [i, m] of both(c).n.entries())
            if (consistent(m)) tally.mismatches.push(`${s}/${c.id} [${i}] ${consistent(m)}`)
        } catch (err) {
          if (!(err instanceof NotStoredShape)) throw err
          skipped.push(`${s}/${c.id}: ${err.message}`)
        }
    console.log(
      `e2e chats: ${tally.histories} histories, ${tally.requests} requests compared, ${skipped.length} not in a stored shape`,
      skipped
    )
    expect(tally.mismatches).toEqual([])
    expect(tally.histories).toBeGreaterThan(50)
  }, 600_000)

  it('every logged request body is rebuilt byte for byte from the stored chat', () => {
    let matched = 0
    let compared = 0
    const unmatched: string[] = []
    const bad: string[] = []
    for (const s of suites) {
      const file = join(dir, s, 'requests.json')
      if (!existsSync(file)) continue
      const seen = JSON.parse(readFileSync(file, 'utf8')) as { body: Record<string, unknown> }[]
      const chats = chatsOf(s)
      for (const [k, { body }] of seen.entries()) {
        compared++
        const available = new Set(
          ((body.tools as { name?: string }[]) ?? []).map((t) => t.name ?? '')
        )
        const model = body.model as string
        const isClaude = Array.isArray(body.messages)
        if (!isClaude && !Array.isArray(body.input)) continue
        const sent = JSON.stringify(isClaude ? body.messages : body.input)
        let found = false
        for (const c of chats) {
          let all: { h: BetaMessageParam[]; n: Message[] }
          try {
            all = both(c)
          } catch (err) {
            if (err instanceof NotStoredShape) continue
            throw err
          }
          for (let len = 1; len <= all.h.length && !found; len++) {
            const stored = all.h.slice(0, len)
            const n = all.n.slice(0, len)
            if (isClaude) {
              if (JSON.stringify(todayClaude(stored, model, new Map(), available)) !== sent)
                continue
              found = true
              if (JSON.stringify(toClaudeHistory(n, { model, available })) !== sent)
                bad.push(`${s} request ${k}`)
            } else {
              const start = openaiStart({ ...c, messages: n } as Conversation, model)
              if (JSON.stringify(todayResponses(stored, new Map(), available, start)) !== sent)
                continue
              found = true
              if (JSON.stringify(newResponses(n, new Map(), available, start)) !== sent)
                bad.push(`${s} request ${k}`)
            }
          }
          if (found) break
        }
        // A Responses request after the first step of a turn carries that
        // turn's own output items (reasoning, messages with ids), which are
        // never stored, so it can't be rebuilt from a stored chat.
        const inTurn =
          !isClaude &&
          (body.input as { type?: string; id?: string }[]).some(
            (x) => x.type === 'reasoning' || (x.type === 'message' && !!x.id) || !!x.id
          )
        if (found) matched++
        else
          unmatched.push(
            `${s} request ${k} (${isClaude ? 'claude' : inTurn ? 'responses, within a turn' : 'responses'})`
          )
      }
    }
    console.log(`logged requests: ${compared}, rebuilt and matched: ${matched}`, unmatched)
    expect(bad).toEqual([])
    expect(matched).toBeGreaterThan(0)
  }, 600_000)
})
