import { assert, test } from 'custard-plugin-sdk/testing'
import { json, seed, setup, uri } from './helpers'

test('queueing never starts, transfers or replaces playback', async () => {
  const { t, calls, deps } = setup((c) =>
    c.method === 'GET' ? json(200, { queue: [] }) : json(204)
  )
  seed(deps, 2)
  await t.add_to_queue({ uris: [uri(1), uri(2)] })
  assert(
    calls.every((c) => c.path === '/me/player/queue'),
    'only queue endpoints'
  )
})

test('read tools never change playback', async () => {
  const { t, calls } = setup((c) =>
    c.path === '/search' ? json(200, { tracks: { items: [] } }) : json(200, { devices: [] })
  )
  await t.search({ query: 'x' })
  await t.devices({})
  await t.now_playing({})
  assert(
    calls.every((c) => c.method === 'GET'),
    'only GET requests'
  )
})

test('opening Spotify opens only spotify: URIs and makes no API call', async () => {
  const { t, calls, ctx } = setup(() => json(204))
  assert.equal((await t.open({})).isError, false)
  assert.deepEqual(ctx.opened, ['spotify:'])
  assert.equal((await t.open({ uri: 'file:///C:/Windows/system32/calc.exe' })).isError, true)
  assert.equal(ctx.opened.length, 1)
  assert.equal(calls.length, 0)
})

test('transfer requires an explicit play choice', async () => {
  const { t, calls } = setup(() => json(204))
  assert.equal((await t.transfer_playback({ device_id: 'd1' })).isError, true)
  assert.equal(calls.length, 0)
})

test('transfer with play=false moves without starting playback', async () => {
  const { t, calls } = setup((c) =>
    c.method === 'GET'
      ? json(200, {
          devices: [
            { id: 'd1', name: 'Desk', type: 'Computer', is_active: false, is_restricted: false }
          ]
        })
      : json(204)
  )
  assert.equal((await t.transfer_playback({ device_id: 'd1', play: false })).isError, false)
  assert.deepEqual(calls.find((c) => c.method === 'PUT')?.body, { device_ids: ['d1'], play: false })
})

test('restricted or unknown devices are refused', async () => {
  const { t, calls } = setup(() =>
    json(200, {
      devices: [{ id: 'd1', name: 'TV', type: 'TV', is_active: false, is_restricted: true }]
    })
  )
  assert.equal((await t.transfer_playback({ device_id: 'd1', play: true })).isError, true)
  assert.equal((await t.transfer_playback({ device_id: 'nope', play: true })).isError, true)
  assert(!calls.some((c) => c.method === 'PUT'), 'no PUT')
})
