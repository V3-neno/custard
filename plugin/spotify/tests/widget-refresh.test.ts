import { assert, test } from 'custard-plugin-sdk/testing'
import type { WidgetCallResult } from 'custard-plugin-sdk/widget'
import { fromMetadata, type Snapshot } from '../src/widget-data'
import { availabilityNotice, refreshDisabled } from '../widget/availability'
import { PlayerController, STALE_MS } from '../widget/controller'
import { createPlayerWidget } from '../widget/player'
import { context, deferred, flush, rootDouble, snapshot } from './widget-support'

const absent = (): Snapshot => fromMetadata({ observed_at: new Date(1000000).toISOString(), state: 'unavailable', device: null, track: null })

test('no-active state is explicit; Refresh reads once, shows checking and recovers without writes', async () => {
  const t = context(), d = rootDouble(), w = createPlayerWidget(t.clock)
  t.respond(async () => ({ status: 'completed', content: 'No playback', data: absent() }))
  w.mount(d.root, t.ctx)
  assert.equal(t.calls.length, 0)
  assert(d.element.find('Refresh').disabled)
  t.ctx.visible = true; w.visibility!(true, t.ctx); await flush()
  assert(d.element.find('No active Spotify device'))
  assert(d.element.find('No active Spotify device. Start playback in Spotify, then Refresh.'))
  assert(d.element.find('Resume').disabled)
  const button = d.element.find('Refresh')
  assert(!button.disabled)
  const gate = deferred<WidgetCallResult>(); t.respond(() => gate.promise)
  button.emit('click'); button.emit('click')
  assert.equal(t.calls.length, 2)
  assert(button.disabled); assert.equal(button.textContent, 'Checking…')
  assert(d.element.find('Checking Spotify…'))
  await w.refresh!(t.ctx); assert.equal(t.calls.length, 2)
  gate.resolve({ status: 'completed', content: '', data: snapshot() }); await flush()
  assert(d.element.find('Song')); assert(!d.element.find('Pause').disabled)
  assert.equal(button.textContent, 'Refresh'); assert(!button.disabled)
  assert.equal(d.element.find('No active Spotify device'), undefined)
  assert(t.calls.every((call) => call.tool === 'now_playing'))
  w.unmount!(t.ctx)
  button.emit('click'); assert.equal(t.calls.length, 2)
})

test('manual refresh remains possible for stale/failed reads, but respects hidden/pending locks', async () => {
  const t = context(); t.ctx.visible = true
  const c = new PlayerController(t.ctx, () => {}, t.clock); c.visible = true
  await c.read(); t.advance(STALE_MS + 1)
  assert(!refreshDisabled(c)); assert.match(availabilityNotice(c), /stale/)
  t.respond(async () => ({ status: 'failed', content: 'private technical failure' }))
  await c.read()
  assert(!refreshDisabled(c)); assert.equal(availabilityNotice(c), 'Could not refresh playback. Try Refresh.')
  c.pending = true; assert(refreshDisabled(c)); await c.read(); assert.equal(t.calls.length, 2)
  c.pending = false; t.ctx.visible = false; c.setVisible(false)
  assert(refreshDisabled(c)); await c.read(); assert.equal(t.calls.length, 2)
  c.dispose(); assert(refreshDisabled(c))
})

test('manual refresh cannot bypass rate limits or erase unknown action outcomes', async () => {
  const t = context(); t.ctx.visible = true
  const c = new PlayerController(t.ctx, () => {}, t.clock); c.visible = true
  t.respond(async () => ({ status: 'failed', content: 'Spotify rate limit. Retry-After: 120 seconds.' }))
  await c.read(); await c.read(); await c.read()
  assert.equal(t.calls.length, 1)
  assert.equal(availabilityNotice(c), 'Spotify rate limited — wait before refreshing.')
  c.actionMessage = 'Outcome unknown: command may have acted'
  assert.match(availabilityNotice(c), /Result unknown/)
  t.advance(120001)
  t.respond(async () => ({ status: 'completed', content: '', data: snapshot(t.clock()) }))
  await c.read(); assert.equal(t.calls.length, 2)
  assert.match(availabilityNotice(c), /Result unknown/)
  c.dispose()
})

test('missing device ID, inactive and unavailable snapshots never imply an active device', () => {
  const t = context(); t.ctx.visible = true
  const c = new PlayerController(t.ctx, () => {}, t.clock); c.visible = true
  for (const patch of [{ active: false }, { deviceId: null }, { state: 'unavailable' as const }]) {
    c.snapshot = { ...snapshot(), ...patch }
    assert.match(availabilityNotice(c), /No active Spotify device/)
  }
  c.snapshot = { ...snapshot(), state: 'unknown' }
  assert.match(availabilityNotice(c), /state unknown/)
  c.dispose()
})
