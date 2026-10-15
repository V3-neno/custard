import { describe, expect, it } from 'vitest'
import type { Conversation } from '../shared/chat'
import type { UserPart } from '../shared/neutralChat'
import { actionKey, repairInterrupted, TurnLog, type Call, type ToolRun } from './turn'
import { calls as callsMsg, chat, partial, result, said, user } from '../../test/neutral/builders'

const conv = (): Conversation => chat()

const call = (id: string, name: string, write = false, input: unknown = {}): Call => ({
  id,
  name,
  input,
  label: name,
  write
})

// Records every save as a deep copy, like the file on disk.
function saved(): { save: (c: Conversation) => void; copies: Conversation[] } {
  const copies: Conversation[] = []
  return { save: (c) => copies.push(JSON.parse(JSON.stringify(c))), copies }
}

function startTurn(c: Conversation, save: (c: Conversation) => void, calls: Call[]): TurnLog {
  const log = new TurnLog(c, save)
  c.messages.push(user('do things'))
  log.addAssistant(callsMsg(...calls))
  return log
}

type Result = Extract<UserPart, { type: 'tool_result' }>
const lastResults = (c: Conversation): Result[] => {
  const m = c.messages[c.messages.length - 1]
  return m.role === 'user' ? m.parts.filter((b): b is Result => b.type === 'tool_result') : []
}

describe('a round with mixed outcomes', () => {
  it('keeps every success and labels each result', async () => {
    const c = conv()
    const { save } = saved()
    const calls = [
      call('a', 'vault_append', true),
      call('b', 'vault_read'),
      call('c', 'spotify__add_to_queue', true),
      call('d', 'spotify__open', true),
      call('e', 'vault_create_note', true)
    ]
    const log = startTurn(c, save, calls)
    const outcomes: Record<string, ToolRun> = {
      a: { content: 'Added to Notes.md', isError: false },
      b: { content: 'Note not found.', isError: true },
      c: {
        content: 'The plugin did not answer within 45 seconds, so the call was cancelled.',
        isError: true,
        outcome: 'unknown'
      },
      d: {
        content: 'The user declined this action, so nothing was done.',
        isError: true,
        outcome: 'not-run'
      },
      e: { content: 'Created New.md', isError: false }
    }
    await log.runRound(calls, async (x) => outcomes[x.id], new AbortController().signal)

    expect(Object.fromEntries(Object.entries(c.actions!).map(([k, v]) => [k, v.status]))).toEqual({
      a: 'completed',
      b: 'failed',
      c: 'unknown',
      d: 'not-run',
      e: 'completed'
    })
    const results = lastResults(c)
    expect(results.map((r) => r.callId)).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(results.map((r) => r.isError)).toEqual([false, true, true, true, false])
    expect(results[0].text).toBe('Added to Notes.md')
    expect(results[2].text).toMatch(/^Outcome unknown: The plugin did not answer/)
    expect(results[2].text).toMatch(/may or may not have taken effect/)
    expect(results[3].text).toMatch(/^Not run: The user declined/)
  })

  it('treats an exception from a write as unknown and from a read as failed', async () => {
    const c = conv()
    const calls = [call('w', 'fs_write', true), call('r', 'fs_read')]
    const log = startTurn(c, () => undefined, calls)
    await log.runRound(
      calls,
      async () => {
        throw new Error('disk vanished')
      },
      new AbortController().signal
    )
    expect(c.actions!.w.status).toBe('unknown')
    expect(c.actions!.r.status).toBe('failed')
    expect(c.actions!.w.result).toBe('disk vanished')
  })

  it('saves each call before the next one starts', async () => {
    const c = conv()
    const { save, copies } = saved()
    const calls = [call('a', 'vault_append', true), call('b', 'vault_append', true)]
    const log = startTurn(c, save, calls)
    let seenAtB: string | undefined
    await log.runRound(
      calls,
      async (x) => {
        if (x.id === 'b') seenAtB = copies[copies.length - 1].actions!.a.status
        return { content: 'ok', isError: false }
      },
      new AbortController().signal
    )
    expect(seenAtB).toBe('completed')
    // pending, then running and settled for each call, then the closed round.
    const statuses = copies.map((k) => k.actions?.a?.status)
    expect(statuses).toContain('pending')
    expect(statuses).toContain('running')
  })
})

