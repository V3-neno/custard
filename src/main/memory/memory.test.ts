import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'fs'
import { createHash } from 'crypto'
import { createServer, type Server } from 'http'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ActionStatus, Conversation, Provider } from '../../shared/chat'
import type { MemorySettings } from '../../shared/memory'
import { Capture, QUEUE_LIMIT, type CaptureDeps } from './capture'
import { buildEvidence, eligible, evidenceText, redact } from './evidence'
import { resolveInVault, safeName } from './paths'
import { executionWords, render, validChecks } from './render'
import { parseSummary, summarizer, SUMMARY_SCHEMA, type Summary } from './summarize'
import { captureNotes, chatCaptures, readCaptures, vaultId, writeCapture } from './write'

// --- A chat built the way chat.ts saves one --------------------------------

type Act = { name: string; status: ActionStatus; result?: string; write?: boolean; label?: string }

let seq = 0
function turn(c: Conversation, request: string, acts: Act[] = [], answer = 'Done.'): void {
  c.messages.push({ role: 'user', content: request })
  if (acts.length) {
    const ids = acts.map(() => `tu_${++seq}`)
    c.messages.push({
      role: 'assistant',
      content: acts.map((a, i) => ({
        type: 'tool_use',
        id: ids[i],
        name: a.name,
        input: { secret: 'RAW-INPUT' }
      }))
    })
    c.messages.push({
      role: 'user',
      content: acts.map((a, i) => ({
        type: 'tool_result',
        tool_use_id: ids[i],
        content: a.result ?? ''
      }))
    })
    c.actions ??= {}
    acts.forEach((a, i) => {
      c.actions![ids[i]] = {
        name: a.name,
        label: a.label ?? a.name,
        write: a.write ?? false,
        status: a.status,
        key: ids[i],
        result: a.result
      }
    })
  }
  c.messages.push({ role: 'assistant', content: [{ type: 'text', text: answer }] })
}

const newChat = (id = 'chat-1', title = 'Spotify test'): Conversation => ({
  id,
  mode: 'chat',
  title,
  createdAt: 0,
  updatedAt: 0,
  messages: []
})

const summary = (s: Partial<Summary> = {}): Summary => ({
  save: true,
  preferences: [],
  decisions: [],
  workflows: [],
  resolutions: [],
  unresolved: [],
  ...s
})

// The model claims success but names no check: what a careless summary
// looks like. Code must not write it down as an observation.
const workflow = (w: Partial<Summary['workflows'][number]> = {}): Summary['workflows'][number] => ({
  title: 'Play Discover Weekly',
  request: 'Play my Discover Weekly',
  actions: ['A1'],
  checks: [],
  observed: 'It worked',
  requested: 'seen',
  uncertain: '',
  ...w
})
const pref = (text: string, replaces = ''): Summary['preferences'][number] => ({
  text,
  replaces,
  plugin: ''
})

// --- A test harness around Capture -----------------------------------------

let root: string
let vault: string
let chats: Map<string, Conversation>
let settings: MemorySettings
let calls: string[]
let answer: (evidence: string) => Promise<Summary>
let vaultPath: string | null

function capture(extra: Partial<CaptureDeps> = {}): Capture {
  return new Capture({
    load: (id) => {
      const c = chats.get(id)
      return c ? JSON.parse(JSON.stringify(c)) : null
    },
    update: (id, change) => {
      const c = chats.get(id)
      if (!c) return null
      change(c)
      return c
    },
    vaultPath: () => vaultPath,
    settings: () => settings,
    summarizer: () => async (evidence) => {
      calls.push(evidence)
      return answer(evidence)
    },
    queueFile: join(root, 'queue.json'),
    pluginName: (id) => (id === 'spotify' ? 'Spotify' : id),
    now: () => new Date(2026, 9, 7, 12).getTime(),
    ...extra
  })
}

const hashOf = (job: string): string => createHash('sha256').update(job).digest('hex').slice(0, 8)
const note = (p: string): string => readFileSync(join(vault, p), 'utf8')
// Capture notes, oldest first, and the text of all of them.
const notes = (): string[] => captureNotes(vault).reverse()
const saved = (): string => notes().map(note).join('\n\n')
const job = (id = 'chat-1'): NonNullable<NonNullable<Conversation['memory']>['job']> =>
  chats.get(id)!.memory!.job!

async function captured(
  cap: Capture,
  c: Conversation,
  provider: Provider = 'claude'
): Promise<void> {
  chats.set(c.id, c)
  cap.afterTurn(c, provider)
  await cap.run()
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'custard-mem-'))
  vault = join(root, 'vault')
  mkdirSync(vault)
  vaultPath = vault
  chats = new Map()
  settings = { auto: true, offPlugins: [] }
  calls = []
  answer = async () => summary({ workflows: [workflow()] })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

// --- Evidence ---------------------------------------------------------------

