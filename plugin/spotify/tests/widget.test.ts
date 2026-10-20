import { assert, createContext, response, test } from 'custard-plugin-sdk/testing'
import type { WidgetCallResult } from 'custard-plugin-sdk/widget'
import manifest from '../plugin.json'
import plugin from '../src/index'
import { fromMetadata, readSnapshot, withWidgetData } from '../src/widget-data'
import { BACK_REASON, HEIGHT, outcome, PlayerController, SEEK_WARNING, STALE_MS } from '../widget/controller'
import { createPlayerWidget } from '../widget/player'
import { context, deferred, flush, rootDouble, snapshot } from './widget-support'

test('widget registration uses v1, contextual discovery, bounded heights and least tools', () => {
  const spec = manifest.widgets[0]
  assert.equal(spec.id, 'player'); assert.equal(spec.widgetApi, 1)
  assert.deepEqual(spec.tools, ['now_playing', 'pause_playback', 'resume_playback', 'next_track', 'seek', 'adjust_volume'])
  assert(spec.refreshSeconds >= 15)
  for (const height of Object.values(HEIGHT)) assert(height >= spec.height.min && height <= spec.height.max && height <= 360)
  assert(spec.height.min >= 32)
  assert.deepEqual(spec.presentations, ['compact', 'expanded'])
  assert.deepEqual(spec.inputSchema.properties, {})
  assert.equal(spec.inputSchema.additionalProperties, false)
  // 1.6.0: storage holds only where background sync got to (src/sync.ts).
  assert.equal(manifest.permissions.storage, true)
  assert.deepEqual(manifest.permissions.network, ['api.spotify.com', 'accounts.spotify.com'])
  for (const name of spec.tools.filter((n) => n !== 'now_playing'))
    assert.equal(manifest.tools.find((t) => t.name === name)!.effect, 'write')
})

test('public now_playing returns bounded structured data and unchanged human-readable snapshot', async () => {
  const ctx = createContext({ fetch: () => response(200, {
    device: { id: 'd', name: 'Computer', is_active: true }, is_playing: true,
    currently_playing_type: 'track', progress_ms: 0, actions: { disallows: {} },
    item: { uri: 'spotify:track:AAAAAAAAAAAAAAAAAAAAAA', name: '<img onerror=evil()>',
      artists: [{ name: 'Artist' }], duration_ms: 10000,
      album: { name: 'Album', images: [{ url: 'https://i.scdn.co/image/example' }] } }
  }) })
  const result = await plugin.tools.now_playing({}, ctx)
  assert(typeof result !== 'string')
  if (typeof result === 'string') return
  assert.match(result.content, /track: <img onerror=evil\(\)> by Artist/)
  assert.match(result.content, /playback_metadata: /)
  const data = readSnapshot(result.data)!
  assert(data); assert.equal(data.position, 0)
  assert.equal(data.artwork.kind, 'fallback')
  assert.notMatch(JSON.stringify(data), /https:|config|token|Authorization/)
  assert(JSON.stringify(data).length * 4 < 60000)
  assert.equal(ctx.calls.length, 1)
  assert.equal(ctx.calls[0].init.method, 'GET')
})

test('structured adapter preserves text exactly and rejects malformed/missing metadata', () => {
  const metadata = { observed_at: new Date(1000000).toISOString(), state: 'paused' }
  const input = { content: `summary\nplayback_metadata: ${JSON.stringify(metadata)}`, isError: false }
  assert.equal(withWidgetData(input).content, input.content)
  assert(readSnapshot(withWidgetData(input).data))
  assert.equal(withWidgetData({ content: 'playback_metadata: {broken', isError: false }).data, undefined)
  assert.equal(withWidgetData({ ...input, isError: true }).data, undefined)
  assert.equal(readSnapshot({ schema: 2 }), null)
  assert.equal(readSnapshot({ ...snapshot(), duration: -1 }), null)
  assert.equal(readSnapshot({ ...snapshot(), actions: {} }), null)
})

