import { assert, createContext, response, test } from 'custard-plugin-sdk/testing'
import plugin from '../src/index'
import manifest from '../plugin.json'
import { playbackCommand, type Player } from '../src/playback'
import { json, makeTrack, setup } from './helpers'

const player = (): Player => ({
  device: { id: 'desk', name: 'Desk', type: 'Computer', is_active: true, is_restricted: false, volume_percent: 50, supports_volume: true },
  item: makeTrack(1), is_playing: true, progress_ms: 12000, actions: { disallows: {} }
})
const cases = [
  { name: 'next_track', method: 'POST', path: 'next', input: {} },
  { name: 'previous_track', method: 'POST', path: 'previous', input: {} },
  { name: 'pause_playback', method: 'PUT', path: 'pause', input: {} },
  { name: 'resume_playback', method: 'PUT', path: 'play', input: {} },
  { name: 'seek', method: 'PUT', path: 'seek', input: { position_ms: 1000 } },
  { name: 'adjust_volume', method: 'PUT', path: 'volume', input: { direction: 'lower' } }
]

for (const example of cases) {
  test(`${example.name}: one preflight, one authorized write, no fallback or verification claim`, async () => {
    const { t, calls, ctx } = setup((c) => c.method === 'GET' ? json(200, player()) : json(204))
    const result = await t[example.name]({ ...example.input, device_id: 'desk' })
    assert.equal(result.isError, false)
    assert.match(result.content, /Spotify accepted/)
    assert.match(result.content, /not been verified/)
    assert.equal(calls.length, 2)
    assert.equal(calls[0].path, '/me/player')
    assert.equal(calls[0].method, 'GET')
    assert.equal(calls[1].path, `/me/player/${example.path}`)
    assert.equal(calls[1].method, example.method)
    assert.equal(calls[1].query.get('device_id'), 'desk')
    assert.equal(calls[1].init.auth, true)
    assert.equal(calls[1].body, undefined)
    assert.deepEqual(ctx.opened, [])
  })
}

test('manifest registers every handler and every new playback mutation is approval-gated', () => {
  assert.deepEqual(Object.keys(plugin.tools).sort(), manifest.tools.map((tool) => tool.name).sort())
  for (const { name } of cases) {
    const tool = manifest.tools.find((entry) => entry.name === name)
    assert(tool, `registered ${name}`)
    assert.equal(tool?.effect, 'write')
    assert.equal(tool?.inputSchema.additionalProperties, false)
  }
  assert.deepEqual(manifest.auth.scopes, ['user-read-playback-state', 'user-read-currently-playing', 'user-modify-playback-state'])
  assert.equal(manifest.permissions.storage, false)
  assert.deepEqual(manifest.permissions.network, ['api.spotify.com', 'accounts.spotify.com'])
})

test('all new public handlers work through the SDK context', async () => {
  for (const example of cases) {
    const ctx = createContext({ fetch: (_url, init) => init.method === 'GET' ? response(200, player()) : response(204) })
    const r = await plugin.tools[example.name](example.input, ctx)
    assert(typeof r !== 'string')
    if (typeof r !== 'string') assert.equal(r.isError, false)
    assert.equal(ctx.calls.length, 2)
  }
})

test('resume on a paused item sends no context, queue, offset or position', async () => {
  const p = player(); p.is_playing = false
  const { t, calls } = setup((c) => c.method === 'GET' ? json(200, p) : json(204))
  await t.resume_playback({})
  assert.equal(calls[1].init.body, undefined)
  assert.equal(calls[1].query.toString(), 'device_id=desk')
  assert.equal(calls.length, 2)
})

test('resume refuses absent item instead of starting a new context', async () => {
  const p = player(); p.item = null
  const { t, calls } = setup(() => json(200, p))
  assert.match((await t.resume_playback({})).content, /No existing playback item/)
  assert.equal(calls.length, 1)
})

