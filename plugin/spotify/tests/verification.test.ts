import { assert, test } from 'custard-plugin-sdk/testing'
import { playbackCommand, type Player } from '../src/playback'
import { tools } from '../src/tools'
import { timing, verifyQueue } from '../src/verify'
import { json, makeTrack, queueCalls, seed, setup, uri } from './helpers'

// Accepted (the write returned success) and verified (a later read saw the
// expected state) are reported separately. Verification is exactly one
// follow-up read: never a retry, never another write.
const base = (): Player => ({
  device: { id: 'desk', name: 'Desk', type: 'Computer', is_active: true, is_restricted: false, volume_percent: 50, supports_volume: true },
  item: makeTrack(1), is_playing: true, progress_ms: 12000, actions: { disallows: {} }
})
const changed = (f: (p: Player) => void): Player => { const p = base(); f(p); return p }

// before: the preflight snapshot. after: the follow-up snapshot, a status code, or a thrown failure.
function scripted(before: Player, after: Player | number | 'throw') {
  let wrote = false
  return setup((c) => {
    if (c.method !== 'GET') { wrote = true; return json(204) }
    if (!wrote) return json(200, before)
    if (after === 'throw') throw new Error('network down')
    return typeof after === 'number' ? json(after, after === 204 ? undefined : {}) : json(200, after)
  })
}
const state = (content: string): string => /\nverification: (\w+) — /.exec(content)?.[1] ?? 'none'

test('pause: confirmed when paused, not_observed when still playing, inconclusive when unreported', async () => {
  const confirmed = await scripted(base(), changed((p) => { p.is_playing = false })).t.pause_playback({})
  assert.equal(state(confirmed.content), 'confirmed')
  assert.match(confirmed.content, /Spotify accepted pause_playback/)
  const stuck = await scripted(base(), base()).t.pause_playback({})
  assert.equal(state(stuck.content), 'not_observed')
  assert.match(stuck.content, /Playback has not been verified/)
  assert.equal(stuck.isError, false, 'not_observed is not a failure')
  const unknown = await scripted(base(), changed((p) => { delete p.is_playing })).t.pause_playback({})
  assert.equal(state(unknown.content), 'inconclusive')
})

test('resume: confirmed when playing, not_observed when still paused', async () => {
  const paused = changed((p) => { p.is_playing = false })
  assert.equal(state((await scripted(paused, base()).t.resume_playback({})).content), 'confirmed')
  assert.equal(state((await scripted(paused, paused).t.resume_playback({})).content), 'not_observed')
})

test('seek: position near the request is confirmed, far is not_observed, a changed track is inconclusive', async () => {
  const near = changed((p) => { p.progress_ms = 1100 })
  assert.equal(state((await scripted(base(), near).t.seek({ position_ms: 1000 })).content), 'confirmed')
  const far = changed((p) => { p.progress_ms = 12500 })
  const r = await scripted(base(), far).t.seek({ position_ms: 1000 })
  assert.equal(state(r.content), 'not_observed')
  assert.match(r.content, /position is 12500 ms; 1000 ms was requested/)
  const otherTrack = changed((p) => { p.item = makeTrack(2); p.progress_ms = 1000 })
  assert.equal(state((await scripted(base(), otherTrack).t.seek({ position_ms: 1000 })).content), 'inconclusive')
  const pausedNear = changed((p) => { p.is_playing = false; p.progress_ms = 1000 })
  assert.equal(state((await scripted(base(), pausedNear).t.seek({ position_ms: 1000 })).content), 'confirmed')
})

test('volume: matches the requested target, otherwise not_observed or inconclusive', async () => {
  const at45 = changed((p) => { p.device!.volume_percent = 45 })
  assert.equal(state((await scripted(base(), at45).t.adjust_volume({ direction: 'lower' })).content), 'confirmed')
  const r = await scripted(base(), base()).t.adjust_volume({ direction: 'lower' })
  assert.equal(state(r.content), 'not_observed')
  assert.match(r.content, /reported at 50%; 45% was requested/)
  const unknown = changed((p) => { p.device!.volume_percent = null })
  assert.equal(state((await scripted(base(), unknown).t.adjust_volume({ direction: 'lower' })).content), 'inconclusive')
})

test('next and previous: a changed track is observed but never called the intended one', async () => {
  const second = changed((p) => { p.item = makeTrack(2) })
  const next = await scripted(base(), second).t.next_track({})
  assert.equal(state(next.content), 'confirmed')
  assert.match(next.content, /does not prove this command caused the change/)
  assert.equal(state((await scripted(base(), base()).t.next_track({})).content), 'not_observed')
  // Native Previous may restart the same track, so "same track" proves nothing either way.
  assert.equal(state((await scripted(base(), base()).t.previous_track({})).content), 'inconclusive')
})