test('missing, hostile, invalid and oversized artwork always use a local fallback with bounded metadata', () => {
  for (const url of [undefined, 'javascript:alert(1)', 'https://attacker.test/image', 'data:image/svg+xml,<svg onload=evil()>', 'x'.repeat(100000)]) {
    const s = fromMetadata({ observed_at: new Date(1000000).toISOString(), track: {
      title: 'x'.repeat(100000), artists: Array(100).fill('x'.repeat(10000)), cover_artwork_url: url
    } })
    assert.equal(s.artwork.kind, 'fallback')
    assert(JSON.stringify(s).length * 4 < 60000)
    const incoming = readSnapshot({ ...s, artwork: { kind: 'image', url } })!
    assert.equal(incoming.artwork.kind, 'fallback')
    assert.notMatch(JSON.stringify(incoming), /javascript:|https:|data:image/)
  }
})

test('hidden mount and restored mount are synchronous shells; visibility reads; update never writes', async () => {
  for (const restored of [false, true]) {
    const t = context(); t.ctx.restored = restored
    t.ctx.input = { title: '<script>evil()</script>', action: 'next_track' }
    const { root, element, doc } = rootDouble()
    const widget = createPlayerWidget(t.clock)
    assert.equal(widget.mount(root, t.ctx), undefined)
    assert.equal(t.calls.length, 0); assert.equal(doc.frames.size, 0)
    await widget.refresh!(t.ctx); await widget.update!(t.ctx.input, t.ctx)
    assert.equal(t.calls.length, 0)
    t.ctx.visible = true; widget.visibility!(true, t.ctx); await flush()
    assert.deepEqual(t.calls.map((c) => c.tool), ['now_playing'])
    assert(element.find('Song'))
    await widget.update!({ action: 'resume_playback' }, t.ctx)
    assert.equal(t.calls.length, 1)
    await widget.refresh!(t.ctx)
    assert.equal(t.calls.length, 2)
    widget.unmount!(t.ctx)
    assert.equal(doc.frames.size, 0)
  }
})

