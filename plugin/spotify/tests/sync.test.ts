import { assert, createContext, test, type TestContext } from 'custard-plugin-sdk/testing'
import type { Caller } from 'custard-plugin-sdk'
import manifest from '../plugin.json'
import { SpotifyClient } from '../src/client'
import { SYNC_KEY, SYNC_PER_CALL, syncRecent } from '../src/sync'
import { json, makeTrack, type Call } from './helpers'

// Background sync: recently played → event log, one request a call.

const NOW = Date.parse('2026-10-20T12:00:00Z')
const play = (n: number, at: string): Record<string, unknown> => ({ played_at: at, track: makeTrack(n), context: null })
const minutesAgo = (m: number): string => new Date(NOW - m * 60_000).toISOString()

function setup(items: unknown[], o: { caller?: Caller; events?: boolean } = {}): {
  ctx: TestContext; calls: Call[]; run: () => ReturnType<typeof syncRecent>
} {
  const calls: Call[] = []
  const ctx = createContext({
    caller: o.caller ?? 'background',
    events: o.events ?? true,
    fetch: (url, init) => {
      const u = new URL(url)
      calls.push({ method: init.method ?? 'GET', path: u.pathname.replace('/v1', ''), query: u.searchParams, body: undefined, init })
      const after = Number(u.searchParams.get('after'))
      return json(200, { items: items.filter((i) => Date.parse((i as { played_at: string }).played_at) > after) })
    }
  })
  const run = (): ReturnType<typeof syncRecent> =>
    syncRecent({ client: new SpotifyClient(ctx), caller: ctx.caller, sink: ctx.events, storage: ctx.storage, timeZone: 'Europe/Stockholm', now: () => NOW })
  return { ctx, calls, run }
}

test('manifest: sync_recent is the background tool, every 30 minutes, read only', () => {
  const m = manifest as unknown as { version: string; background: { tool: string; everyMinutes: number }; permissions: { storage: boolean }; tools: { name: string; effect: string }[] }
  assert.equal(m.version, '1.6.0')
  assert.deepEqual(m.background, { tool: 'sync_recent', everyMinutes: 30 })
  assert.equal(m.tools.find((t) => t.name === 'sync_recent')?.effect, 'read')
  assert.equal(m.permissions.storage, true)
})

test('logs new plays oldest first, one request, and remembers where it got to', async () => {
  const { ctx, calls, run } = setup([play(2, minutesAgo(5)), play(1, minutesAgo(10))])
  const r = await run()
  assert.equal(r.isError, false)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].path, '/me/player/recently-played')
  assert.equal(calls[0].query.get('limit'), '50')
  const recs = ctx.events.entries.map((e) => e.record)
  assert.deepEqual(recs.map((e) => e.type), ['played', 'played'])
  assert.deepEqual(recs.map((e) => (e.track as { title: string }).title), ['Song 1', 'Song 2'])
  assert.equal(recs[0].source, 'recently_played')
  assert.equal(ctx.events.entries[0].at, minutesAgo(10))
  assert.equal(ctx.data.get(SYNC_KEY), Date.parse(minutesAgo(5)))
  // The next call asks only for what came after, and logs nothing twice.
  const again = await run()
  assert.equal(again.content, 'No new plays since the last sync.')
  assert.equal(calls[1].query.get('after'), String(Date.parse(minutesAgo(5))))
  assert.equal(ctx.events.entries.length, 2)
})

test('never asks for plays older than the event log takes (23 hours)', async () => {
  const { ctx, calls, run } = setup([play(1, minutesAgo(25 * 60)), play(2, minutesAgo(60))])
  await run()
  assert.equal(calls[0].query.get('after'), String(NOW - 23 * 3_600_000))
  assert.equal(ctx.events.entries.length, 1)
})

test(`logs at most ${SYNC_PER_CALL} a call and leaves the rest for the next`, async () => {
  const items = Array.from({ length: 30 }, (_, i) => play(i + 1, minutesAgo(100 - i)))
  const { ctx, run } = setup(items)
  const r = await run()
  assert.match(r.content, /Logged 20 .*; 10 more next time/)
  await run()
  assert.equal(ctx.events.entries.length, 30)
})

test('only Custard\'s background sync runs it, and only with the event log on', async () => {
  for (const caller of ['assistant', 'widget', 'automation'] as const) {
    const { calls, run } = setup([play(1, minutesAgo(5))], { caller })
    const r = await run()
    assert.equal(r.isError, true)
    assert.equal(calls.length, 0)
  }
  const off = setup([play(1, minutesAgo(5))], { events: false })
  const r = await off.run()
  assert.match(r.content, /event log is off/)
  assert.equal(off.calls.length, 0)
})