describe('evidence', () => {
  it('leaves out raw tool input and content reads, and redacts secrets', () => {
    const c = newChat()
    turn(c, 'my key is sk-ant-abcdefghijklmnop1234, play jazz', [
      { name: 'vault_read', status: 'completed', result: 'PRIVATE NOTE TEXT' },
      {
        name: 'spotify__play',
        status: 'completed',
        result: 'Playing. token=abc123def',
        write: true
      }
    ])
    const text = evidenceText(buildEvidence(c, 0, c.messages.length))
    expect(text).not.toContain('RAW-INPUT')
    expect(text).not.toContain('PRIVATE NOTE TEXT')
    expect(text).not.toContain('sk-ant-abcdefghijklmnop1234')
    expect(text).not.toContain('abc123def')
    expect(text).toContain(
      'A2: spotify__play [spotify__play, plugin spotify, changes something] → completed: Playing.'
    )
  })

  it('redacts common credential shapes', () => {
    expect(redact('Authorization: Bearer abcdefghijklmnop')).toBe(
      'Authorization: Bearer [redacted]'
    )
    expect(redact('password: hunter22')).toBe('password: [redacted]')
    expect(redact('ghp_1234567890abcdefghij')).toBe('[redacted]')
    expect(redact('x eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4fw')).toBe('x [redacted]')
  })

  it('stays within the size limit, dropping the oldest first', () => {
    const c = newChat()
    for (let i = 0; i < 60; i++)
      turn(c, `request ${i} ${'x '.repeat(200)}`, [
        { name: 'spotify__play', status: 'completed', result: 'ok '.repeat(100), write: true }
      ])
    const text = evidenceText(buildEvidence(c, 0, c.messages.length))
    expect(text.length).toBeLessThanOrEqual(8000)
    expect(text).toContain('request 59')
    expect(text).not.toContain('request 0 ')
  })

  it('is eligible for actions, interruptions and longer chats, not small talk or plain reads', () => {
    const small = newChat()
    turn(small, 'hi')
    turn(small, 'what is 2+2', [{ name: 'web_search', status: 'completed' }])
    expect(eligible(buildEvidence(small, 0, small.messages.length))).toBe(false)
    const acted = newChat()
    turn(acted, 'play', [{ name: 'spotify__play', status: 'completed', write: true }])
    expect(eligible(buildEvidence(acted, 0, acted.messages.length))).toBe(true)
    const stopped = newChat()
    turn(stopped, 'hi')
    stopped.notices = [{ after: 2, kind: 'stopped', text: 'Stopped by you.' }]
    expect(eligible(buildEvidence(stopped, 0, stopped.messages.length))).toBe(true)
    const long = newChat()
    for (let i = 0; i < 10; i++) turn(long, `thought ${i}`)
    expect(eligible(buildEvidence(long, 0, long.messages.length))).toBe(true)
  })

  it('a lasting preference or decision is eligible in one message; small talk is not', () => {
    const one = (text: string): boolean => {
      const c = newChat()
      turn(c, text)
      return eligible(buildEvidence(c, 0, c.messages.length))
    }
    for (const durable of [
      'I prefer short answers',
      'From now on, answer in Swedish',
      "We've decided to use Postgres for Custard",
      "Let's go with the amber theme",
      'My name is Neno',
      "I'd prefer metric units",
      'Remember that I work on Windows'
    ])
      expect(one(durable), durable).toBe(true)
    for (const chat of [
      'hi',
      'how are you?',
      'tell me a joke',
      'thanks!',
      'what time is it in Tokyo'
    ])
      expect(one(chat), chat).toBe(false)
  })

  it("labels the assistant's answer as its own words, not evidence", () => {
    const c = newChat()
    turn(c, 'play', [{ name: 'spotify__play', status: 'completed', write: true }], 'It is playing!')
    expect(evidenceText(buildEvidence(c, 0, c.messages.length))).toContain(
      "Assistant's last answer (its own words; not evidence of what happened):\nIt is playing!"
    )
  })
})

// --- Summary and rendering -------------------------------------------------

describe('summary', () => {
  it('uses only schema features both providers accept', () => {
    const walk = (s: unknown): void => {
      if (!s || typeof s !== 'object') return
      const o = s as Record<string, unknown>
      for (const k of ['minLength', 'maxLength', 'maxItems', 'minimum', 'maximum', 'pattern'])
        expect(o[k]).toBeUndefined()
      if (o.type === 'object') {
        expect(o.additionalProperties).toBe(false)
        expect(o.required).toEqual(Object.keys(o.properties as object))
      }
      Object.values(o).forEach(walk)
    }
    walk(SUMMARY_SCHEMA)
  })

  it('cuts the answer to size and treats junk as nothing to save', () => {
    expect(() => parseSummary('not json')).toThrow()
    const s = parseSummary(
      JSON.stringify({
        save: true,
        preferences: Array(20).fill({ text: 'x'.repeat(1000), replaces: '' }),
        workflows: [
          { title: 'T', actions: ['A1', 'rm -rf', 'A2'], checks: ['A3', 'x'], requested: 'bogus' }
        ]
      })
    )
    expect(s.preferences).toHaveLength(6)
    expect(s.preferences[0].text).toHaveLength(300)
    expect(s.workflows[0].actions).toEqual(['A1', 'A2'])
    expect(s.workflows[0].checks).toEqual(['A3'])
    expect(s.workflows[0].requested).toBe('unchecked')
    expect(parseSummary(JSON.stringify({ save: true })).save).toBe(false)
  })

  it("execution status comes from Custard's record, never the model", () => {
    expect(executionWords({ status: 'completed', write: true })).toBe(
      'accepted: the tool reported success'
    )
    expect(executionWords({ status: 'completed', write: false })).toBe(
      'ran: the tool returned a result'
    )
    expect(executionWords({ status: 'failed', write: true })).toBe('the tool reported an error')
    expect(executionWords({ status: 'not-run', write: true })).toBe('not run')
    expect(executionWords({ status: 'unknown', write: true })).toMatch(/^outcome unknown/)
  })

  it('only later, read-only, completed, non-content actions count as checks', () => {
    const c = newChat()
    turn(c, 'x', [
      { name: 'spotify__now_playing', status: 'completed', result: 'paused' },
      { name: 'spotify__play', status: 'completed', write: true },
      { name: 'spotify__pause', status: 'completed', write: true },
      { name: 'vault_read', status: 'completed' },
      { name: 'spotify__now_playing', status: 'failed' },
      { name: 'spotify__now_playing', status: 'completed', result: 'playing' }
    ])
    const e = buildEvidence(c, 0, c.messages.length)
    const ids = (checks: string[]): string[] => validChecks(checks, ['A2'], e).map((a) => a.id)
    // A1 is before the action, A3 changes something, A4 is a note read, A5
    // failed; only A6 shows the state afterwards.
    expect(ids(['A1', 'A3', 'A4', 'A5', 'A6', 'A9'])).toEqual(['A6'])
  })

  it("keeps headings and comments out of the model's words", () => {
    const c = newChat()
    turn(c, 'x', [{ name: 'spotify__play', status: 'completed', write: true }])
    const items = render(
      summary({
        workflows: [workflow({ title: '# T <!-- x -->', request: 'a\n### b' })]
      }),
      buildEvidence(c, 0, c.messages.length),
      () => 'Spotify'
    )
    const text = items[0].text
    expect(text).not.toContain('<!--')
    expect(text.split('\n').filter((l) => l.startsWith('#'))).toHaveLength(1)
  })
})