describe('saving before dispatch', () => {
  it('a call is saved as running before it is sent, and a crash then reads as unknown', async () => {
    const c = conv()
    const { save, copies } = saved()
    const calls = [
      call('q', 'spotify__add_to_queue', true, { uris: ['x'] }),
      call('r', 'vault_read')
    ]
    const log = startTurn(c, save, calls)
    const onDisk: Record<string, Conversation> = {}
    await log.runRound(
      calls,
      async (x) => {
        // What is on disk at the moment the call is dispatched.
        onDisk[x.id] = copies[copies.length - 1]
        return { content: 'ok', isError: false }
      },
      new AbortController().signal
    )
    expect(onDisk.q.actions!.q.status).toBe('running')
    expect(onDisk.r.actions!.r.status).toBe('running')
    // Custard dies while each call is out: reopening finds them unfinished.
    const crashedAtQ = JSON.parse(JSON.stringify(onDisk.q)) as Conversation
    expect(repairInterrupted(crashedAtQ)).toBe(true)
    expect(crashedAtQ.actions!.q.status).toBe('unknown')
    expect(crashedAtQ.actions!.r.status).toBe('not-run')
    const crashedAtR = JSON.parse(JSON.stringify(onDisk.r)) as Conversation
    repairInterrupted(crashedAtR)
    expect(crashedAtR.actions!.q.status).toBe('completed')
    // A read cut off mid-call failed; it changed nothing.
    expect(crashedAtR.actions!.r.status).toBe('failed')
  })
})

describe('after a mixed round', () => {
  it('the next turn (such as Continue) runs only what the model asks for now', async () => {
    const c = conv()
    const calls = [call('a', 'vault_append', true, { text: 'hi' }), call('b', 'vault_read')]
    const log = startTurn(c, () => undefined, calls)
    await log.runRound(
      calls,
      async (x) =>
        x.id === 'a' ? { content: 'Added', isError: false } : { content: 'Missing', isError: true },
      new AbortController().signal
    )
    log.addAssistant(said('Partly done, and cut'))
    log.notice('cut-off', 'cut off')
    // Continue is a new turn on the same chat.
    const next = new TurnLog(c, () => undefined)
    c.messages.push(user('Continue from where you were cut off.'))
    const ran: string[] = []
    next.addAssistant(callsMsg({ id: 'c', name: 'vault_read' }))
    await next.runRound(
      [call('c', 'vault_read')],
      async (x) => {
        ran.push(x.id)
        return { content: 'ok', isError: false }
      },
      new AbortController().signal
    )
    expect(ran).toEqual(['c'])
    expect(c.actions!.a.status).toBe('completed')
    expect(c.actions!.b.status).toBe('failed')
    // The earlier results stay in the history the model sees.
    const firstResults = c.messages[2].parts as Result[]
    expect(firstResults.map((r) => [r.callId, r.text])).toEqual([
      ['a', 'Added'],
      ['b', 'Missing']
    ])
  })
})

describe('repeats after a crash', () => {
  it('are still recognised once the chat is reopened', () => {
    const input = { uris: ['x'] }
    const c = conv()
    c.messages = [user('queue it'), callsMsg({ id: 'q', name: 'spotify__add_to_queue', input })]
    c.actions = {
      q: {
        name: 'spotify__add_to_queue',
        label: 'Queue',
        write: true,
        status: 'running',
        key: actionKey('spotify__add_to_queue', input)
      }
    }
    repairInterrupted(c)
    const log = new TurnLog(c, () => undefined)
    expect(log.unknownRepeat(call('q2', 'spotify__add_to_queue', true, { uris: ['x'] }))).toBe(true)
  })
})

