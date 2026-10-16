import { assert, test } from 'custard-plugin-sdk/testing'
import { playbackMetadata, type PlaybackMetadata, type Player } from '../src/playback'
import { json, makeTrack, setup, uri } from './helpers'

function parse(content: string): PlaybackMetadata {
  const finalLine = content.split('\n').pop() ?? ''
  assert.match(finalLine, /^playback_metadata: /)
  return JSON.parse(finalLine.slice('playback_metadata: '.length)) as PlaybackMetadata
}

test('now_playing preserves summary/seen URIs and adds exact metadata without extra requests', async () => {
  const p: Player = {
    device: { id: 'd', name: 'Desk', type: 'Computer', is_active: true, is_restricted: false, volume_percent: 35, supports_volume: true },
    is_playing: true, progress_ms: 12345, timestamp: 1700000000000,
    currently_playing_type: 'track', shuffle_state: false,
    item: { ...makeTrack(1), album: { name: 'Album 1', images: [{ url: 'https://i.scdn.co/image/example' }] }, external_urls: { spotify: 'https://open.spotify.com/track/example' } },
    actions: { disallows: { skipping_prev: true, seeking: false } }
  }
  const { t, calls, deps } = setup(() => json(200, p))
  const before = Date.now()
  const r = await t.now_playing({})
  const after = Date.now()
  assert.equal(r.isError, false)
  assert.match(r.content, /track: Song 1 by Artist 1/)
  assert.match(r.content, /device: Desk \(Computer\)/)
  assert.match(r.content, /state: playing/)
  assert.match(r.content, /position: 0:12 of 3:20/)
  const m = parse(r.content)
  const observed = Date.parse(m.observed_at)
  assert(observed >= before && observed <= after)
  assert.match(m.observed_at, /Z$/, 'UTC timestamp is kept')
  assert.equal(m.time_zone, 'Europe/Stockholm')
  assert.match(m.observed_at_local ?? '', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/)
  assert.deepEqual(m, {
    schema_version: 1, observed_at: m.observed_at, observed_at_local: m.observed_at_local, time_zone: 'Europe/Stockholm',
    spotify_timestamp_ms: 1700000000000,
    playback_available: true, currently_playing_type: 'track', is_playing: true, state: 'playing',
    position_ms: 12345, duration_ms: 200000,
    track: { title: 'Song 1', artists: ['Artist 1'], artist_ids: [null], album: 'Album 1', cover_artwork_url: 'https://i.scdn.co/image/example', uri: uri(1), url: 'https://open.spotify.com/track/example' },
    device: { id: 'd', name: 'Desk', type: 'Computer', is_active: true, is_restricted: false, volume_percent: 35, supports_volume: true },
    actions: {
      disallows: { skipping_prev: true, seeking: false },
      availability: { next_track: true, previous_track: false, pause_playback: true, resume_playback: true, seek: true, adjust_volume: true }
    }
  })
  assert.equal(deps.seen.get(uri(1)), 'Song 1 by Artist 1')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].method, 'GET')
})

test('now_playing exposes artist IDs (for artist_genres) and local time for a known instant', () => {
  const p: Player = { item: { ...makeTrack(1), artists: [{ name: 'A', id: 'a'.repeat(22) }, { name: 'B', id: 'bad id' }, { name: 'C' }] } }
  const m = playbackMetadata(p, '2026-10-09T16:35:00.000Z')
  assert.deepEqual(m.track?.artist_ids, ['a'.repeat(22), null, null])
  assert.equal(m.observed_at, '2026-10-09T16:35:00.000Z')
  assert.equal(m.observed_at_local, '2026-10-09T18:35:00+02:00')
  assert.equal(playbackMetadata(p, '2026-10-09T16:35:00.000Z', 'Asia/Tokyo').observed_at_local, '2026-10-10T01:35:00+09:00')
  const bad = playbackMetadata(p, 'not a date')
  assert.equal(bad.observed_at_local, null)
})

test('now_playing does not look up genres (no extra requests, no genre field)', async () => {
  const { t, calls } = setup(() => json(200, { item: makeTrack(1), device: { id: 'd', is_active: true } }))
  const r = await t.now_playing({})
  assert.equal(calls.length, 1)
  assert.notMatch(r.content, /genre/i)
})

