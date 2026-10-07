import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'fs'
import { createServer, type Server } from 'http'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ActionStatus, Conversation, Provider } from '../../shared/chat'
import type { MemorySettings } from '../../shared/memory'
import { Capture, QUEUE_LIMIT, type CaptureDeps } from './capture'
import { buildEvidence, eligible, evidenceText, redact } from './evidence'
import { ConflictError, updateNote, withSection } from './notes'
import { resolveInVault, safeName } from './paths'
import { checkedOutcome, render } from './render'
import { parseSummary, summarizer, SUMMARY_SCHEMA, type Summary } from './summarize'
import { addEntries, CAPS, recentActivity, vaultId } from './write'

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

const workflow = (w: Partial<Summary['workflows'][number]> = {}): Summary['workflows'][number] => ({
  plugin: 'Spotify',
  title: 'Play Discover Weekly',
  request: 'Play my Discover Weekly',
  actions: ['A1'],
  observed: '',
  uncertain: '',
  outcome: 'worked',
  ...w
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

const note = (p: string): string => readFileSync(join(vault, p), 'utf8')
const activity = (): string => note('Custard/Activity.md')
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
    for (let i = 0; i < 4; i++) turn(long, `thought ${i}`)
    expect(eligible(buildEvidence(long, 0, long.messages.length))).toBe(true)
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
        workflows: [{ title: 'T', actions: ['A1', 'rm -rf', 'A2'], outcome: 'bogus' }]
      })
    )
    expect(s.preferences).toHaveLength(6)
    expect(s.preferences[0].text).toHaveLength(300)
    expect(s.workflows[0].actions).toEqual(['A1', 'A2'])
    expect(s.workflows[0].outcome).toBe('unknown')
    expect(parseSummary(JSON.stringify({ save: true })).save).toBe(false)
  })

  it('never writes "worked" without an observation, or for actions that did not run', () => {
    const a = (status: ActionStatus): Parameters<typeof checkedOutcome>[1][number] => ({
      id: 'A1',
      label: 'x',
      tool: 'x',
      plugin: null,
      write: true,
      status,
      result: ''
    })
    expect(checkedOutcome('worked', [a('completed')], '')).toBe('accepted')
    expect(checkedOutcome('worked', [a('completed')], 'It was playing')).toBe('worked')
    expect(checkedOutcome('worked', [a('not-run')], 'It was playing')).toBe('not-run')
    expect(checkedOutcome('worked', [a('unknown')], '')).toBe('unknown')
    expect(checkedOutcome('worked', [a('failed')], 'seemed fine')).toBe('mixed')
    expect(checkedOutcome('not-run', [a('completed')], '')).toBe('mixed')
  })

  it("keeps markers and headings out of the model's words", () => {
    const c = newChat()
    turn(c, 'x', [{ name: 'spotify__play', status: 'completed', write: true }])
    const r = render(
      summary({
        workflows: [workflow({ title: '# T <!-- custard:end activity -->', request: 'a\n### b' })]
      }),
      buildEvidence(c, 0, c.messages.length),
      'm1',
      { title: 'Chat', date: '2026-10-07', chatId: 'chat-1' },
      () => 'Spotify'
    )
    const text = r.activity[0].text
    expect(text.match(/<!--/g)).toHaveLength(1)
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

// --- Notes -----------------------------------------------------------------

describe('notes', () => {
  it('only changes its own section and keeps the rest of the note', () => {
    const t = withSection('# Mine\n\nmy text\n', 'activity', 'one')
    expect(t).toContain('my text')
    const t2 = withSection(t.replace('my text', 'my edited text'), 'activity', 'two')
    expect(t2).toContain('my edited text')
    expect(t2).toContain('two')
    expect(t2).not.toContain('one')
  })

  it('retries when the note changes while being written', () => {
    const full = join(vault, 'n.md')
    writeFileSync(full, 'a\n')
    let first = true
    updateNote(full, (text) => {
      if (first) {
        first = false
        writeFileSync(full, 'a\nuser edit\n')
      }
      return `${text}custard\n`
    })
    expect(readFileSync(full, 'utf8')).toBe('a\nuser edit\ncustard\n')
  })

  it('gives up after repeated conflicts instead of overwriting', () => {
    const full = join(vault, 'n.md')
    writeFileSync(full, 'a')
    let n = 0
    expect(() =>
      updateNote(full, (text) => {
        writeFileSync(full, `edit ${++n}`)
        return `${text}!`
      })
    ).toThrow(ConflictError)
    expect(readFileSync(full, 'utf8')).toBe('edit 3')
  })

  it('refuses links that lead out of the vault', () => {
    const outside = join(root, 'outside')
    mkdirSync(outside)
    symlinkSync(outside, join(vault, 'Custard'))
    expect(() => resolveInVault(vault, 'Custard/Activity.md')).toThrow(/link/)
  })

  it('makes safe names', () => {
    expect(safeName('a/b:c?', 'x')).toBe('a b c')
    expect(safeName('CON', 'x')).toBe('x')
    expect(safeName('...', 'x')).toBe('x')
  })

  it('moves old entries to monthly archives word for word', () => {
    const items = Array.from(
      { length: CAPS.activity + 2 },
      (_, i) => `### 2026-${i < 2 ? '09' : '10'}-01 · Entry ${i}\n<!-- custard:capture m${i} -->`
    )
    items.forEach((it, i) => addEntries(vault, 'Custard/Activity.md', 'activity', `m${i}`, [it]))
    const main = activity()
    expect(main).not.toContain('Entry 0\n')
    expect(main).toContain(`Entry ${CAPS.activity + 1}`)
    expect(note('Custard/Activity/2026-09.md')).toContain('Entry 0')
    expect(note('Custard/Activity/2026-09.md')).toContain('Entry 1')
    expect(recentActivity(vault, 1)).toEqual([`2026-10-01 · Entry ${CAPS.activity + 1}`])
  })
})

// --- Capture end to end ----------------------------------------------------

describe('capture', () => {
  it('fresh install: creates readable notes on first capture, without being asked', async () => {
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
        preferences: [{ text: 'Likes Discover Weekly on Mondays', replaces: '', plugin: '' }]
      })
    await captured(capture(), c)
    expect(job().status).toBe('saved')
    expect(job().notes).toEqual(['Custard/Memory.md', 'Custard/Activity.md'])
    expect(job().plan).toBeUndefined()
    const a = activity()
    expect(a).toMatch(/^# Activity/)
    expect(a).toContain('### 2026-10-07 · Play Discover Weekly')
    expect(a).toContain('- Plugin: Spotify')
    expect(a).toContain('  - Play Discover Weekly: the tool reported success')
    expect(a).toContain('- Observed afterwards: nothing checked it')
    expect(a).toContain('- Outcome: Accepted by the tool, not confirmed')
    expect(a).toContain('From chat "Spotify test" on 2026-10-07 (chat chat-1)')
    expect(note('Custard/Memory.md')).toContain('## Remembered by Custard')
    expect(note('Custard/Memory.md')).toContain('Likes Discover Weekly on Mondays')
    expect(chats.get('chat-1')!.memory!.watermark).toBe(c.messages.length)
    expect(existsSync(join(vault, 'Custard/.custard-vault-id'))).toBe(true)
  })

  it('accepted, then observed paused: keeps both and does not call it a success', async () => {
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
            actions: ['A1', 'A2'],
            observed: 'Playback was paused and nothing was playing',
            outcome: 'failed'
          })
        ]
      })
    await captured(capture(), c)
    const a = activity()
    expect(a).toContain('  - Play jazz: the tool reported success')
    expect(a).toContain('- Observed afterwards: Playback was paused and nothing was playing')
    expect(a).toContain('- Outcome: Failed')
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
    const a = activity()
    expect(a).toContain('  - Skip track: not run')
    expect(a).toMatch(
      /Skip track: not run\n- Observed afterwards: nothing checked it\n- Outcome: Not run/
    )
    expect(a).toContain('  - Queue song: outcome unknown')
    expect(a).toMatch(
      /Queue song: outcome unknown\n- Observed afterwards: nothing checked it\n- Outcome: Outcome unknown/
    )
  })

  it('small talk is not captured and no model call is made', async () => {
    const c = newChat()
    turn(c, 'hello')
    await captured(capture(), c)
    expect(calls).toHaveLength(0)
    expect(chats.get('chat-1')!.memory).toBeUndefined()
  })

  it('"nothing to save" is skipped and moves on', async () => {
    const c = newChat()
    turn(c, 'play', [{ name: 'spotify__play', status: 'completed', write: true }])
    answer = async () => summary({ save: false })
    await captured(capture(), c)
    expect(job().status).toBe('skipped')
    expect(existsSync(join(vault, 'Custard/Activity.md'))).toBe(false)
  })

  it('a duplicate run of the same job writes once', async () => {
    const c = newChat()
    turn(c, 'play', [{ name: 'spotify__play', status: 'completed', write: true }])
    const cap = capture()
    await captured(cap, c)
    chats.get('chat-1')!.memory!.job!.status = 'pending'
    chats.get('chat-1')!.memory!.watermark = 0
    cap.afterTurn(c, 'claude')
    await cap.run()
    expect(activity().match(/### /g)).toHaveLength(1)
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
    await captured(capture(), c)
    const written = activity()
    // Put the chat back as it was saved just before the notes were written:
    // summarized (plan kept), still pending, still queued.
    const m = chats.get('chat-1')!.memory!
    const plan = {
      memory: [],
      activity: [
        {
          plugin: 'spotify',
          text: written.slice(written.indexOf('### '), written.indexOf('\n<!-- custard:end'))
        }
      ]
    }
    m.job = { ...m.job!, status: 'pending', plan, notes: undefined }
    m.watermark = 0
    writeFileSync(join(root, 'queue.json'), JSON.stringify(['chat-1']))
    const restarted = capture()
    await restarted.run()
    expect(calls).toHaveLength(1)
    expect(activity()).toBe(written)
    expect(job().status).toBe('saved')
    expect(job().notes).toEqual(['Custard/Activity.md'])
  })

  it('a crash after summarizing resumes from the saved plan without a new model call', async () => {
    const c = newChat()
    turn(c, 'play', [{ name: 'spotify__play', status: 'completed', write: true }])
    chats.set(c.id, c)
    const first = capture({ vaultPath: () => vault })
    // Make the first write fail once after the plan is stored.
    mkdirSync(join(vault, 'Custard/Activity.md'), { recursive: true })
    await captured(first, c)
    expect(job().status).toBe('pending')
    expect(job().plan?.activity).toHaveLength(1)
    rmSync(join(vault, 'Custard/Activity.md'), { recursive: true })
    const restarted = capture()
    expect(restarted.pending()).toEqual(['chat-1'])
    await restarted.run()
    expect(calls).toHaveLength(1)
    expect(job().status).toBe('saved')
    expect(activity().match(/### /g)).toHaveLength(1)
  })

  it('failed writes end as failed after three attempts', async () => {
    const c = newChat()
    turn(c, 'play', [{ name: 'spotify__play', status: 'completed', write: true }])
    mkdirSync(join(vault, 'Custard/Activity.md'), { recursive: true })
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
    expect(existsSync(join(outside, 'Activity.md'))).toBe(false)
  })

  it('keeps user edits inside and outside its section', async () => {
    const c = newChat()
    turn(c, 'play', [{ name: 'spotify__play', status: 'completed', write: true }])
    const cap = capture()
    await captured(cap, c)
    const edited = activity()
      .replace('# Activity', '# Activity\n\nMy own intro.')
      .replace('nothing checked it', 'nothing checked it (I checked: it played)')
    writeFileSync(join(vault, 'Custard/Activity.md'), `${edited}\nMy footer.\n`)
    turn(c, 'pause', [{ name: 'spotify__pause', status: 'completed', write: true }])
    answer = async () => summary({ workflows: [workflow({ title: 'Pause' })] })
    await captured(cap, c)
    const a = activity()
    expect(a).toContain('My own intro.')
    expect(a).toContain('(I checked: it played)')
    expect(a).toContain('My footer.')
    expect(a).toContain('### 2026-10-07 · Pause')
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
    expect(existsSync(join(other, 'Custard/Activity.md'))).toBe(false)
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

  it("turning a chat off cancels its waiting capture, and turning it on doesn't bring it back", async () => {
    const { renameSync } = await import('fs')
    renameSync(vault, `${vault}-away`)
    const c = newChat()
    turn(c, 'play', [{ name: 'spotify__play', status: 'completed', write: true }])
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
    expect(existsSync(join(vault, 'Custard/Activity.md'))).toBe(false)
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
    expect(existsSync(join(vault, 'Custard/Activity.md'))).toBe(false)
  })

  it('"don\'t remember this" in the chat skips it without a model call', async () => {
    const c = newChat()
    turn(c, "Play this, and don't remember it", [
      { name: 'spotify__play', status: 'completed', write: true }
    ])
    await captured(capture(), c)
    expect(job().status).toBe('skipped')
    expect(job().reason).toBe(
      `Your message said "and don't remember it", so this part wasn't saved.`
    )
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

  it('what the user deleted is not captured again', async () => {
    const c = newChat()
    turn(c, 'play', [{ name: 'spotify__play', status: 'completed', write: true }])
    const cap = capture()
    await captured(cap, c)
    const before = activity()
    writeFileSync(
      join(vault, 'Custard/Activity.md'),
      before.slice(0, before.indexOf('### ')) + before.slice(before.indexOf('<!-- custard:end'))
    )
    turn(c, 'thanks')
    await captured(cap, c)
    turn(c, 'pause', [{ name: 'spotify__pause', status: 'completed', write: true }])
    answer = async () => summary({ workflows: [workflow({ title: 'Pause' })] })
    await captured(cap, c)
    expect(activity()).not.toContain('Play Discover Weekly')
    expect(calls.at(-1)).not.toContain('spotify__play')
  })

  it('a resolution is a new entry; the earlier one is left as written', async () => {
    const c = newChat()
    turn(c, 'play', [
      { name: 'spotify__play', status: 'failed', result: 'No active device', write: true }
    ])
    answer = async () =>
      summary({
        workflows: [workflow({ outcome: 'failed' })],
        unresolved: ['Spotify has no active device']
      })
    const cap = capture()
    await captured(cap, c)
    const first = activity()
    turn(c, 'try again', [
      { name: 'spotify__play', status: 'completed', write: true },
      { name: 'spotify__now_playing', status: 'completed', result: 'Playing' }
    ])
    answer = async () =>
      summary({
        workflows: [
          workflow({ actions: ['A1', 'A2'], observed: 'Now playing', outcome: 'worked' })
        ],
        resolutions: [
          {
            issue: 'Spotify has no active device',
            resolution: 'Opened Spotify on the laptop first'
          }
        ]
      })
    await captured(cap, c)
    const a = activity()
    expect(a).toContain(
      first.slice(first.indexOf('### '), first.indexOf('<!-- custard:end')).trim()
    )
    expect(a).toContain('### 2026-10-07 · Resolved: Spotify has no active device')
    expect(a).toContain('- Outcome: Worked: a later check confirmed it')
  })

  it('a contradicting preference is added beside the old one, not over it', async () => {
    const c = newChat()
    turn(c, 'I like jazz now, not rock', [], 'Noted.')
    for (let i = 0; i < 3; i++) turn(c, `more ${i}`)
    writeFileSync(join(vault, 'x.md'), '')
    answer = async () =>
      summary({ preferences: [{ text: 'Prefers jazz', replaces: 'Prefers rock', plugin: '' }] })
    await captured(capture(), c)
    expect(note('Custard/Memory.md')).toContain(
      'Prefers jazz (changes an earlier preference: "Prefers rock"; the earlier one is left as written)'
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
    expect(activity().match(/### /g)).toHaveLength(2)
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