test('device change, no device, failed read and thrown read are all inconclusive', async () => {
  const otherDevice = changed((p) => { p.device!.id = 'phone' })
  assert.equal(state((await scripted(base(), otherDevice).t.pause_playback({})).content), 'inconclusive')
  assert.equal(state((await scripted(base(), 204).t.pause_playback({})).content), 'inconclusive')
  assert.equal(state((await scripted(base(), 500).t.pause_playback({})).content), 'inconclusive')
  assert.equal(state((await scripted(base(), 401).t.pause_playback({})).content), 'inconclusive')
  const thrown = await scripted(base(), 'throw').t.pause_playback({})
  assert.equal(state(thrown.content), 'inconclusive')
  assert.equal(thrown.isError, false, 'the accepted write is still reported as accepted')
  assert.match(thrown.content, /Spotify accepted pause_playback/)
})

test('verification is one read: no retry of the write, no loop, even when it disagrees', async () => {
  const { t, calls } = scripted(base(), base())
  await t.pause_playback({})
  assert.equal(calls.length, 3)
  assert.equal(calls.filter((c) => c.method !== 'GET').length, 1)
  const failing = scripted(base(), 500)
  await failing.t.next_track({})
  assert.equal(failing.calls.length, 3)
  assert.equal(failing.calls.filter((c) => c.method !== 'GET').length, 1)
})

test('cancelled before the follow-up read: accepted is kept, verification is not_checked', async () => {
  const controller = new AbortController()
  const { deps, calls } = setup((c) => {
    if (c.method !== 'GET') { controller.abort(); return json(204) }
    return json(200, base())
  })
  const r = await playbackCommand({ ...deps, signal: controller.signal }, 'pause_playback', {})
  assert.match(r.content, /Spotify accepted pause_playback/)
  assert.equal(state(r.content), 'not_checked')
  assert.equal(calls.length, 2)
})

test('the follow-up waits for the configured delay', async () => {
  const saved = timing.verifyDelayMs
  timing.verifyDelayMs = 40
  try {
    const started = Date.now()
    await scripted(base(), base()).t.pause_playback({})
    assert(Date.now() - started >= 35, 'waited before the follow-up read')
  } finally { timing.verifyDelayMs = saved }
})

// ---- transfer ----------------------------------------------------------------

function transferSetup(after: Player | null) {
  let wrote = false
  return setup((c) => {
    if (c.method === 'PUT') { wrote = true; return json(204) }
    if (c.path === '/me/player/devices')
      return json(200, { devices: [{ id: 'desk', name: 'Desk', type: 'Computer', is_active: false, is_restricted: false }] })
    return wrote ? (after ? json(200, after) : json(204)) : json(204)
  })
}

test('transfer: confirmed only when the target is active (and playing if asked)', async () => {
  const playing = await transferSetup(base()).t.transfer_playback({ device_id: 'desk', play: true })
  assert.match(playing.content, /Spotify accepted moving playback to Desk and starting it/)
  assert.equal(state(playing.content), 'confirmed')
  const movedOnly = await transferSetup(changed((p) => { p.is_playing = false })).t.transfer_playback({ device_id: 'desk', play: false })
  assert.equal(state(movedOnly.content), 'confirmed')
})

test('transfer: accepted but not observed, as in the earlier paused-on-EMAX test', async () => {
  const stillPaused = await transferSetup(changed((p) => { p.is_playing = false })).t.transfer_playback({ device_id: 'desk', play: true })
  assert.equal(state(stillPaused.content), 'not_observed')
  assert.match(stillPaused.content, /Playback has not been verified/)
  assert.match(stillPaused.content, /not reported as playing/)
  const otherDevice = await transferSetup(changed((p) => { p.device!.id = 'tv' })).t.transfer_playback({ device_id: 'desk', play: false })
  assert.equal(state(otherDevice.content), 'not_observed')
  const none = await transferSetup(null).t.transfer_playback({ device_id: 'desk', play: true })
  assert.equal(state(none.content), 'not_observed')
})

// ---- queue -------------------------------------------------------------------

function queueSetup(before: number[] | 'fail', after: number[] | 'fail') {
  let posted = 0
  const s = setup((c) => {
    if (c.method === 'POST') { posted++; return json(204) }
    const which = posted === 0 ? before : after
    return which === 'fail' ? json(500, {}) : json(200, { queue: which.map((n) => ({ uri: uri(n) })) })
  })
  seed(s.deps, 4)
  return s
}