test('invalid arguments fail before any API calls', async () => {
  const { t, calls } = setup(() => json(204))
  for (const value of [-1, 0.5, NaN, Infinity, '1000', undefined, 9007199254740992])
    assert.equal((await t.seek({ position_ms: value })).isError, true)
  for (const value of [0, -1, 101, 1.5, '5', null])
    assert.equal((await t.adjust_volume({ direction: 'raise', amount_percent: value })).isError, true)
  assert.equal((await t.adjust_volume({ direction: 'up' })).isError, true)
  for (const value of ['', '   ', 123, 'x'.repeat(101)])
    assert.equal((await t.pause_playback({ device_id: value })).isError, true)
  assert.equal(calls.length, 0)
})

test('seek zero restarts by seek only, and a position before the end is valid', async () => {
  for (const position of [0, 199999]) {
    const { t, calls } = setup((c) => c.method === 'GET' ? json(200, player()) : json(204))
    assert.equal((await t.seek({ position_ms: position })).isError, false)
    assert.equal(calls[1].query.get('position_ms'), String(position))
    assert.equal(calls[1].path, '/me/player/seek')
  }
})

test('seek refuses end/past-end, missing duration and non-track content without a write', async () => {
  const fixtures: [Player, number][] = [[player(), 200000], [player(), 200001]]
  const unknown = player(); delete unknown.item!.duration_ms; fixtures.push([unknown, 0])
  const episode = player(); episode.item!.uri = 'spotify:episode:abc'; fixtures.push([episode, 0])
  const empty = player(); empty.item = null; fixtures.push([empty, 0])
  for (const [p, position_ms] of fixtures) {
    const { t, calls } = setup(() => json(200, p))
    assert.equal((await t.seek({ position_ms })).isError, true)
    assert.equal(calls.length, 1)
  }
})

test('relative volume defaults to five percentage points and clamps both ends', async () => {
  for (const [direction, current, amount, target] of [
    ['raise', 50, undefined, 55], ['lower', 50, undefined, 45],
    ['raise', 98, 10, 100], ['lower', 2, 10, 0]
  ] as const) {
    const p = player(); p.device!.volume_percent = current
    const { t, calls } = setup((c) => c.method === 'GET' ? json(200, p) : json(204))
    const r = await t.adjust_volume({ direction, amount_percent: amount })
    assert.equal(r.isError, false)
    assert.equal(calls[1].query.get('volume_percent'), String(target))
  }
})

test('volume at limit is a no-op, not an API-accepted write', async () => {
  const p = player(); p.device!.volume_percent = 100
  const { t, calls } = setup(() => json(200, p))
  const r = await t.adjust_volume({ direction: 'raise' })
  assert.equal(r.isError, false)
  assert.match(r.content, /No volume command was sent/)
  assert.notMatch(r.content, /accepted/)
  assert.equal(calls.length, 1)
})

test('volume refuses unsupported control or unknown/out-of-range current volume', async () => {
  for (const mode of ['unsupported', 'unknown', 'bad']) {
    const p = player()
    if (mode === 'unsupported') p.device!.supports_volume = false
    else p.device!.volume_percent = mode === 'unknown' ? null : 101
    const { t, calls } = setup(() => json(200, p))
    assert.equal((await t.adjust_volume({ direction: 'lower' })).isError, true)
    assert.equal(calls.length, 1)
  }
})

test('old device responses without supports_volume can attempt known-volume changes', async () => {
  const p = player(); delete p.device!.supports_volume
  const { t } = setup((c) => c.method === 'GET' ? json(200, p) : json(204))
  assert.equal((await t.adjust_volume({ direction: 'raise' })).isError, false)
})

