import { assert, test } from 'custard-plugin-sdk/testing'
import type { WidgetCallResult } from 'custard-plugin-sdk/widget'
import { fromMetadata, readSnapshot, type Snapshot } from '../src/widget-data'
import { actionNotice, PlayerController, STALE_MS } from '../widget/controller'
import { createPlayerWidget } from '../widget/player'
import { context, deferred, flush, rootDouble, snapshot } from './widget-support'

const volumeSnapshot = (volume = 50): Snapshot => ({ ...snapshot(), volume, volumeSupported: true })

test('volume data is validated without inventing zero or support', () => {
  for (const value of [0, 50, 100]) {
    const s = fromMetadata({ device: { volume_percent: value, supports_volume: true } })
    assert.equal(s.volume, value); assert.equal(s.volumeSupported, true)
    assert.equal(readSnapshot({ ...snapshot(), volume: value, volumeSupported: true })!.volume, value)
  }
  for (const value of [undefined, null, -1, 101, '50', NaN, 1.2]) {
    assert.equal(fromMetadata({ device: { volume_percent: value } }).volume, null)
    const s = readSnapshot({ ...snapshot(), volume: value, volumeSupported: 'true' })!
    assert.equal(s.volume, null); assert.equal(s.volumeSupported, false)
  }
})

test('volume buttons synchronously use existing relative action, guard device and display observed volume', async () => {
  const t = context(), d = rootDouble(), w = createPlayerWidget(t.clock)
  t.respond(async (tool) => tool === 'now_playing' ? { status: 'completed', content: '', data: volumeSnapshot() } : { status: 'completed', content: 'Spotify accepted volume' })
  w.mount(d.root, t.ctx); t.ctx.visible = true; w.visibility!(true, t.ctx); await flush()
  assert(d.element.find('Volume 50%'))
  d.element.find('−').emit('click')
  assert.deepEqual(t.calls[1], { tool: 'adjust_volume', input: { device_id: 'device-1', direction: 'lower', amount_percent: 5 } })
  await flush()
  // No optimistic 45%; the mock's fresh observation still reports 50.
  assert(d.element.find('Volume 50%'))
  d.element.find('+').emit('click')
  assert.deepEqual(t.calls[3], { tool: 'adjust_volume', input: { device_id: 'device-1', direction: 'raise', amount_percent: 5 } })
  await flush(); w.unmount!(t.ctx)
})

test('volume is disabled for unknown support, stale/restricted/inactive/missing devices and limits', async () => {
  const t = context(); t.ctx.visible = true
  const c = new PlayerController(t.ctx, () => {}, t.clock); c.visible = true
  for (const patch of [{ volume: null }, { volumeSupported: false }, { volumeSupported: undefined }, { restricted: true }, { active: false }, { deviceId: null }]) {
    c.snapshot = { ...volumeSnapshot(), ...patch }
    assert(!c.can('adjust_volume')); await c.action('adjust_volume', -5)
  }
  c.snapshot = volumeSnapshot(0); await c.action('adjust_volume', -5)
  c.snapshot = volumeSnapshot(100); await c.action('adjust_volume', 5)
  c.snapshot = volumeSnapshot()
  for (const v of [undefined, NaN, 0, 101, -101, 1.5]) await c.action('adjust_volume', v)
  t.advance(STALE_MS + 1); assert(!c.can('adjust_volume'))
  assert.equal(t.calls.length, 0); c.dispose()
})

test('volume paused playback is allowed; uncertainty/decline/failure never retries or optimistically changes volume', async () => {
  for (const status of ['unknown', 'not-run', 'failed'] as const) {
    const t = context(); t.ctx.visible = true
    const c = new PlayerController(t.ctx, () => {}, t.clock); c.visible = true
    c.snapshot = { ...volumeSnapshot(), state: 'paused' }
    const gate = deferred<WidgetCallResult>()
    t.respond((tool) => tool === 'now_playing' ? Promise.resolve({ status: 'completed', content: '', data: volumeSnapshot() }) : gate.promise)
    const pending = c.action('adjust_volume', -5)
    assert(c.pending)
    await c.action('adjust_volume', -5); await c.action('seek', 1000)
    assert.equal(t.calls.length, 1)
    gate.resolve({ status, content: 'raw technical result' }); await pending
    assert.equal(t.calls.filter((call) => call.tool === 'adjust_volume').length, 1)
    assert.equal(t.calls.length, status === 'unknown' ? 2 : 1)
    assert.equal(c.snapshot!.volume, 50)
    assert.notMatch(c.displayNotice(), /raw technical/)
    c.dispose()
  }
})

test('seek drafts are discarded on pointer cancellation, blur, hide, or presentation change', async () => {
  for (const cancel of ['pointercancel', 'blur', 'hide', 'presentation']) {
    const t = context(), d = rootDouble(), w = createPlayerWidget(t.clock)
    w.mount(d.root, t.ctx); t.ctx.visible = true; w.visibility!(true, t.ctx); await flush()
    const range = d.element.all().find((e) => e.type === 'range')!
    range.value = '90000'; range.emit('input')
    if (cancel === 'hide') { t.ctx.visible = false; w.visibility!(false, t.ctx) }
    else if (cancel === 'presentation') w.presentation!('expanded', t.ctx)
    else range.emit(cancel)
    range.emit('change')
    assert.equal(t.calls.some((v) => v.tool === 'seek'), false)
    w.unmount!(t.ctx)
  }
})

test('observed device/track changes during dragging invalidate the seek draft', async () => {
  for (const patch of [{ deviceId: 'new-device' }, { trackUri: 'spotify:track:BBBBBBBBBBBBBBBBBBBBBB' }]) {
    const t = context(), d = rootDouble(), w = createPlayerWidget(t.clock)
    w.mount(d.root, t.ctx); t.ctx.visible = true; w.visibility!(true, t.ctx); await flush()
    const range = d.element.all().find((e) => e.type === 'range')!
    range.value = '90000'; range.emit('input')
    t.respond(async () => ({ status: 'completed', content: '', data: { ...snapshot(), ...patch } }))
    await w.refresh!(t.ctx)
    range.emit('change')
    assert.equal(t.calls.some((v) => v.tool === 'seek'), false)
    w.unmount!(t.ctx)
  }
})

test('status view omits success boilerplate but preserves concise unknown/refused/failure notices', () => {
  assert.equal(actionNotice('Completed tool call (not playback verification): Spotify accepted seek'), '')
  assert.match(actionNotice('Outcome unknown: timed out'), /check Spotify/)
  assert.equal(actionNotice('Not run: declined'), 'Action not run.')
  assert.match(actionNotice('Failed: Spotify rejected'), /Action failed/)
})
