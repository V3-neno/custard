import { assert, createContext, test, type TestContext } from 'custard-plugin-sdk/testing'
import type { Caller } from 'custard-plugin-sdk'
import manifest from '../plugin.json'
import { SpotifyClient } from '../src/client'
import { EventMemory, observe } from '../src/events'
import type { Player } from '../src/playback'
import { SeenTracks, tools, type SpotifyDeps } from '../src/tools'
import { withWidgetData, readSnapshot } from '../src/widget-data'
import { json, makeTrack, uri, type Call } from './helpers'
import { createPlayerWidget } from '../widget/player'
import { context, flush, rootDouble, snapshot } from './widget-support'

type Handler = (c: Call) => ReturnType<typeof json> | Promise<ReturnType<typeof json>>

// The tools with a fake Spotify and a fake event log.
function setup(handler: Handler, o: { caller?: Caller; events?: boolean; memory?: EventMemory } = {}): {
  t: ReturnType<typeof tools>; ctx: TestContext; deps: SpotifyDeps; calls: Call[]
} {
  const calls: Call[] = []
  const ctx = createContext({
    caller: o.caller ?? 'widget',
    events: o.events ?? true,
    fetch: (url, init) => {
      const u = new URL(url)
      const c = { method: init.method ?? 'GET', path: u.pathname.replace('/v1', ''), query: u.searchParams, body: init.body ? JSON.parse(init.body) : undefined, init }
      calls.push(c)
      return handler(c)
    }
  })
  const deps: SpotifyDeps = {
    client: new SpotifyClient(ctx),
    seen: new SeenTracks(),
    openExternal: (u) => ctx.openExternal(u),
    timeZone: 'Europe/Stockholm',
    events: { sink: ctx.events, caller: ctx.caller, memory: o.memory ?? new EventMemory(), timeZone: 'Europe/Stockholm' }
  }
  return { t: tools(deps), ctx, deps, calls }
}

const player = (n = 1, progress = 12000, playing = true): Player => ({
  device: { id: 'desk', name: 'Desk', type: 'Computer', is_active: true, is_restricted: false, volume_percent: 50, supports_volume: true },
  item: { ...makeTrack(n), artists: [{ name: `Artist ${n}`, id: 'A'.repeat(22) }] },
  is_playing: playing, progress_ms: progress, actions: { disallows: {} }
})
const ok = (p: Player = player()): Handler => (c) => (c.method === 'GET' ? json(200, p) : json(204))
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- logged JSON records
const records = (ctx: TestContext): Record<string, any>[] => ctx.events.entries.map((e) => e.record)

test('manifest asks for the event log permission', () => {
  assert.equal((manifest.permissions as { events?: boolean }).events, true)
  assert.equal(manifest.version, '1.5.0')
})

test('a widget press logs one entry from the preflight read, with no extra request', async () => {
  const { t, ctx, calls } = setup(ok())
  const r = await t.next_track({})
  assert.equal(r.isError, false)
  assert.equal(calls.length, 3, 'preflight, write, one verification read: logging adds nothing')
  const [e] = records(ctx)
  assert.equal(ctx.events.entries.length, 1)
  assert.equal(e.type, 'skip')
  assert.equal(e.source, 'widget')
  assert.equal(e.position_ms, 12000)
  assert.equal(e.duration_ms, 200000)
  assert.deepEqual(e.track, { title: 'Song 1', artists: ['Artist 1'], artist_ids: ['A'.repeat(22)], uri: uri(1) })
  assert.deepEqual(e.device, { name: 'Desk', type: 'Computer' })
  assert.equal(e.outcome, 'accepted')
  assert.match(e.verification, /^(confirmed|not_observed|inconclusive|not_checked)$/)
  assert.match(e.at_utc, /Z$/)
  assert.match(e.at_local, /[+-]\d\d:\d\d$/)
  assert.equal(ctx.events.entries[0].at, e.at_utc)
})

test('the result the model and widget see is unchanged by logging', async () => {
  const on = setup(ok())
  const off = setup(ok(), { events: false })
  const a = await on.t.pause_playback({})
  const b = await off.t.pause_playback({})
  assert.equal(a.content.replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, 'T'), b.content.replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, 'T'))
  assert.equal(off.ctx.events.entries.length, 0, 'logging off writes nothing')
})

test('each action type, and the assistant as source', async () => {
  const { t, ctx } = setup(ok(), { caller: 'assistant' })
  await t.pause_playback({})
  await t.resume_playback({})
  await t.seek({ position_ms: 60000 })
  await t.seek({ position_ms: 0 })
  await t.adjust_volume({ direction: 'raise' })
  await t.previous_track({})
  const r = records(ctx)
  assert.deepEqual(r.map((e) => e.type), ['pause', 'resume', 'seek', 'restart', 'volume', 'previous'])
  assert(r.every((e) => e.source === 'assistant'))
  assert.equal(r[2].to_ms, 60000)
  assert.equal(r[3].to_ms, undefined, 'a restart has no to_ms')
  assert.equal(r[4].from_percent, 50)
  assert.equal(r[4].to_percent, 55)
})

