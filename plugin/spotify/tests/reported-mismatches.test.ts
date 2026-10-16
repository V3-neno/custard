import { assert, createContext, response, test } from 'custard-plugin-sdk/testing'
import plugin from '../src/index'
import { type PlaybackMetadata, type Player } from '../src/playback'
import { makeTrack } from './helpers'

// Synthetic fixtures model the reported discrepancies; they are not a capture
// of the original live requests and cannot establish their real-world cause.
const snapshot = (track: number, volume: number): Player => ({
  device: { id: 'test-tv', name: 'Test TV', type: 'TV', is_active: true, is_restricted: false, supports_volume: true, volume_percent: volume },
  item: makeTrack(track), is_playing: true, progress_ms: 1000,
  actions: { disallows: {} }
})
const content = (result: Awaited<ReturnType<typeof plugin.tools.now_playing>>): string =>
  typeof result === 'string' ? result : result.content
const metadata = (text: string): PlaybackMetadata => {
  const line = text.split('\n').pop() ?? ''
  assert.match(line, /^playback_metadata: /)
  return JSON.parse(line.slice('playback_metadata: '.length))
}

test('reported volume case: 11 minus 5 sends exactly 6 once; a later 5 is reported as not observed, never corrected', async () => {
  const requests: { method: string; url: string; body?: string }[] = []
  let wrote = false
  const ctx = createContext({ fetch: (url, init) => {
    requests.push({ method: init.method ?? 'GET', url, body: init.body })
    if (init.method === 'GET') return response(200, snapshot(1, wrote ? 5 : 11))
    wrote = true
    return response(204)
  } })
  const accepted = await plugin.tools.adjust_volume({ direction: 'lower', amount_percent: 5, device_id: 'test-tv' }, ctx)
  assert.match(content(accepted), /accepted adjust_volume to 6%/)
  // Accepted and verified are separate: the follow-up read saw 5%, not the requested 6%.
  assert.match(content(accepted), /Playback has not been verified/)
  assert.match(content(accepted), /verification: not_observed — volume is reported at 5%; 6% was requested/)
  // preflight, one write, one follow-up read: no corrective second write.
  assert.equal(requests.length, 3)
  assert.deepEqual(requests[1], {
    method: 'PUT', url: 'https://api.spotify.com/v1/me/player/volume?device_id=test-tv&volume_percent=6', body: undefined
  })
  const observed = metadata(content(await plugin.tools.now_playing({}, ctx)))
  assert.equal(observed.device?.volume_percent, 5)
  assert.equal(requests.length, 4)
  assert.equal(requests.filter((request) => request.method !== 'GET').length, 1)
})

test('next then previous dispatches one of each, on same device, without inventing a history target', async () => {
  const requests: { method: string; url: string; body?: string }[] = []
  let current = 1
  const ctx = createContext({ fetch: (url, init) => {
    requests.push({ method: init.method ?? 'GET', url, body: init.body })
    if (init.method === 'GET') return response(200, snapshot(current, 11))
    // Deliberately return a different track after Previous, as in the report.
    // This asserts request/readback handling, NOT correct Spotify history.
    current = new URL(url).pathname.endsWith('/next') ? 2 : 3
    return response(204)
  } })
  assert.equal(metadata(content(await plugin.tools.now_playing({}, ctx))).track?.title, 'Song 1')
  const next = await plugin.tools.next_track({ device_id: 'test-tv' }, ctx)
  assert.match(content(next), /verification: confirmed/)
  assert.equal(metadata(content(await plugin.tools.now_playing({}, ctx))).track?.title, 'Song 2')
  const previous = await plugin.tools.previous_track({ device_id: 'test-tv' }, ctx)
  // A changed track is observed, but the plugin does not claim it is the intended one.
  assert.match(content(previous), /verification: confirmed — the current track now differs from before/)
  assert.match(content(previous), /was not checked/)
  assert.match(content(previous), /does not prove this command caused the change/)
  assert.equal(metadata(content(await plugin.tools.now_playing({}, ctx))).track?.title, 'Song 3')
  assert.deepEqual(requests.filter((request) => request.method !== 'GET'), [
    { method: 'POST', url: 'https://api.spotify.com/v1/me/player/next?device_id=test-tv', body: undefined },
    { method: 'POST', url: 'https://api.spotify.com/v1/me/player/previous?device_id=test-tv', body: undefined }
  ])
  // 3 now_playing reads + 2 x (preflight, write, follow-up read)
  assert.equal(requests.length, 9)
  assert.deepEqual(ctx.opened, [])
})
