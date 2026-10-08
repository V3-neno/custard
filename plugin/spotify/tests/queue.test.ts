import type { PluginResponse } from 'custard-plugin-sdk'
import { assert, test } from 'custard-plugin-sdk/testing'
import { id, json, queueCalls, seed, setup, uri } from './helpers'

const queueBack = (uris: string[]): PluginResponse =>
  json(200, { queue: uris.map((u) => ({ uri: u })) })

test('malformed URIs are rejected without calling Spotify', async () => {
  const { t, calls } = setup(() => json(204))
  const r = await t.add_to_queue({
    uris: ['spotify:album:' + id(1), 'https://open.spotify.com/track/x']
  })
  assert.equal(r.isError, true)
  assert.match(r.content, /Nothing was queued/)
  assert.equal(calls.length, 0)
})

test('well-formed URIs that never came from a search are rejected', async () => {
  const { t, calls, deps } = setup(() => json(204))
  seed(deps, 1)
  const r = await t.add_to_queue({ uris: [uri(1), uri(9)] })
  assert.equal(r.isError, true)
  assert(r.content.includes(uri(9)), 'names the unknown URI')
  assert.equal(calls.length, 0)
})

test('more than 10 tracks are refused', async () => {
  const { t } = setup(() => json(204))
  assert.equal(
    (await t.add_to_queue({ uris: Array.from({ length: 11 }, (_, i) => uri(i)) })).isError,
    true
  )
})

test('queues in order, one call per track, and reads the queue back', async () => {
  const { t, calls, deps } = setup((c) =>
    c.method === 'POST' ? json(204) : queueBack([uri(1), uri(2), uri(3)])
  )
  seed(deps, 3)
  const r = await t.add_to_queue({ uris: [uri(1), uri(2), uri(3)] })
  assert.equal(r.isError, false)
  assert.deepEqual(
    queueCalls(calls).map((c) => c.query.get('uri')),
    [uri(1), uri(2), uri(3)]
  )
  assert.match(r.content, /All 3 tracks were accepted/)
  assert.match(r.content, /lists 3 of the 3/)
  assert.match(r.content, /not playing/)
})

test('partial success when one track is rejected', async () => {
  const { t, deps } = setup((c) => {
    if (c.method === 'GET') return queueBack([uri(1), uri(3)])
    return c.query.get('uri') === uri(2)
      ? json(400, { error: { status: 400, message: 'Invalid track uri' } })
      : json(204)
  })
  seed(deps, 3)
  const r = await t.add_to_queue({ uris: [uri(1), uri(2), uri(3)] })
  assert.equal(r.isError, false)
  assert.match(r.content, /2 of 3 tracks were accepted/)
  assert.match(r.content, /2\. Song 2 by Artist 2: not added/)
})

test('no active device stops the run and marks the rest not attempted', async () => {
  const { t, calls, deps } = setup(() =>
    json(404, {
      error: {
        status: 404,
        message: 'Player command failed: No active device found',
        reason: 'NO_ACTIVE_DEVICE'
      }
    })
  )
  seed(deps, 3)
  const r = await t.add_to_queue({ uris: [uri(1), uri(2), uri(3)] })
  assert.equal(r.isError, true)
  assert.equal(queueCalls(calls).length, 1)
  assert.match(r.content, /No active Spotify device/)
  assert.match(r.content, /3\. Song 3 by Artist 3: not attempted/)
  assert.match(r.content, /0 of 3/)
})

test('Premium required stops without retrying', async () => {
  const { t, calls, deps } = setup(() =>
    json(403, {
      error: {
        status: 403,
        message: 'Player command failed: Premium required',
        reason: 'PREMIUM_REQUIRED'
      }
    })
  )
  seed(deps, 2)
  const r = await t.add_to_queue({ uris: [uri(1), uri(2)] })
  assert.equal(queueCalls(calls).length, 1)
  assert.match(r.content, /Premium/)
})

test('a rate-limited queue call is never retried (it could add the song twice)', async () => {
  const { t, calls, deps } = setup(() =>
    json(
      429,
      { error: { status: 429, message: 'API rate limit exceeded' } },
      { 'Retry-After': '0' }
    )
  )
  seed(deps, 2)
  const r = await t.add_to_queue({ uris: [uri(1), uri(2)] })
  assert.equal(queueCalls(calls).length, 1)
  assert.match(r.content, /rate limit/)
})

test('a server error is unknown and stops, without retrying', async () => {
  const { t, calls, deps } = setup((c) =>
    c.method === 'GET'
      ? queueBack([uri(1)])
      : c.query.get('uri') === uri(2)
        ? json(502, {})
        : json(204)
  )
  seed(deps, 3)
  const r = await t.add_to_queue({ uris: [uri(1), uri(2), uri(3)] })
  assert.equal(queueCalls(calls).length, 2)
  assert.match(r.content, /2\. Song 2 by Artist 2: unknown/)
  assert.match(r.content, /3\. Song 3 by Artist 3: not attempted/)
  assert.match(r.content, /1 of 3/)
})

test('a dropped connection is unknown and stops', async () => {
  const { t, calls, deps } = setup((c) => {
    if (c.query.get('uri') === uri(1)) throw new Error('network down')
    return json(204)
  })
  seed(deps, 2)
  const r = await t.add_to_queue({ uris: [uri(1), uri(2)] })
  assert.equal(queueCalls(calls).length, 1)
  assert.match(r.content, /1\. Song 1 by Artist 1: unknown/)
  assert.match(r.content, /2\. Song 2 by Artist 2: not attempted/)
})