test('all controls refuse no active, inactive, restricted, null-ID or mismatched devices', async () => {
  const inactive = player(); inactive.device!.is_active = false
  const restricted = player(); restricted.device!.is_restricted = true
  const noId = player(); noId.device!.id = null
  for (const example of cases) {
    for (const p of [null, inactive, restricted, noId, player()]) {
      const { t, calls, ctx } = setup(() => p ? json(200, p) : json(204))
      const r = await t[example.name]({ ...example.input, ...(p?.device?.id === 'desk' && p.device.is_active && !p.device.is_restricted ? { device_id: 'other' } : {}) })
      assert.equal(r.isError, true)
      assert.match(r.content, /^Not run:/)
      assert.equal(calls.length, 1)
      assert.deepEqual(ctx.opened, [])
    }
  }
})

test('respects nested and flat Spotify disallow flags for every mapped action', async () => {
  const map = { next_track: 'skipping_next', previous_track: 'skipping_prev', pause_playback: 'pausing', resume_playback: 'resuming', seek: 'seeking' }
  for (const [name, key] of Object.entries(map)) {
    for (const actions of [{ disallows: { [key]: true } }, { [key]: true }]) {
      const p = player(); p.actions = actions
      const { t, calls } = setup(() => json(200, p))
      assert.match((await t[name]({ position_ms: 0 })).content, /disallows/)
      assert.equal(calls.length, 1)
    }
  }
})

test('preflight auth, restriction, rate-limit and network failures never issue writes', async () => {
  for (const status of [401, 403, 429, 500, 0]) {
    const { t, calls } = setup(() => {
      if (!status) throw new Error('network failed')
      return json(status, {}, { 'Retry-After': '0' })
    })
    assert.match((await t.next_track({})).content, /^Not run:/)
    assert.equal(calls.length, 1)
  }
})

for (const [status, reason, message, pattern] of [
  [401, '', '', /Connect Spotify again/],
  [403, 'PREMIUM_REQUIRED', '', /Premium/],
  [403, '', 'Insufficient client scope', /Reconnect Spotify/],
  [403, 'RESTRICTION_VIOLATED', '', /restricted or unsupported/],
  [403, '', 'Forbidden', /User Management/],
  [404, 'NO_ACTIVE_DEVICE', '', /No active Spotify device/],
  [429, '', '', /Retry-After: 12 seconds/]
] as const) {
  test(`write rejection ${status} ${reason || message}: clear failure, never retried`, async () => {
    const { t, calls } = setup((c) => c.method === 'GET' ? json(200, player()) : json(status, { error: { reason, message } }, { 'Retry-After': '12' }))
    const r = await t.next_track({})
    assert.equal(r.isError, true)
    assert.match(r.content, pattern)
    assert.match(r.content, /Spotify rejected/)
    assert.equal(calls.length, 2)
  })
}

test('every new control reports uncertain writes without any replay or fallback', async () => {
  for (const example of cases) {
    for (const status of [500, 502, 0]) {
      const { t, calls } = setup((c) => {
        if (c.method === 'GET') return json(200, player())
        if (!status) throw new Error('response lost')
        return json(status, {})
      })
      const r = await t[example.name](example.input)
      assert.equal(r.isError, true)
      assert.match(r.content, /^Outcome unknown:/)
      assert.match(r.content, /No automatic retry/)
      assert.equal(calls.length, 2)
    }
  }
})

test('429 Retry-After zero does not trigger a playback write retry', async () => {
  const { t, calls } = setup((c) => c.method === 'GET' ? json(200, player()) : json(429, {}, { 'Retry-After': '0' }))
  assert.equal((await t.previous_track({})).isError, true)
  assert.equal(calls.length, 2)
})

test('cancellation before preflight or while reading never starts a write', async () => {
  for (const early of [true, false]) {
    const controller = new AbortController()
    if (early) controller.abort()
    const { deps, calls } = setup(() => { controller.abort(); return json(200, player()) })
    const r = await playbackCommand({ ...deps, signal: controller.signal }, 'next_track', {})
    assert.match(r.content, /cancelled/)
    assert.equal(calls.length, early ? 0 : 1)
  }
})