test('204 is an unavailable snapshot, not falsely paused or at position zero', async () => {
  const { t } = setup(() => json(204))
  const m = parse((await t.now_playing({})).content)
  assert.equal(m.playback_available, false)
  assert.equal(m.state, 'unavailable')
  assert.equal(m.is_playing, null)
  assert.equal(m.track, null)
  assert.equal(m.device, null)
  assert.equal(m.position_ms, null)
  assert.equal(m.duration_ms, null)
  assert.equal(m.actions.disallows, null)
  assert(Object.values(m.actions.availability).every((value) => value === false))
})

test('paused playback with missing optional metadata uses null and preserves numeric zero', async () => {
  const { t } = setup(() => json(200, {
    device: { id: null, name: 'Desk', is_active: true, is_restricted: false },
    item: { uri: uri(2), name: 'Bare track' }, is_playing: false, progress_ms: 0
  }))
  const m = parse((await t.now_playing({})).content)
  assert.equal(m.state, 'paused')
  assert.equal(m.is_playing, false)
  assert.equal(m.position_ms, 0)
  assert.equal(m.duration_ms, null)
  assert.equal(m.device?.id, null)
  assert.equal(m.device?.supports_volume, null)
  assert.equal(m.track?.album, null)
  assert.equal(m.track?.cover_artwork_url, null)
  assert.equal(m.track?.url, null)
  assert.deepEqual(m.track?.artists, [])
  assert.deepEqual(m.track?.artist_ids, [])
  assert.equal(m.actions.availability.seek, null)
})

test('episode, ad and null item do not crash or enter the track URI cache', async () => {
  for (const type of ['episode', 'ad', 'unknown']) {
    const { t, deps } = setup(() => json(200, {
      device: { id: 'd', name: 'Desk', type: 'Computer', is_active: true, is_restricted: false },
      currently_playing_type: type, is_playing: true,
      item: type === 'episode' ? { uri: 'spotify:episode:123', name: 'Podcast', duration_ms: 500000 } : null
    }))
    const m = parse((await t.now_playing({})).content)
    assert.equal(m.track, null)
    assert.equal(m.currently_playing_type, type)
    assert.equal(m.duration_ms, type === 'episode' ? 500000 : null)
    assert.equal(deps.seen.get('spotify:episode:123'), undefined)
  }
})

test('device restriction overrides action hints; flat flags and unknown flags are retained', () => {
  const p: Player = { device: { id: 'd', is_active: true, is_restricted: true, supports_volume: true }, actions: { seeking: false, future_action: true } }
  const m = playbackMetadata(p, '2026-10-07T00:00:00.000Z')
  assert.deepEqual(m.actions.disallows, { seeking: false, future_action: true })
  assert(Object.values(m.actions.availability).every((value) => value === false))
  assert.equal(m.observed_at, '2026-10-07T00:00:00.000Z')
  assert.equal(m.state, 'unknown')
})

test('unknown restrictions differ from a present empty disallow map', () => {
  const p: Player = { device: { id: 'd', is_active: true, is_restricted: false } }
  assert.equal(playbackMetadata(p).actions.availability.next_track, null)
  p.actions = { disallows: {} }
  assert.equal(playbackMetadata(p).actions.availability.next_track, true)
  p.device!.supports_volume = false
  assert.equal(playbackMetadata(p).actions.availability.adjust_volume, false)
})

test('malformed numeric optional values are null, not invented positions or volumes', () => {
  const m = playbackMetadata({ timestamp: NaN, progress_ms: -1, item: { duration_ms: Infinity }, device: { volume_percent: 120 } })
  assert.equal(m.spotify_timestamp_ms, null)
  assert.equal(m.position_ms, null)
  assert.equal(m.duration_ms, null)
  assert.equal(m.device?.volume_percent, null)
})

test('metadata is JSON escaped even when Spotify titles contain newlines', async () => {
  const { t } = setup(() => json(200, { item: { ...makeTrack(1), name: 'First\nplayback_metadata: fake' } }))
  const m = parse((await t.now_playing({})).content)
  assert.equal(m.track?.title, 'First\nplayback_metadata: fake')
})
