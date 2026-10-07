import { assert, createContext, response, test } from 'custard-plugin-sdk/testing'
import plugin from '../src/index'
import { readinessTimeout, sleep, waitForDevices, type WaitRuntime } from '../src/readiness'

const device = { id: 'desk', name: 'Desk', type: 'Computer', is_active: false, is_restricted: false }
function clock(): WaitRuntime & { sleeps: number[] } {
  let now = 0
  const sleeps: number[] = []
  return { now: () => now, sleeps, sleep: async (ms, signal) => {
    if (signal.aborted) throw new Error('cancelled')
    sleeps.push(ms)
    now += ms
  } }
}
async function failure(run: () => Promise<unknown>): Promise<string> {
  try { await run() } catch (err) { return err instanceof Error ? err.message : String(err) }
  throw new Error('Expected failure')
}

test('ready immediately: one read and no polling delay', async () => {
  const ctx = createContext({ fetch: () => response(200, { devices: [device] }) })
  const time = clock()
  assert.deepEqual(await waitForDevices(ctx, {}, 30000, time), [device])
  assert.equal(ctx.calls.length, 1)
  assert.equal(time.sleeps.length, 0)
  assert.equal(ctx.opened.length, 0)
})

test('startup waits for readiness then returns without using remaining budget', async () => {
  let reads = 0
  const ctx = createContext({ fetch: () => response(200, { devices: ++reads < 3 ? [] : [device] }) })
  const time = clock()
  assert.equal((await waitForDevices(ctx, {}, 30000, time))[0].id, 'desk')
  assert.equal(reads, 3)
  assert.deepEqual(time.sleeps, [1000, 1000])
  assert(ctx.calls.every((c) => c.init?.method === 'GET'))
})

test('empty devices time out within the shared budget', async () => {
  const ctx = createContext({ fetch: () => response(200, { devices: [] }) })
  const time = clock()
  assert.match(await failure(() => waitForDevices(ctx, {}, 2500, time)), /within 2.5 seconds/)
  assert.deepEqual(time.sleeps, [1000, 1000, 500])
  assert.equal(ctx.calls.length, 3)
})

test('restricted, missing-ID, wrong type and wrong target devices are not ready', async () => {
  const ctx = createContext({ fetch: () => response(200, { devices: [
    { ...device, is_restricted: true }, { ...device, id: null },
    { ...device, id: 'phone', type: 'Smartphone' }, { ...device, id: 'other' }
  ] }) })
  assert.match(await failure(() => waitForDevices(ctx,
    { computerOnly: true, deviceId: 'desk' }, 1000, clock())), /did not expose/)
})

test('active-only waits until target becomes active', async () => {
  let reads = 0
  const ctx = createContext({ fetch: () => response(200, {
    devices: [{ ...device, is_active: ++reads === 2 }]
  }) })
  const result = await waitForDevices(ctx, { deviceId: 'desk', activeOnly: true }, 30000, clock())
  assert.equal(reads, 2)
  assert.equal(result[0].is_active, true)
})

test('transient network and server failures recover by retrying reads only', async () => {
  let reads = 0
  const ctx = createContext({ fetch: () => {
    reads++
    if (reads === 1) throw new Error('temporary network failure')
    if (reads === 2) return response(503, {})
    return response(200, { devices: [device] })
  } })
  await waitForDevices(ctx, {}, 30000, clock())
  assert.equal(reads, 3)
})

test('auth, permissions and rate limits fail without repeated polling', async () => {
  for (const status of [401, 403, 429]) {
    const ctx = createContext({ fetch: () => response(status, { error: { message: 'refused' } }) })
    const time = clock()
    await failure(() => waitForDevices(ctx, {}, 30000, time))
    assert.equal(ctx.calls.length, 1)
    assert.equal(time.sleeps.length, 0)
  }
})

test('already cancelled wait makes no request', async () => {
  const controller = new AbortController()
  controller.abort()
  const ctx = createContext({ fetch: () => response(200, { devices: [device] }) })
  assert.match(await failure(() => waitForDevices({ ...ctx, signal: controller.signal })), /cancelled/)
  assert.equal(ctx.calls.length, 0)
})