test('not-run, rejected and no-change actions are not logged; a lost answer is logged as unknown', async () => {
  const noDevice = setup((c) => (c.method === 'GET' ? json(200, { ...player(), device: null }) : json(204)))
  await noDevice.t.next_track({})
  const rejected = setup((c) => (c.method === 'GET' ? json(200, player()) : json(403, { error: { status: 403, message: 'Restricted' } })))
  await rejected.t.next_track({})
  const full = setup((c) => (c.method === 'GET' ? json(200, { ...player(), device: { ...player().device!, volume_percent: 100 } }) : json(204)))
  await full.t.adjust_volume({ direction: 'raise' })
  for (const s of [noDevice, rejected, full]) assert.equal(s.ctx.events.entries.length, 0)
  const lost = setup((c) => (c.method === 'GET' ? json(200, player()) : json(502, { error: { status: 502, message: 'Bad gateway' } })))
  const r = await lost.t.next_track({})
  assert.match(r.content, /Outcome unknown/)
  assert.equal(records(lost.ctx)[0].outcome, 'unknown')
})

test('automations never log', async () => {
  const { t, ctx } = setup(ok(), { caller: 'automation' })
  await t.now_playing({})
  assert.equal(ctx.events.entries.length, 0)
})

test('queueing logs the accepted tracks as queue_add', async () => {
  const { t, ctx, deps } = setup((c) => (c.path === '/me/player/queue' && c.method === 'GET' ? json(200, { queue: [] }) : json(204)), { caller: 'assistant' })
  deps.seen.add(makeTrack(5)); deps.seen.add(makeTrack(6))
  await t.add_to_queue({ uris: [uri(5), uri(6)] })
  const [e] = records(ctx)
  assert.equal(e.type, 'queue_add')
  assert.equal(e.source, 'assistant')
  assert.deepEqual(e.uris, [uri(5), uri(6)])
})

test('track changes: only from the widget, with the previous track and a cause', async () => {
  const memory = new EventMemory()
  let current = player(1, 30000)
  const w = setup((c) => (c.method === 'GET' ? json(200, current) : json(204)), { memory })
  const a = setup((c) => (c.method === 'GET' ? json(200, current) : json(204)), { memory, caller: 'assistant' })
  await w.t.now_playing({}) // baseline, nothing logged
  assert.equal(w.ctx.events.entries.length, 0)
  current = player(2, 1000)
  await a.t.now_playing({}) // the assistant's read neither logs nor moves the baseline
  assert.equal(a.ctx.events.entries.length, 0)
  await w.t.now_playing({})
  const [e] = records(w.ctx)
  assert.equal(e.type, 'track_change')
  assert.equal(e.source, 'widget')
  assert.equal(e.track.uri, uri(2))
  assert.equal(e.previous.track.uri, uri(1))
  assert(e.previous.last_position_ms >= 30000, 'last position plus play time since')
  assert.equal(e.previous.position_estimated, true)
  assert.equal(e.cause, 'unknown')
  // A logged skip explains the next change.
  await w.t.next_track({})
  const skipId = records(w.ctx).at(-1)!.id
  current = player(3, 500)
  await w.t.now_playing({})
  const change = records(w.ctx).at(-1)!
  assert.equal(change.cause, 'logged_action')
  assert.equal(change.cause_id, skipId)
})

test('a track seen near its end counts as likely ended', async () => {
  const memory = new EventMemory()
  const ctx = createContext({ caller: 'widget', events: true })
  const d = { sink: ctx.events, caller: ctx.caller, memory }
  await observe(d, player(1, 197000, true), 1000)
  await observe(d, player(2, 2000, true), 4000)
  assert.equal(records(ctx)[0].cause, 'likely_ended')
  assert.equal(records(ctx)[0].previous.last_position_ms, 200000, 'never past the end')
})

test('a failing log is kept to the log, shown to the widget, and never breaks the tool', async () => {
  const { t, ctx, deps } = setup(ok())
  ctx.events.append = async () => { throw new Error('No Obsidian vault is set up, so nothing was saved.') }
  const r = await t.pause_playback({})
  assert.equal(r.isError, false)
  assert.equal(deps.events!.memory.failing, true)
  const shown = withWidgetData(await t.now_playing({}), 'failing')
  assert.equal(readSnapshot(shown.data)?.eventLog, 'failing')
})

test('Spotify text is passed as data: the host formats it, nothing here makes Markdown', async () => {
  const weird = { ...player(), item: { ...makeTrack(1), name: 'Hi [[Memory]] #tag\n```' } }
  const { t, ctx } = setup(ok(weird))
  await t.next_track({})
  assert.equal(records(ctx)[0].track.title, 'Hi [[Memory]] #tag\n```')
})

test('the player shows the log state it was given, and nothing when off', async () => {
  for (const [state, text, cls] of [['on', 'Logging to vault', 'logging'], ['failing', 'Event log not saving', 'logging failing']] as const) {
    const t = context(), d = rootDouble(), w = createPlayerWidget(t.clock)
    t.respond(async () => ({ status: 'completed', content: '', data: { ...snapshot(), eventLog: state } }))
    w.mount(d.root, t.ctx)
    t.ctx.visible = true; w.visibility!(true, t.ctx); await flush()
    const el = d.element.find(text)
    assert(el && !el.hidden, `${state} is shown`)
    assert.equal(el.className, cls)
    w.unmount!(t.ctx)
  }
  const t = context(), d = rootDouble(), w = createPlayerWidget(t.clock)
  t.respond(async () => ({ status: 'completed', content: '', data: { ...snapshot(), eventLog: 'off' } }))
  w.mount(d.root, t.ctx)
  t.ctx.visible = true; w.visibility!(true, t.ctx); await flush()
  const el = d.element.all().find((e) => e.className.startsWith('logging'))!
  assert(el.hidden, 'off shows nothing')
  w.unmount!(t.ctx)
})