describe('stopping', () => {
  it('during an action: it becomes unknown, the rest never start', async () => {
    const c = conv()
    const controller = new AbortController()
    const calls = [
      call('a', 'vault_append', true),
      call('b', 'spotify__add_to_queue', true),
      call('c', 'vault_append', true)
    ]
    const log = startTurn(c, () => undefined, calls)
    const ran: string[] = []
    await log.runRound(
      calls,
      async (x) => {
        ran.push(x.id)
        if (x.id === 'b') {
          controller.abort()
          // What the host reports for a write cut short after it was sent.
          return { content: 'The call was cancelled.', isError: true, outcome: 'unknown' }
        }
        return { content: 'ok', isError: false }
      },
      controller.signal
    )
    expect(ran).toEqual(['a', 'b'])
    expect(c.actions!.a.status).toBe('completed')
    expect(c.actions!.b.status).toBe('unknown')
    expect(c.actions!.c.status).toBe('not-run')
    expect(lastResults(c)[2].text).toMatch(/^Not run: Stopped before it started/)

    expect(log.interrupt('stopped', 'Stopped by you.')).toBe(true)
    expect(c.notices).toEqual([
      { after: c.messages.length, kind: 'stopped', text: 'Stopped by you.' }
    ])
  })

  it('while text streams: the text so far is kept', () => {
    const c = conv()
    const log = new TurnLog(c, () => undefined)
    c.messages.push(user('hi'))
    log.text('Here is the start of ')
    expect(log.interrupt('stopped', 'Stopped by you.')).toBe(true)
    expect(c.messages[1]).toEqual(partial('Here is the start of'))
    expect(c.messages[1]).toEqual({
      role: 'assistant',
      parts: [{ type: 'text', text: 'Here is the start of' }],
      partial: true
    })
  })

  it('while text streams: the cut-off reply says which model wrote it', () => {
    const c = conv()
    const by = { provider: 'openai' as const, model: 'gpt-6-astra' }
    const log = new TurnLog(c, () => undefined, by)
    c.messages.push(user('hi'))
    log.text('Half ')
    expect(log.interrupt('stopped', 'Stopped by you.')).toBe(true)
    expect(c.messages[1]).toEqual(partial('Half', by))
  })

  it('before anything happened: the turn is taken back', () => {
    const c = conv()
    c.messages.push(user('earlier'), said('yes'))
    const log = new TurnLog(c, () => undefined)
    c.messages.push(user('hi'))
    expect(log.interrupt('error', 'Network down')).toBe(false)
    expect(c.messages).toHaveLength(2)
    expect(c.notices).toBeUndefined()
  })

  it('while a round is open (an error mid-round): closes it with a note', () => {
    const c = conv()
    const calls = [call('a', 'spotify__add_to_queue', true), call('b', 'vault_read')]
    const log = startTurn(c, () => undefined, calls)
    log.adoptOpenRound(calls)
    c.actions = {
      a: { name: 'x', label: 'x', write: true, status: 'running', key: 'k' },
      b: { name: 'y', label: 'y', write: false, status: 'pending', key: 'k2' }
    }
    log.interrupt('error', 'Lost connection.')
    const last = c.messages[c.messages.length - 1]
    expect(c.actions.a.status).toBe('unknown')
    expect(c.actions.b.status).toBe('not-run')
    expect(last.parts.at(-1)).toEqual({ type: 'note', text: '[Custard: Lost connection.]' })
    expect(last.parts.map((p) => p.type)).toEqual(['tool_result', 'tool_result', 'note'])
  })
})