test('compact/expanded layouts retain safe metadata and tooltips without visible diagnostics or scrollbar', async () => {
  const t = context(), d = rootDouble()
  const s = snapshot(); s.title = '<img src=x onerror=evil()>'; s.artists = ['<script>evil()</script>']
  t.respond(async () => ({ status: 'completed', content: 'snapshot', data: s }))
  const w = createPlayerWidget(t.clock)
  w.mount(d.root, t.ctx)
  assert.equal(t.heights[0], 240)
  assert.equal(d.element.find('Restart').hidden, true)
  w.presentation!('expanded', t.ctx)
  assert.equal(t.heights.at(-1), 330)
  assert.equal(d.element.find('Restart').hidden, false)
  t.ctx.visible = true; w.visibility!(true, t.ctx); await flush()
  assert(d.element.find(s.title)); assert(d.element.find(s.artists[0]))
  assert.equal(d.element.all().some((e) => e.tagName === 'img' || e.tagName === 'script'), false)
  assert.equal(d.element.all().some((e) => /^(Close|Expand|Compact|Allow|Decline|Seek)$/.test(e.textContent)), false)
  const back = d.element.find('Back')
  assert(back.disabled); assert.equal(back.title, BACK_REASON)
  assert.equal(d.element.find(SEEK_WARNING).className, 'sr-only')
  assert.equal(d.element.find(BACK_REASON), undefined)
  const buttons = d.element.all().filter((e) => e.tagName === 'button')
  assert(buttons.every((e) => !!e.textContent || !!e.attributes['aria-label']))
  const css = d.element.all().find((e) => e.tagName === 'style')!.textContent
  assert.match(css, /:focus-visible/); assert.match(css, /scrollbar-width:none/)
  assert.match(css, /::-webkit-scrollbar\{display:none/)
  w.unmount!(t.ctx)
})

test('playing, paused, unavailable, restricted, unsupported and unknown states gate music actions', async () => {
  const t = context(); t.ctx.visible = true
  const c = new PlayerController(t.ctx, () => {}, t.clock); c.visible = true
  await c.read(); assert(c.can('pause_playback')); assert(!c.can('resume_playback'))
  c.snapshot = { ...snapshot(), state: 'paused' }
  assert(c.can('resume_playback')); assert(!c.can('pause_playback'))
  for (const patch of [{ state: 'unavailable' as const }, { state: 'unknown' as const }, { active: false }, { restricted: true }, { music: false }, { deviceId: null }, { trackUri: null }]) {
    c.snapshot = { ...snapshot(), ...patch }
    for (const tool of ['next_track', 'pause_playback', 'resume_playback', 'seek'] as const) assert(!c.can(tool))
  }
  c.snapshot = { ...snapshot(), actions: { next: false, pause: false, resume: false, seek: false } }
  assert(!c.can('next_track')); assert(!c.can('seek'))
  c.snapshot = snapshot(); t.advance(STALE_MS + 1)
  assert(c.stale()); assert(!c.can('next_track')); assert.match(c.stateLabel(), /Stale/)
  c.dispose()
})

test('seek refuses unknown duration, end, negative and fractional positions, and guards device', async () => {
  const t = context(); t.ctx.visible = true
  const c = new PlayerController(t.ctx, () => {}, t.clock); c.visible = true
  await c.read()
  for (const duration of [null, 0]) { c.snapshot = { ...snapshot(), duration }; assert(!c.can('seek')) }
  c.snapshot = snapshot()
  for (const position of [-1, 180000, 180001, NaN, 1.1]) await c.action('seek', position)
  assert.equal(t.calls.length, 1)
  await c.action('seek', 0)
  assert.deepEqual(t.calls[1], { tool: 'seek', input: { device_id: 'device-1', position_ms: 0 } })
  assert.deepEqual(t.calls.map((v) => v.tool), ['now_playing', 'seek', 'now_playing'])
  c.dispose()
})

test('range previews while dragging then commits once on change without a Seek button', async () => {
  const t = context(), d = rootDouble(), w = createPlayerWidget(t.clock)
  w.mount(d.root, t.ctx); t.ctx.visible = true; w.visibility!(true, t.ctx); await flush()
  const range = d.element.all().find((e) => e.type === 'range')!
  range.value = '90000'; range.emit('input'); range.emit('input')
  assert.equal(t.calls.length, 1)
  range.emit('change'); range.emit('change')
  assert.equal(t.calls[1].tool, 'seek')
  assert.equal(t.calls[1].input.position_ms, 90000)
  assert.equal(t.calls.filter((v) => v.tool === 'seek').length, 1)
  await flush()
  assert.equal(d.element.find('Seek'), undefined)
  assert.equal(d.element.all().some((e) => /Completed tool call|estimated progress|Snapshot only|Spotify accepted/.test(e.textContent)), false)
  w.presentation!('expanded', t.ctx)
  d.element.find('Restart').emit('click'); await flush()
  assert.equal(t.calls.filter((v) => v.tool === 'seek')[1].input.position_ms, 0)
  assert.equal(t.calls.some((v) => /previous|queue|transfer|open/.test(v.tool)), false)
  w.unmount!(t.ctx)
})

test('completed, declined, failed, uncertain and plugin-text outcomes get correct single-check handling', async () => {
  const cases: [WidgetCallResult, boolean][] = [
    [{ status: 'completed', content: 'Spotify accepted pause_playback. Playback has not been verified.' }, true],
    [{ status: 'not-run', content: 'Approval declined' }, false],
    [{ status: 'failed', content: 'Spotify rejected request' }, false],
    [{ status: 'unknown', content: 'Dispatch timed out' }, true],
    [{ status: 'failed', content: 'Outcome unknown: command was sent' }, true],
    [{ status: 'completed', content: 'Not run: active device changed' }, false]
  ]
  for (const [result, check] of cases) {
    const t = context(); t.ctx.visible = true
    const c = new PlayerController(t.ctx, () => {}, t.clock); c.visible = true
    await c.read()
    t.respond(async (tool) => tool === 'now_playing' ? { status: 'completed', content: 'snapshot', data: snapshot() } : result)
    await c.action('pause_playback')
    assert.equal(t.calls.filter((v) => v.tool === 'pause_playback').length, 1)
    assert.equal(t.calls.filter((v) => v.tool === 'now_playing').length, check ? 2 : 1)
    assert.equal(c.pending, false)
    assert(c.actionMessage.includes(result.content))
    assert.notMatch(c.displayNotice(), /Spotify accepted|Dispatch timed out|Spotify rejected|Completed tool call/)
    c.dispose()
  }
  assert.equal(outcome({ status: 'failed', content: 'Outcome unknown: server error' }), 'unknown')
})

test('pending approval locks repeated clicks; hide suppresses follow-up, never repeats a write', async () => {
  const t = context(); t.ctx.visible = true
  const c = new PlayerController(t.ctx, () => {}, t.clock); c.visible = true
  await c.read()
  const gate = deferred<WidgetCallResult>(); t.respond(() => gate.promise)
  const first = c.action('next_track')
  assert(c.pending); assert.match(c.stateLabel(), /Pending/)
  await c.action('next_track'); await c.action('pause_playback'); await c.read()
  assert.equal(t.calls.length, 2)
  t.ctx.visible = false; c.setVisible(false)
  gate.resolve({ status: 'unknown', content: 'Outcome unknown: timed out' }); await first
  assert.equal(t.calls.length, 2); assert.equal(c.pending, false)
  assert.match(c.actionMessage, /Outcome unknown/)
  c.dispose()
})

test('overlapping reads are suppressed and pre-hide responses discarded after quick re-show', async () => {
  const t = context(); t.ctx.visible = true
  const gate = deferred<WidgetCallResult>(); t.respond(() => gate.promise)
  const c = new PlayerController(t.ctx, () => {}, t.clock)
  c.setVisible(true)
  await c.read(); await c.read(); assert.equal(t.calls.length, 1)
  t.ctx.visible = false; c.setVisible(false)
  t.ctx.visible = true; c.setVisible(true)
  assert.equal(t.calls.length, 1)
  gate.resolve({ status: 'completed', content: 'old snapshot', data: snapshot() }); await flush()
  assert.equal(c.snapshot, null)
  t.respond(async () => ({ status: 'completed', content: 'fresh', data: { ...snapshot(), title: 'Fresh' } }))
  await c.read(); assert.equal(c.snapshot!.title, 'Fresh')
  c.dispose()
})

test('read errors keep old state explicitly stale; malformed or future data disables controls', async () => {
  const t = context(); t.ctx.visible = true
  const c = new PlayerController(t.ctx, () => {}, t.clock); c.visible = true; await c.read()
  for (const result of [
    { status: 'failed', content: 'Unavailable: sign-in expired' },
    { status: 'not-run', content: 'hidden' },
    { status: 'completed', content: 'bad data', data: {} },
    { status: 'completed', content: 'future timestamp', data: snapshot(t.clock() + 60000) }
  ] as WidgetCallResult[]) {
    t.respond(async () => result); await c.read()
    assert(c.stale()); assert(!c.can('next_track')); assert.equal(c.snapshot!.title, 'Song')
    assert.match(c.stateLabel(), /Stale/)
  }
  t.respond(async () => { throw new Error('bridge failed') }); await c.read()
  assert.match(c.readIssue, /failed/)
  c.dispose()
})

test('host-call budget caps at 24/min and provider Retry-After prevents foreground calls', async () => {
  const t = context(); t.ctx.visible = true
  const c = new PlayerController(t.ctx, () => {}, t.clock); c.visible = true
  for (let i = 0; i < 40; i++) await c.read()
  assert.equal(t.calls.length, 24); assert(!c.can('next_track'))
  t.advance(60001); await c.read(); assert.equal(t.calls.length, 25)
  t.respond(async () => ({ status: 'failed', content: 'Spotify rate limit reached. Retry-After: 120 seconds.' }))
  await c.read(); const count = t.calls.length
  t.advance(60001); await c.read(); assert.equal(t.calls.length, count)
  t.advance(60000); await c.read(); assert.equal(t.calls.length, count + 1)
  c.dispose()
})

test('uncertain bridge rejection is never retried; at most one follow-up read occurs', async () => {
  const t = context(); t.ctx.visible = true
  const c = new PlayerController(t.ctx, () => {}, t.clock); c.visible = true; await c.read()
  t.respond(async (tool) => {
    if (tool !== 'now_playing') throw new Error('lost response')
    return { status: 'completed', content: 'snapshot', data: snapshot() }
  })
  await c.action('next_track')
  assert.deepEqual(t.calls.map((v) => v.tool), ['now_playing', 'next_track', 'now_playing'])
  assert.match(c.actionMessage, /Outcome unknown/)
  c.dispose()
})

test('progress clamps locally, stops hidden/stale/paused, and never acts at the end', async () => {
  const t = context(), d = rootDouble(), w = createPlayerWidget(t.clock)
  t.respond(async () => ({ status: 'completed', content: 'snapshot', data: { ...snapshot(), duration: 11000 } }))
  w.mount(d.root, t.ctx); t.ctx.visible = true; w.visibility!(true, t.ctx); await flush()
  assert.equal(d.doc.frames.size, 1)
  t.advance(10000); d.doc.tick()
  assert(d.element.find('0:11')); assert.equal(t.calls.length, 1)
  t.ctx.visible = false; w.visibility!(false, t.ctx)
  assert.equal(d.doc.frames.size, 0)
  await w.refresh!(t.ctx); assert.equal(t.calls.length, 1)
  t.respond(async () => ({ status: 'completed', content: 'snapshot', data: { ...snapshot(t.clock()), state: 'paused' } }))
  t.ctx.visible = true; w.visibility!(true, t.ctx); await flush()
  assert.equal(d.doc.frames.size, 0); assert(d.element.find('Resume'))
  w.unmount!(t.ctx)
})

for (const reason of ['dismissal', 'chat switch', 'plugin disable', 'plugin update']) {
  test(`${reason}: unmount removes listeners/timers and ignores late reads/actions`, async () => {
    const t = context(), d = rootDouble(), w = createPlayerWidget(t.clock)
    w.mount(d.root, t.ctx); t.ctx.visible = true; w.visibility!(true, t.ctx); await flush()
    const elements = d.element.all()
    const gate = deferred<WidgetCallResult>(); t.respond(() => gate.promise)
    const next = d.element.find('Next'); next.emit('click')
    const count = t.calls.length
    w.unmount!(t.ctx)
    assert.equal(d.doc.frames.size, 0); assert.equal(d.element.children.length, 0)
    assert(elements.every((e) => e.listenerCount === 0))
    next.emit('click')
    gate.resolve({ status: 'completed', content: 'Spotify accepted next_track.' }); await flush()
    await w.refresh!(t.ctx); w.visibility!(true, t.ctx)
    assert.equal(t.calls.length, count)
  })
}

test('unmount during read discards response without render or additional call', async () => {
  const t = context(), d = rootDouble(), w = createPlayerWidget(t.clock)
  const gate = deferred<WidgetCallResult>(); t.respond(() => gate.promise)
  w.mount(d.root, t.ctx); t.ctx.visible = true; w.visibility!(true, t.ctx)
  w.unmount!(t.ctx)
  gate.resolve({ status: 'completed', content: 'snapshot', data: snapshot() }); await flush()
  assert.equal(d.element.children.length, 0); assert.equal(d.doc.frames.size, 0); assert.equal(t.calls.length, 1)
})