describe('the summarizer call', () => {
  let server: Server
  let bodies: Record<string, unknown>[]
  let reply: unknown
  beforeEach(async () => {
    bodies = []
    server = createServer((req, res) => {
      let data = ''
      req.on('data', (d) => (data += d))
      req.on('end', () => {
        bodies.push(JSON.parse(data))
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(reply))
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  })
  afterEach(() => server.close())
  const url = (): string => `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const json = JSON.stringify(summary({ decisions: ['Use Haiku'] }))

  it('Claude: no tools, structured output, bounded', async () => {
    process.env.ANTHROPIC_BASE_URL = url()
    reply = {
      id: 'm',
      type: 'message',
      role: 'assistant',
      model: 'claude-haiku-4-5',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: json }],
      usage: { input_tokens: 1, output_tokens: 1 }
    }
    const s = await summarizer('claude', 'k')('EVIDENCE')
    delete process.env.ANTHROPIC_BASE_URL
    expect(s.decisions).toEqual(['Use Haiku'])
    const b = bodies[0]
    expect(b.tools).toBeUndefined()
    expect(b.model).toBe('claude-haiku-4-5')
    expect(b.max_tokens).toBe(1500)
    expect(b.messages).toEqual([{ role: 'user', content: 'EVIDENCE' }])
    expect((b.output_config as { format: { type: string } }).format.type).toBe('json_schema')
  })

  it('OpenAI: no tools, structured output, not stored', async () => {
    process.env.OPENAI_BASE_URL = url()
    reply = {
      id: 'r',
      object: 'response',
      status: 'completed',
      model: 'gpt-6-luna',
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: json, annotations: [] }]
        }
      ]
    }
    const s = await summarizer('openai', 'k')('EVIDENCE')
    delete process.env.OPENAI_BASE_URL
    expect(s.decisions).toEqual(['Use Haiku'])
    const b = bodies[0]
    expect(b.tools).toBeUndefined()
    expect(b.model).toBe('gpt-6-luna')
    expect(b.store).toBe(false)
    expect(b.max_output_tokens).toBe(1500)
    expect((b.text as { format: { type: string; strict: boolean } }).format).toMatchObject({
      type: 'json_schema',
      strict: true
    })
  })
})

// --- Files -----------------------------------------------------------------

describe('capture files', () => {
  const key = { job: 'chat-1:0-4', plugin: '' }
  const text = (job = key.job): string =>
    `---\ncustard-capture: ${JSON.stringify(job)}\n---\n\nbody`

  it('never replaces an existing file, even one with the same name', () => {
    mkdirSync(join(vault, 'Custard/Captures'), { recursive: true })
    writeFileSync(join(vault, 'Custard/Captures/2026-10-07 1200 Chat.md'), 'my own note')
    const rel = writeCapture(vault, 'Custard/Captures', '2026-10-07 1200 Chat', text(), key)
    expect(rel).toBe('Custard/Captures/2026-10-07 1200 Chat (2).md')
    expect(note('Custard/Captures/2026-10-07 1200 Chat.md')).toBe('my own note')
  })

  it('a note already holding this capture counts as written and is left as it is', () => {
    const first = writeCapture(vault, 'Custard/Captures', 'n', text(), key)
    writeFileSync(join(vault, first), `${text()}\nedited by the user`)
    expect(writeCapture(vault, 'Custard/Captures', 'n', text(), key)).toBe(first)
    expect(note(first)).toContain('edited by the user')
    expect(captureNotes(vault)).toHaveLength(1)
  })

  it('refuses links that lead out of the vault', () => {
    const outside = join(root, 'outside')
    mkdirSync(outside)
    symlinkSync(outside, join(vault, 'Custard'))
    expect(() => resolveInVault(vault, 'Custard/Captures/x.md')).toThrow(/link/)
  })

  it('never writes a capture through a broken link', () => {
    const outside = join(root, 'outside')
    mkdirSync(outside)
    mkdirSync(join(vault, 'Custard'))
    symlinkSync(join(outside, 'not-yet'), join(vault, 'Custard/Captures'))
    expect(() => writeCapture(vault, 'Custard/Captures', 'n', text(), key)).toThrow(/link/)
    expect(readdirSync(outside)).toEqual([])
  })

  it('makes safe names', () => {
    expect(safeName('a/b:c?', 'x')).toBe('a b c')
    expect(safeName('CON', 'x')).toBe('x')
    expect(safeName('...', 'x')).toBe('x')
  })

  it('reads back the newest notes as they are now, within limits', () => {
    mkdirSync(join(vault, 'Custard/Captures'), { recursive: true })
    for (let i = 0; i < 30; i++)
      writeFileSync(
        join(vault, `Custard/Captures/2026-10-${String(i + 1).padStart(2, '0')} 1200 C${i}.md`),
        `# C${i}\n\n## Preferences\n\n- Pref ${i} ${'x'.repeat(50)}\n\n## Activity\n\n### Did ${i}\n- Asked: y`
      )
    const r = readCaptures(vault)
    expect(r.remembered[0]).toMatch(/^2026-10-30: Pref 29/)
    expect(r.remembered.join('').length).toBeLessThanOrEqual(2000)
    expect(r.remembered.some((l) => l.includes('Pref 9 '))).toBe(false)
    expect(r.activity).toEqual([
      '2026-10-30 · Did 29',
      '2026-10-29 · Did 28',
      '2026-10-28 · Did 27',
      '2026-10-27 · Did 26',
      '2026-10-26 · Did 25'
    ])
    // The user's edit is what comes back.
    writeFileSync(join(vault, 'Custard/Captures/2026-10-30 1200 C29.md'), '# C29\n\nemptied')
    expect(readCaptures(vault).remembered[0]).toMatch(/^2026-10-29: Pref 28/)
  })
})