describe('errors after actions', () => {
  it('keep the completed rounds and add a notice', async () => {
    const c = conv()
    const calls = [call('a', 'vault_append', true)]
    const log = startTurn(c, () => undefined, calls)
    await log.runRound(
      calls,
      async () => ({ content: 'Added', isError: false }),
      new AbortController().signal
    )
    log.text('Partial answ')
    expect(log.interrupt('error', 'Claude is overloaded right now.')).toBe(true)
    expect(c.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(c.messages[3]).toEqual(partial('Partial answ'))
    expect(c.notices![0]).toMatchObject({ kind: 'error', after: 4 })
  })
})

describe('notices', () => {
  it('cut-off and step-limit sit after the last message', () => {
    const c = conv()
    const log = new TurnLog(c, () => undefined)
    c.messages.push(user('write a lot'))
    log.addAssistant(said('long…'))
    log.notice('cut-off', 'The reply hit the length limit.')
    expect(c.notices).toEqual([
      { after: 2, kind: 'cut-off', text: 'The reply hit the length limit.' }
    ])
  })
})

describe('repeats of unknown actions', () => {
  it('are spotted by name and input, whatever the key order', async () => {
    const c = conv()
    const first = call('a', 'spotify__add_to_queue', true, { uris: ['x'], device_id: 'd' })
    const log = startTurn(c, () => undefined, [first])
    await log.runRound(
      [first],
      async () => ({ content: 'cancelled', isError: true, outcome: 'unknown' }),
      new AbortController().signal
    )
    expect(
      log.unknownRepeat(call('b', 'spotify__add_to_queue', true, { device_id: 'd', uris: ['x'] }))
    ).toBe(true)
    expect(log.unknownRepeat(call('b', 'spotify__add_to_queue', true, { uris: ['y'] }))).toBe(false)
    expect(actionKey('n', { b: 1, a: [1, { d: 2, c: 3 }] })).toBe(
      actionKey('n', { a: [1, { c: 3, d: 2 }], b: 1 })
    )
  })

  it('are not flagged for completed or not-run actions', async () => {
    const c = conv()
    const a = call('a', 'vault_append', true, { path: 'x.md', content: 'y' })
    const b = call('b', 'vault_append', true, { path: 'z.md', content: 'y' })
    const log = startTurn(c, () => undefined, [a, b])
    await log.runRound(
      [a, b],
      async (x) =>
        x.id === 'a'
          ? { content: 'ok', isError: false }
          : { content: 'declined', isError: true, outcome: 'not-run' },
      new AbortController().signal
    )
    expect(log.unknownRepeat({ ...a, id: 'a2' })).toBe(false)
    expect(log.unknownRepeat({ ...b, id: 'b2' })).toBe(false)
  })
})

describe('reloading a chat Custard closed mid-turn', () => {
  it('closes the open round from the saved records', () => {
    const c = conv()
    c.messages = [
      user('queue songs and note it'),
      callsMsg(
        { id: 'a', name: 'vault_append' },
        { id: 'b', name: 'spotify__add_to_queue', input: { uris: ['x'] } },
        { id: 'c', name: 'vault_read' }
      )
    ]
    c.actions = {
      a: {
        name: 'vault_append',
        label: 'Added',
        write: true,
        status: 'completed',
        key: 'ka',
        result: 'Added to x.md'
      },
      b: {
        name: 'spotify__add_to_queue',
        label: 'Queue',
        write: true,
        status: 'running',
        key: 'kb'
      },
      c: { name: 'vault_read', label: 'Read', write: false, status: 'pending', key: 'kc' }
    }
    expect(repairInterrupted(c)).toBe(true)
    expect(c.actions.a.status).toBe('completed')
    expect(c.actions.b.status).toBe('unknown')
    expect(c.actions.c.status).toBe('not-run')
    const results = lastResults(c)
    expect(results.map((r) => r.callId)).toEqual(['a', 'b', 'c'])
    expect(results[0].text).toBe('Added to x.md')
    expect(c.notices).toEqual([
      { after: 3, kind: 'interrupted', text: 'Custard closed before this turn finished.' }
    ])
    // Idempotent.
    expect(repairInterrupted(c)).toBe(false)
  })

  it('treats a call with no record as not run and a write without one as a write', () => {
    const c = conv()
    c.messages = [user('x'), callsMsg({ id: 'a', name: 'spotify__open' })]
    repairInterrupted(c)
    expect(c.actions!.a.status).toBe('not-run')
  })

  it('notes a turn that stopped between rounds', () => {
    const c = conv()
    c.messages = [user('x'), callsMsg({ id: 'a', name: 'vault_read' }), result('a', 'ok')]
    expect(repairInterrupted(c)).toBe(true)
    expect(c.notices![0]).toMatchObject({ after: 3, kind: 'interrupted' })
    expect(repairInterrupted(c)).toBe(false)
  })

  it('leaves finished chats alone', () => {
    const c = conv()
    c.messages = [user('x'), said('done')]
    expect(repairInterrupted(c)).toBe(false)
    expect(c.notices).toBeUndefined()
  })
})