test('queue: new entries are confirmed with their positions in the visible queue', async () => {
  const { t, calls } = queueSetup([9], [9, 1, 2])
  const r = await t.add_to_queue({ uris: [uri(1), uri(2)] })
  assert.equal(state(r.content), 'confirmed')
  assert.match(r.content, /Song 1 by Artist 1: position 2 in the visible queue; new entry observed/)
  assert.match(r.content, /Song 2 by Artist 2: position 3 in the visible queue; new entry observed/)
  assert.match(r.content, /All 2 tracks were accepted/)
  assert.equal(queueCalls(calls).length, 2)
  assert.equal(calls.filter((c) => c.method === 'GET').length, 2, 'one baseline read and one follow-up read')
})

test('queue: accepted but not visible is not_observed, as in the earlier 0-of-3 test, and not an error', async () => {
  const { t } = queueSetup([], [])
  const r = await t.add_to_queue({ uris: [uri(1), uri(2), uri(3)] })
  assert.equal(r.isError, false)
  assert.equal(state(r.content), 'not_observed')
  assert.match(r.content, /All 3 tracks were accepted/)
  assert.match(r.content, /lists 0 of the 3/)
  assert.match(r.content, /does not mean they were not added/)
})

test('queue: a track already in the queue cannot be told apart, so the result is inconclusive', async () => {
  const { t } = queueSetup([1], [1])
  const r = await t.add_to_queue({ uris: [uri(1)] })
  assert.equal(state(r.content), 'inconclusive')
  assert.match(r.content, /already present before/)
})

test('queue: the same URI twice needs two new occurrences to count as confirmed', async () => {
  const both = await queueSetup([], [1, 1]).t.add_to_queue({ uris: [uri(1), uri(1)] })
  assert.equal(state(both.content), 'confirmed')
  const one = await queueSetup([], [1]).t.add_to_queue({ uris: [uri(1), uri(1)] })
  assert.equal(state(one.content), 'inconclusive')
})

test('queue: no baseline is stated, and a failed follow-up read is inconclusive; neither retries a write', async () => {
  const noBaseline = queueSetup('fail', [1])
  const r = await noBaseline.t.add_to_queue({ uris: [uri(1)] })
  assert.equal(state(r.content), 'inconclusive')
  assert.match(r.content, /no queue baseline could be read/)
  assert.match(r.content, /visible, but no baseline was read/)
  const noAfter = queueSetup([], 'fail')
  const f = await noAfter.t.add_to_queue({ uris: [uri(1)] })
  assert.equal(state(f.content), 'inconclusive')
  assert.match(f.content, /All 1 tracks were accepted/)
  for (const s of [noBaseline, noAfter]) assert.equal(queueCalls(s.calls).length, 1)
})

test('queue: nothing accepted means no verification and no follow-up read', async () => {
  const s = setup((c) => c.method === 'POST'
    ? json(404, { error: { message: 'No active device', reason: 'NO_ACTIVE_DEVICE' } })
    : json(200, { queue: [] }))
  seed(s.deps, 1)
  const r = await s.t.add_to_queue({ uris: [uri(1)] })
  assert.equal(r.isError, true)
  assert.notMatch(r.content, /verification:/)
  assert.equal(s.calls.filter((c) => c.method === 'GET').length, 1, 'only the baseline read')
  assert.equal(queueCalls(s.calls).length, 1)
})

test('queue: cancelled after the writes is not_checked, with no follow-up read', async () => {
  const controller = new AbortController()
  const s = setup((c) => {
    if (c.method === 'POST') { controller.abort(); return json(204) }
    return json(200, { queue: [] })
  })
  seed(s.deps, 1)
  const r = await tools({ ...s.deps, signal: controller.signal }).add_to_queue({ uris: [uri(1)] })
  assert.match(r.content, /All 1 tracks were accepted/)
  assert.equal(state(r.content), 'not_checked')
  assert.equal(s.calls.filter((c) => c.method === 'GET').length, 1, 'only the baseline read')
})

test('verifyQueue: pure checks of the status rules', () => {
  const a = uri(1), b = uri(2)
  assert.equal(verifyQueue([a], [], [a]).verification.state, 'confirmed')
  assert.equal(verifyQueue([a], [], []).verification.state, 'not_observed')
  assert.equal(verifyQueue([a, b], [], [a]).verification.state, 'inconclusive')
  assert.equal(verifyQueue([a], null, [a]).entries[0].status, 'visible_no_baseline')
  assert.deepEqual(verifyQueue([a], [b], [b, a]).entries[0].positions, [2])
})