// --- Capture end to end ----------------------------------------------------

describe('capture', () => {
  it('fresh install: creates one readable note on first capture, without being asked', async () => {
    const c = newChat()
    turn(c, 'Play my Discover Weekly', [
      {
        name: 'spotify__play',
        label: 'Play Discover Weekly',
        status: 'completed',
        result: 'Spotify accepted the request.',
        write: true
      }
    ])
    answer = async () =>
      summary({
        workflows: [workflow()],
        preferences: [pref('Likes Discover Weekly on Mondays')]
      })
    await captured(capture(), c)
    expect(job().status).toBe('saved')
    // Date, time, title and an id from the capture, so names made in the
    // same minute (here or on another device) differ.
    expect(job().notes).toEqual([
      `Custard/Captures/2026-10-07 1200 Spotify test ${hashOf('chat-1:0-4')}.md`
    ])
    expect(job().plan).toBeUndefined()
    const a = note(job().notes![0])
    expect(a).toMatch(
      /^---\ncustard-capture: "chat-1:0-4"\nchat: "chat-1"\ndate: "2026-10-07"\n---/
    )
    expect(a).toContain('# Spotify test')
    expect(a).toContain('Custard writes this note once and never changes it.')
    expect(a).toContain('## Preferences\n\n- Likes Discover Weekly on Mondays')
    expect(a).toContain('### Play Discover Weekly')
    expect(a).toContain('- Plugin: Spotify')
    expect(a).toContain('  - Play Discover Weekly: accepted: the tool reported success')
    // The model said "seen" and "It worked" without naming a check.
    expect(a).toContain('- Checked afterwards: nothing checked it')
    expect(a).toContain('- Requested outcome: not checked: nothing looked afterwards')
    expect(a).not.toContain('It worked')
    expect(existsSync(join(vault, 'Custard/Memory.md'))).toBe(false)
    expect(chats.get('chat-1')!.memory!.watermark).toBe(c.messages.length)
    expect(existsSync(join(vault, 'Custard/.custard-vault-id'))).toBe(true)
  })

  it('accepted, then observed paused: the action is not called failed, and the gap is unknown', async () => {
    const c = newChat()
    turn(c, 'Play jazz', [
      {
        name: 'spotify__play',
        label: 'Play jazz',
        status: 'completed',
        result: 'Accepted',
        write: true
      },
      {
        name: 'spotify__now_playing',
        label: 'Check playback',
        status: 'completed',
        result: 'Nothing playing, paused.'
      }
    ])
    answer = async () =>
      summary({
        workflows: [
          workflow({
            actions: ['A1'],
            checks: ['A2'],
            observed: 'Playback was paused and nothing was playing',
            requested: 'not-seen'
          })
        ]
      })
    await captured(capture(), c)
    const a = saved()
    expect(a).toContain('  - Play jazz: accepted: the tool reported success')
    expect(a).toContain(
      '- Checked afterwards (Check playback): Playback was paused and nothing was playing'
    )
    expect(a).toContain(
      '- Requested outcome: not seen at the later check; whether it happened before then is unknown'
    )
    expect(a).not.toMatch(/fail/i)
  })

  it('declined actions are recorded as not run, unknown ones as unknown', async () => {
    const c = newChat()
    turn(c, 'Skip and queue', [
      {
        name: 'spotify__skip',
        label: 'Skip track',
        status: 'not-run',
        result: 'The user declined.',
        write: true
      },
      { name: 'spotify__queue', label: 'Queue song', status: 'unknown', write: true }
    ])
    answer = async () =>
      summary({
        workflows: [
          workflow({ title: 'Skip', actions: ['A1'] }),
          workflow({ title: 'Queue', actions: ['A2'] })
        ]
      })
    await captured(capture(), c)
    const a = saved()
    expect(a).toMatch(
      /Skip track: not run\n- Checked afterwards: nothing checked it\n- Requested outcome: not attempted/
    )
    expect(a).toMatch(
      /Queue song: outcome unknown: it was sent, but no result came back\n- Checked afterwards: nothing checked it\n- Requested outcome: not checked/
    )
  })

  it('small talk is not captured and no model call is made', async () => {
    const c = newChat()
    for (const t of ['hello', 'how are you?', 'tell me a joke', 'ha, thanks']) turn(c, t)
    const cap = capture()
    chats.set(c.id, c)
    // After every one of the four turns.
    for (let i = 1; i <= 4; i++) {
      cap.afterTurn({ ...c, messages: c.messages.slice(0, i * 2) }, 'claude')
      await cap.run()
    }
    expect(calls).toHaveLength(0)
    expect(chats.get('chat-1')!.memory).toBeUndefined()
  })

  it('a lasting preference in a one-message chat is captured', async () => {
    const c = newChat('chat-1', 'Answers')
    turn(c, 'From now on I prefer short answers', [], 'Got it.')
    answer = async () => summary({ preferences: [pref('Prefers short answers')] })
    await captured(capture(), c)
    expect(calls).toHaveLength(1)
    expect(job().status).toBe('saved')
    expect(saved()).toContain('## Preferences\n\n- Prefers short answers')
  })

  it('eligible but not worth keeping: the summarizer decides, nothing is written', async () => {
    const c = newChat()
    turn(c, 'I like that joke')
    answer = async () => summary({ save: false })
    await captured(capture(), c)
    expect(calls).toHaveLength(1)
    expect(job().status).toBe('skipped')
    expect(job().reason).toBe('Nothing in it needed remembering.')
    expect(notes()).toEqual([])
  })

  it('a duplicate run of the same job writes once', async () => {
    const c = newChat()
    turn(c, 'play', [{ name: 'spotify__play', status: 'completed', write: true }])
    const cap = capture()
    await captured(cap, c)
    const m = chats.get('chat-1')!.memory!
    m.job!.status = 'pending'
    m.watermark = 0
    cap.afterTurn(c, 'claude')
    await cap.run()
    expect(notes()).toHaveLength(1)
  })

  it('retries a failed summary, then gives up as failed', async () => {
    const c = newChat()
    turn(c, 'play', [{ name: 'spotify__play', status: 'completed', write: true }])
    let n = 0
    answer = async () => {
      if (++n < 3) throw new Error('overloaded')
      return summary({ workflows: [workflow()] })
    }
    const cap = capture()
    await captured(cap, c)
    expect(job().status).toBe('pending')
    expect(job().reason).toBe('Will try again: overloaded')
    await cap.run()
    await cap.run()
    expect(job().status).toBe('saved')
    expect(job().attempts).toBe(3)

    const d = newChat('chat-2')
    turn(d, 'play', [{ name: 'spotify__play', status: 'completed', write: true }])
    answer = async () => {
      throw new Error('down')
    }
    await captured(cap, d)
    await cap.run()
    await cap.run()
    expect(job('chat-2').status).toBe('failed')
    expect(job('chat-2').reason).toBe("Couldn't summarize it: down")
    expect(cap.pending()).toEqual([])
  })

  it('a crash after writing, before recording, is recorded as saved without writing again', async () => {
    const c = newChat()
    turn(c, 'play', [{ name: 'spotify__play', status: 'completed', write: true }])
    let plan: unknown
    const first = capture({
      update: (id, change) => {
        const c = chats.get(id)!
        change(c)
        if (c.memory?.job?.plan) plan = c.memory.job.plan
        return c
      }
    })
    await captured(first, c)
    const written = notes()
    // Put the chat back as it was saved just before the note was written:
    // summarized (plan kept), still pending, still queued.
    const m = chats.get('chat-1')!.memory!
    m.job = { ...m.job!, status: 'pending', plan: plan as never, notes: undefined }
    m.watermark = 0
    writeFileSync(join(root, 'queue.json'), JSON.stringify(['chat-1']))
    const restarted = capture()
    await restarted.run()
    expect(calls).toHaveLength(1)
    expect(notes()).toEqual(written)
    expect(job().status).toBe('saved')
    expect(job().notes).toEqual(written)
  })

  it('a crash after summarizing resumes from the saved plan without a new model call', async () => {
    const c = newChat()
    turn(c, 'play', [{ name: 'spotify__play', status: 'completed', write: true }])
    // Make the first write fail once after the plan is stored.
    mkdirSync(join(vault, 'Custard'), { recursive: true })
    writeFileSync(join(vault, 'Custard/Captures'), 'not a folder')
    await captured(capture(), c)
    expect(job().status).toBe('pending')
    expect(job().plan).toHaveLength(1)
    rmSync(join(vault, 'Custard/Captures'))
    const restarted = capture()
    expect(restarted.pending()).toEqual(['chat-1'])
    await restarted.run()
    expect(calls).toHaveLength(1)
    expect(job().status).toBe('saved')
    expect(notes()).toHaveLength(1)
  })

  it('failed writes end as failed after three attempts', async () => {
    const c = newChat()
    turn(c, 'play', [{ name: 'spotify__play', status: 'completed', write: true }])
    mkdirSync(join(vault, 'Custard'), { recursive: true })
    writeFileSync(join(vault, 'Custard/Captures'), 'not a folder')
    const cap = capture()
    await captured(cap, c)
    await cap.run()
    await cap.run()
    expect(job().status).toBe('failed')
    expect(job().reason).toMatch(/^Couldn't write to the vault/)
    expect(calls).toHaveLength(1)
  })

  it('a link out of the vault is refused, not followed', async () => {
    const outside = join(root, 'outside')
    mkdirSync(outside)
    symlinkSync(outside, join(vault, 'Custard'))
    const c = newChat()
    turn(c, 'play', [{ name: 'spotify__play', status: 'completed', write: true }])
    const cap = capture()
    await captured(cap, c)
    await cap.run()
    await cap.run()
    expect(job().status).toBe('failed')
    expect(existsSync(join(outside, 'Captures'))).toBe(false)
  })

  it("never edits a note again: the user's edits and their own notes stay as they are", async () => {
    mkdirSync(join(vault, 'Custard'), { recursive: true })
    writeFileSync(join(vault, 'Custard/Memory.md'), '# Memory\n\nmine\n')
    const c = newChat()
    turn(c, 'play', [{ name: 'spotify__play', status: 'completed', write: true }])
    const cap = capture()
    await captured(cap, c)
    const first = notes()[0]
    const edited = `${note(first)}\n\nI checked: it played.`
    writeFileSync(join(vault, first), edited)
    turn(c, 'pause', [{ name: 'spotify__pause', status: 'completed', write: true }])
    answer = async () => summary({ workflows: [workflow({ title: 'Pause' })] })
    await captured(cap, c)
    expect(note(first)).toBe(edited)
    expect(notes()).toHaveLength(2)
    expect(note(notes().find((n) => n !== first)!)).toContain('### Pause')
    expect(note('Custard/Memory.md')).toBe('# Memory\n\nmine\n')
  })

  it('missing vault: waits, then saves when the same vault is back', async () => {
    const c = newChat()
    turn(c, 'play', [{ name: 'spotify__play', status: 'completed', write: true }])
    vaultId(vault, true)
    const moved = `${vault}-away`
    const { renameSync } = await import('fs')
    renameSync(vault, moved)
    const cap = capture()
    await captured(cap, c)
    expect(job().status).toBe('pending')
    expect(calls).toHaveLength(0)
    renameSync(moved, vault)
    await cap.run()
    expect(job().status).toBe('saved')
  })

  it('never writes into a different vault than it waited for', async () => {
    const c = newChat()
    turn(c, 'play', [{ name: 'spotify__play', status: 'completed', write: true }])
    vaultId(vault, true)
    const other = join(root, 'other')
    mkdirSync(other)
    const { renameSync } = await import('fs')
    renameSync(vault, `${vault}-away`)
    const cap = capture()
    await captured(cap, c)
    vaultPath = other
    await cap.run()
    expect(job().status).toBe('skipped')
    expect(job().reason).toMatch(/different vault/)
    expect(existsSync(join(other, 'Custard/Captures'))).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('no vault connected: skipped, not queued for whatever vault comes later', async () => {
    vaultPath = null
    const c = newChat()
    turn(c, 'play', [{ name: 'spotify__play', status: 'completed', write: true }])
    const cap = capture()
    await captured(cap, c)
    expect(job().status).toBe('skipped')
    expect(cap.pending()).toEqual([])
  })

  it('keeps at most 50 chats waiting', async () => {
    const away = `${vault}-away`
    const { renameSync } = await import('fs')
    renameSync(vault, away)
    const cap = capture()
    for (let i = 0; i <= QUEUE_LIMIT; i++) {
      const c = newChat(`chat-${i}`)
      turn(c, 'play', [{ name: 'spotify__play', status: 'completed', write: true }])
      await captured(cap, c)
    }
    expect(cap.pending()).toHaveLength(QUEUE_LIMIT)
    expect(job('chat-0').status).toBe('skipped')
    expect(JSON.parse(readFileSync(join(root, 'queue.json'), 'utf8'))).toHaveLength(QUEUE_LIMIT)
  })

  it('"Remember automatically" off: no call, nothing written, and earlier turns stay uncaptured', async () => {
    settings.auto = false
    const c = newChat()
    turn(c, 'play', [{ name: 'spotify__play', status: 'completed', write: true }])
    const cap = capture()
    await captured(cap, c)
    expect(job().status).toBe('off')
    expect(calls).toHaveLength(0)
    settings.auto = true
    turn(c, 'pause', [{ name: 'spotify__pause', status: 'completed', write: true }])
    await captured(cap, c)
    expect(calls).toHaveLength(1)
    expect(calls[0]).not.toContain('spotify__play')
    expect(calls[0]).toContain('spotify__pause')
  })

  it('turned off while the model is answering: nothing is written', async () => {
    const c = newChat()
    turn(c, 'play', [{ name: 'spotify__play', status: 'completed', write: true }])
    const cap = capture()
    answer = async () => {
      cap.setChatMemory('chat-1', true)
      return summary({ workflows: [workflow()] })
    }
    await captured(cap, c)
    expect(job().status).toBe('off')
    expect(notes()).toEqual([])
  })

  it('"don\'t remember this" in the chat skips that part without a model call', async () => {
    const c = newChat()
    turn(c, "Play this, and don't remember it", [
      { name: 'spotify__play', status: 'completed', write: true }
    ])
    await captured(capture(), c)
    expect(job().status).toBe('skipped')
    expect(job().reason).toBe(
      `Your message said "and don't remember it", so this part wasn't saved.`
    )
    expect(chats.get('chat-1')!.memory!.off).toBeFalsy()
    expect(calls).toHaveLength(0)
  })

  it('"forget this chat" in the chat stops remembering it and points to Forget', async () => {
    const c = newChat()
    turn(c, 'I prefer jazz. Forget this chat', [])
    await captured(capture(), c)
    expect(job().status).toBe('skipped')
    expect(job().reason).toMatch(
      /stopped remembering this chat\. To delete what it saved earlier, use Forget\.$/
    )
    expect(chats.get('chat-1')!.memory!.off).toBe(true)
    expect(calls).toHaveLength(0)
  })

  it('casual phrases are not requests to forget', () => {
    const asks = (text: string): string | null => {
      const c = newChat()
      turn(c, text)
      return buildEvidence(c, 0, c.messages.length).dontRemember
    }
    for (const casual of [
      'Forget it, play something else',
      "I don't remember that song's name",
      "Don't keep the volume this low",
      'forget that, use Spotify instead',
      'We never save on Fridays',
      'Never record a demo without a click track'
    ])
      expect(asks(casual), casual).toBeNull()
    for (const [explicit, words] of [
      ["Don't remember this.", "Don't remember this"],
      ['please don’t save that', 'please don’t save that'],
      ['Ok. Forget this chat', 'Forget this chat'],
      ['This is off the record', 'off the record'],
      ['keep this out of your memory', 'keep this out of your memory']
    ])
      expect(asks(explicit), explicit).toBe(words)
  })

  it('a resolution goes in a new note; the earlier note is left as written', async () => {
    const c = newChat()
    turn(c, 'play', [
      { name: 'spotify__play', status: 'failed', result: 'No active device', write: true }
    ])
    answer = async () =>
      summary({
        workflows: [workflow({ requested: 'unchecked' })],
        unresolved: ['Spotify has no active device']
      })
    const cap = capture()
    await captured(cap, c)
    const first = notes()[0]
    const before = note(first)
    expect(before).toContain('## Still open\n\n- Spotify has no active device')
    expect(before).toContain('the tool reported an error')
    turn(c, 'try again', [
      { name: 'spotify__play', status: 'completed', write: true },
      {
        name: 'spotify__now_playing',
        label: 'Check playback',
        status: 'completed',
        result: 'Playing'
      }
    ])
    answer = async () =>
      summary({
        workflows: [
          workflow({ actions: ['A1'], checks: ['A2'], observed: 'Now playing', requested: 'seen' })
        ],
        resolutions: [
          {
            issue: 'Spotify has no active device',
            resolution: 'Opened Spotify on the laptop first'
          }
        ]
      })
    await captured(cap, c)
    expect(note(first)).toBe(before)
    const second = note(notes().find((n) => n !== first)!)
    expect(second).toContain(
      '## Resolved\n\n- Spotify has no active device: Opened Spotify on the laptop first'
    )
    expect(second).toContain('- Checked afterwards (Check playback): Now playing')
    expect(second).toContain('- Requested outcome: seen at the later check')
    expect(readCaptures(vault).activity).toContain(
      '2026-10-07 · Open: Spotify has no active device'
    )
  })

  it('a contradicting preference is a new note beside the old one, not over it', async () => {
    const c = newChat()
    turn(c, 'I like jazz now, not rock', [], 'Noted.')
    answer = async () => summary({ preferences: [pref('Prefers jazz', 'Prefers rock')] })
    await captured(capture(), c)
    expect(saved()).toContain(
      'Prefers jazz (changes an earlier preference: "Prefers rock"; the earlier note is left as written)'
    )
  })

  it('a turn during a running capture is looked at after it, not lost or merged', async () => {
    const c = newChat()
    turn(c, 'play', [{ name: 'spotify__play', status: 'completed', write: true }])
    const cap = capture()
    let release!: () => void
    answer = () => new Promise((r) => (release = () => r(summary({ workflows: [workflow()] }))))
    chats.set(c.id, c)
    cap.afterTurn(c, 'claude')
    const running = cap.run()
    await new Promise((r) => setTimeout(r, 10))
    turn(chats.get('chat-1')!, 'pause', [
      { name: 'spotify__pause', status: 'completed', write: true }
    ])
    cap.afterTurn(chats.get('chat-1')!, 'claude')
    answer = async () => summary({ workflows: [workflow({ title: 'Pause' })] })
    release()
    await running
    expect(calls).toHaveLength(2)
    expect(calls[1]).not.toContain('spotify__play')
    expect(notes()).toHaveLength(2)
  })

  it('never runs an action: the only thing it can call is the tool-less summarizer', async () => {
    const c = newChat()
    turn(c, 'play', [{ name: 'spotify__play', status: 'unknown', write: true }])
    const cap = capture()
    await captured(cap, c)
    // Capture has no access to plugins or tools at all; its only outputs
    // are notes and the chat's memory record.
    expect(Object.keys(c.actions!)).toHaveLength(1)
    expect(c.messages).toHaveLength(4)
  })
})

// --- Opting out, deleting and forgetting -----------------------------------

describe('opt-out, deletion and forgetting', () => {
  const played = (c: Conversation, what = 'play'): void =>
    turn(c, what, [{ name: 'spotify__play', status: 'completed', write: true }])

  it('opt-out: stops future captures, keeps earlier notes, and turning it on does not reach back', async () => {
    const c = newChat()
    played(c)
    const cap = capture()
    await captured(cap, c)
    const kept = notes()
    cap.setChatMemory('chat-1', true)
    played(c, 'play again')
    await captured(cap, c)
    expect(calls).toHaveLength(1)
    expect(notes()).toEqual(kept)
    cap.setChatMemory('chat-1', false)
    turn(c, 'thanks')
    await captured(cap, c)
    expect(calls).toHaveLength(1)
  })

  it("opt-out cancels a waiting capture, and turning it on doesn't bring it back", async () => {
    const { renameSync } = await import('fs')
    renameSync(vault, `${vault}-away`)
    const c = newChat()
    played(c)
    const cap = capture()
    await captured(cap, c)
    expect(job().status).toBe('pending')
    cap.setChatMemory('chat-1', true)
    expect(job().status).toBe('off')
    expect(cap.pending()).toEqual([])
    renameSync(`${vault}-away`, vault)
    cap.setChatMemory('chat-1', false)
    await cap.run()
    cap.afterTurn(chats.get('chat-1')!, 'claude')
    await cap.run()
    expect(calls).toHaveLength(0)
    expect(notes()).toEqual([])
  })

  it('a temporary chat is never captured, and memory cannot be turned on for it', async () => {
    const c = newChat()
    c.memory = { off: true, temporary: true, watermark: 0 }
    played(c)
    const cap = capture()
    await captured(cap, c)
    expect(calls).toHaveLength(0)
    expect(job().reason).toBe('This is a temporary chat.')
    cap.setChatMemory('chat-1', false)
    expect(chats.get('chat-1')!.memory!.off).toBe(true)
    turn(chats.get('chat-1')!, 'From now on I prefer jazz')
    await captured(cap, chats.get('chat-1')!)
    expect(calls).toHaveLength(0)
    expect(notes()).toEqual([])
  })

  it('manual deletion: a deleted note is not written again, and that part is not captured again', async () => {
    const c = newChat()
    played(c)
    const cap = capture()
    await captured(cap, c)
    rmSync(join(vault, notes()[0]))
    turn(c, 'thanks')
    await captured(cap, c)
    played(c, 'pause')
    answer = async () => summary({ workflows: [workflow({ title: 'Pause' })] })
    await captured(cap, c)
    expect(notes()).toHaveLength(1)
    expect(saved()).not.toContain('Play Discover Weekly')
    expect(calls.at(-1)).not.toContain(
      'A1: spotify__play [spotify__play, plugin spotify, changes something] → completed\n- A2'
    )
    expect(calls.at(-1)).toMatch(/User requests \(oldest first\):\n1\. thanks\n2\. pause/)
  })

  it("forget: deletes only this chat's capture notes, and keeps nothing of them", async () => {
    mkdirSync(join(vault, 'Custard/Plugins/Spotify/Activity'), { recursive: true })
    const c = newChat()
    played(c)
    answer = async () =>
      summary({ preferences: [pref('Secret preference')], workflows: [workflow()] })
    const cap = capture()
    await captured(cap, c)
    // A capture note from this chat elsewhere under Custard (a plugin folder).
    const elsewhere = 'Custard/Plugins/Spotify/Activity/x.md'
    writeFileSync(
      join(vault, elsewhere),
      `---\ncustard-capture: "chat-1:9-10"\nchat: "chat-1"\n---\n`
    )
    const other = newChat('chat-2', 'Other')
    played(other)
    answer = async () => summary({ workflows: [workflow()] })
    await captured(cap, other)
    writeFileSync(join(vault, 'Custard/Captures/mine.md'), 'chat: "chat-1"\nmy own note')
    expect(cap.savedNotes('chat-1')).toEqual([
      `Custard/Captures/2026-10-07 1200 Spotify test ${hashOf('chat-1:0-4')}.md`,
      elsewhere
    ])
    const r = cap.forget('chat-1')
    expect(r.left).toEqual([])
    expect(r.deleted).toHaveLength(2)
    expect(chatCaptures(vault, 'chat-1')).toEqual([])
    // Same minute: their order is only by file time, so compare as a set.
    expect(notes().sort()).toEqual([
      `Custard/Captures/2026-10-07 1200 Other ${hashOf('chat-2:0-4')}.md`,
      'Custard/Captures/mine.md'
    ])
    const m = chats.get('chat-1')!.memory!
    expect(m).toMatchObject({ off: true, forgotten: true, watermark: c.messages.length })
    expect(m.job!.plan).toBeUndefined()
    expect(m.job!.notes).toBeUndefined()
    expect(JSON.stringify(m)).not.toContain('Secret preference')
    expect(readCaptures(vault).remembered.join()).not.toContain('Secret preference')
  })

  it('forget cannot be undone by later turns, the switch, a waiting job or a summary in flight', async () => {
    const c = newChat()
    played(c)
    const cap = capture()
    let release!: () => void
    answer = () =>
      new Promise((r) => (release = () => r(summary({ preferences: [pref('Secret preference')] }))))
    chats.set(c.id, c)
    cap.afterTurn(c, 'claude')
    const running = cap.run()
    await new Promise((r) => setTimeout(r, 10))
    cap.forget('chat-1')
    release()
    await running
    expect(notes()).toEqual([])
    cap.setChatMemory('chat-1', false)
    expect(chats.get('chat-1')!.memory!.off).toBe(true)
    turn(chats.get('chat-1')!, 'I prefer jazz from now on')
    await captured(cap, chats.get('chat-1')!)
    expect(calls).toHaveLength(1)
    expect(notes()).toEqual([])
    expect(cap.pending()).toEqual([])
  })
})

describe('capture without an API key', () => {
  it('waits instead of failing, and goes ahead once there is one', async () => {
    let key = false
    const c = newChat()
    turn(c, 'play', [{ name: 'spotify__play', status: 'completed', write: true }])
    const cap = capture({
      summarizer: () =>
        key
          ? async (e) => {
              calls.push(e)
              return answer(e)
            }
          : null
    })
    await captured(cap, c)
    expect(job().status).toBe('pending')
    expect(job().reason).toMatch(/no API key/)
    key = true
    await cap.run()
    expect(job().status).toBe('saved')
  })
})