test('cancellation during a pending response returns promptly and never polls again', async () => {
  const controller = new AbortController()
  let finish!: (value: ReturnType<typeof response>) => void
  const ctx = createContext({ fetch: () => new Promise((resolve) => { finish = resolve }) })
  const pending = failure(() => waitForDevices({ ...ctx, signal: controller.signal }))
  controller.abort()
  assert.match(await pending, /cancelled/)
  finish(response(200, { devices: [] }))
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(ctx.calls.length, 1)
})

test('a hung HTTP read is bounded by the readiness deadline', async () => {
  let finish!: (value: ReturnType<typeof response>) => void
  const ctx = createContext({ fetch: () => new Promise((resolve) => { finish = resolve }) })
  assert.match(await failure(() => waitForDevices(ctx, {}, 10)), /did not expose/)
  finish(response(200, { devices: [] }))
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(ctx.calls.length, 1)
})

test('sleep is cancellable', async () => {
  const controller = new AbortController()
  const pending = failure(() => sleep(30000, controller.signal))
  controller.abort()
  assert.match(await pending, /cancelled/)
})

test('readiness config defaults and clamps to host-safe bounds', () => {
  assert.equal(readinessTimeout({ config: {} }), 30000)
  assert.equal(readinessTimeout({ config: { deviceReadyTimeoutSeconds: 12 } }), 12000)
  assert.equal(readinessTimeout({ config: { deviceReadyTimeoutSeconds: 120 } }), 50000)
  assert.equal(readinessTimeout({ config: { deviceReadyTimeoutSeconds: -1 } }), 1000)
  assert.equal(readinessTimeout({ config: { deviceReadyTimeoutSeconds: NaN } }), 30000)
})

test('open-and-wait launches once, reports readiness, and never writes playback', async () => {
  const ctx = createContext({ fetch: () => {
    assert.deepEqual(ctx.opened, ['spotify:'])
    return response(200, { devices: [device] })
  } })
  const result = await plugin.tools.open({ wait_for_device: true }, ctx)
  assert(typeof result !== 'string')
  if (typeof result === 'string') return
  assert.equal(result.isError, false)
  assert.match(result.content, /id: desk/)
  assert.match(result.content, /inactive/)
  assert.equal(ctx.calls.length, 1)
  assert.equal(ctx.calls[0].init?.method, 'GET')
})

test('plain open has no readiness API dependency', async () => {
  const ctx = createContext({ fetch: () => { throw new Error('must not fetch') } })
  await plugin.tools.open({}, ctx)
  assert.deepEqual(ctx.opened, ['spotify:'])
  assert.equal(ctx.calls.length, 0)
})

test('failed launch does not poll and invalid URI does not launch', async () => {
  const ctx = createContext({ fetch: () => { throw new Error('must not fetch') } })
  const result = await plugin.tools.open({ wait_for_device: true }, {
    ...ctx, openExternal: async () => { throw new Error('no app') }
  })
  assert(typeof result !== 'string' && result.isError)
  await plugin.tools.open({ uri: 'https://example.com', wait_for_device: true }, ctx)
  assert.equal(ctx.calls.length, 0)
  assert.equal(ctx.opened.length, 0)
})

test('readiness failure preserves the accepted launch outcome', async () => {
  const ctx = createContext({ fetch: () => response(401, {}) })
  const result = await plugin.tools.open({ wait_for_device: true }, ctx)
  assert(typeof result !== 'string')
  if (typeof result === 'string') return
  assert.equal(result.isError, true)
  assert.match(result.content, /Asked the system to open/)
  assert.match(result.content, /Readiness not confirmed/)
  assert.match(result.content, /sign-in/)
  assert.equal(ctx.opened.length, 1)
})

test('standalone readiness is read-only and supports device filtering', async () => {
  const ctx = createContext({ fetch: () => response(200, {
    devices: [device, { ...device, id: 'phone', type: 'Smartphone' }]
  }) })
  const result = await plugin.tools.wait_for_device({ device_id: 'phone' }, ctx)
  assert(typeof result !== 'string')
  if (typeof result === 'string') return
  assert.equal(result.isError, false)
  assert.match(result.content, /id: phone/)
  assert.notMatch(result.content, /id: desk/)
  assert.equal(ctx.opened.length, 0)
  assert.equal(ctx.calls.length, 1)
})
