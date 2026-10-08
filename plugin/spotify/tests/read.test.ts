import { assert, test } from 'custard-plugin-sdk/testing'
import { json, makeTrack, setup, uri } from './helpers'

test('search returns real results and caps the limit at 10', async () => {
  const { t, calls, deps } = setup(() =>
    json(200, { tracks: { items: [makeTrack(1), makeTrack(2)] } })
  )
  const r = await t.search({ query: 'song', limit: 50 })
  assert.equal(r.isError, false)
  assert.match(r.content, /Song 1/)
  assert(r.content.includes(uri(2)), 'lists the URI')
  assert.equal(calls[0].query.get('limit'), '10')
  assert.equal(calls[0].query.get('type'), 'track')
  assert.equal(calls[0].init.auth, true, 'asks the host to add the token')
  assert.equal(deps.seen.get(uri(1)), 'Song 1 by Artist 1')
})

test('search says when nothing is found', async () => {
  const { t } = setup(() => json(200, { tracks: { items: [] } }))
  assert.match((await t.search({ query: 'zzz' })).content, /No Spotify tracks/)
})

test('now playing handles no active device (204)', async () => {
  const { t } = setup(() => json(204))
  assert.match((await t.now_playing({})).content, /Nothing is playing/)
})

test('now playing remembers the current track so it can be queued', async () => {
  const { t, deps } = setup(() =>
    json(200, {
      device: { id: 'd', name: 'Desk', type: 'Computer', is_active: true, is_restricted: false },
      is_playing: true,
      progress_ms: 1000,
      item: makeTrack(5)
    })
  )
  assert.match((await t.now_playing({})).content, /Song 5 by Artist 5/)
  assert(deps.seen.get(uri(5)), 'remembered')
})

test('devices lists none helpfully', async () => {
  const { t } = setup(() => json(200, { devices: [] }))
  assert.match((await t.devices({})).content, /spotify__open/)
})

test('a rate-limited read is retried once', async () => {
  let n = 0
  const { t, calls } = setup(() =>
    n++ === 0 ? json(429, {}, { 'Retry-After': '0' }) : json(200, { devices: [] })
  )
  await t.devices({})
  assert.equal(calls.length, 2)
})

test('an expired sign-in is explained', async () => {
  const { t } = setup(() =>
    json(401, { error: { status: 401, message: 'The access token expired' } })
  )
  const r = await t.devices({})
  assert.equal(r.isError, true)
  assert.match(r.content, /Connect Spotify again/)
})
