import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApprovalRequest, ToolOutcome } from '../plugins/host'
import type { WidgetSpec, WidgetView } from '../../shared/widgets'
import {
  WidgetManager,
  type CatalogEntry,
  type ManagerDeps,
  type ViewEvents,
  type WidgetRecord
} from './manager'

// The widget host's rules, with a fake view surface and plugin host. The real
// sandboxed view is exercised by test/e2e/widgets.mjs.

type FakeView = {
  pluginId: string
  code: string
  events: ViewEvents
  sent: Record<string, unknown>[]
  bounds: unknown[]
  visible: boolean
  destroyed: boolean
}

const tally: WidgetSpec = {
  id: 'counter',
  title: 'Tally',
  description: 'Counts things.',
  widgetApi: 1,
  entry: 'widget/counter.ts',
  tools: ['count', 'add'],
  inputSchema: {
    type: 'object',
    properties: { label: { type: 'string', maxLength: 10 } },
    additionalProperties: false
  },
  refreshSeconds: 5
}
const gauge: WidgetSpec = {
  id: 'meter',
  title: 'Meter',
  description: 'A dial.',
  widgetApi: 1,
  entry: 'widget/meter.ts',
  tools: [],
  presentations: ['compact', 'expanded'],
  height: { initial: 72, min: 56, max: 220 }
}

let catalog: CatalogEntry[]
let views: FakeView[]
let records: Map<string, WidgetRecord>
let counts: Map<string, number>
let emitted: (WidgetView | null)[]
let invoked: { name: string; input: unknown; signal: AbortSignal; conversationId: string }[]
// The conversations the catalog was asked for.
let catalogFor: (string | null)[]
let invokeImpl: (
  name: string,
  approve: (r: ApprovalRequest) => Promise<boolean>,
  signal: AbortSignal
) => Promise<ToolOutcome>
let createThrows: boolean
let m: WidgetManager

const RECT = { x: 10, y: 600, width: 700, height: 96 }
const view = (): FakeView => views.at(-1)!
const last = (): WidgetView | null => emitted.at(-1) ?? null
const types = (v: FakeView): unknown[] => v.sent.map((e) => e.type)

beforeEach(() => {
  vi.useFakeTimers()
  catalog = [
    { pluginId: 'tally', pluginName: 'Tally', buildId: 'b1', widget: tally },
    { pluginId: 'gauge', pluginName: 'Gauge', buildId: 'g1', widget: gauge }
  ]
  views = []
  records = new Map()
  counts = new Map()
  emitted = []
  invoked = []
  catalogFor = []
  createThrows = false
  invokeImpl = async (name) => ({
    content: `ran ${name}`,
    isError: false,
    outcome: 'completed',
    data: { n: 1 }
  })
  const deps: ManagerDeps = {
    catalog: (conversationId) => {
      catalogFor.push(conversationId)
      return catalog
    },
    widgetCode: (id, buildId, widgetId) => `code:${id}/${buildId}/${widgetId}`,
    isWrite: (_id, _b, tool) => (tool === 'add' ? true : tool === 'count' ? false : null),
    invoke: (name, input, o) => {
      invoked.push({ name, input, signal: o.signal, conversationId: o.conversationId })
      return invokeImpl(name, o.approve, o.signal)
    },
    log: () => {},
    surface: {
      create: ({ pluginId, code, events }) => {
        if (createThrows) throw new Error('no window')
        const v: FakeView = {
          pluginId,
          code,
          events,
          sent: [],
          bounds: [],
          visible: false,
          destroyed: false
        }
        views.push(v)
        return {
          send: (e) => void v.sent.push(e),
          setBounds: (r) => void v.bounds.push(r),
          setVisible: (x) => void (v.visible = x),
          destroy: () => void (v.destroyed = true)
        }
      }
    },
    records: {
      get: (id) => records.get(id) ?? {},
      set: (id, r) => void records.set(id, r)
    },
    messageCount: (id) => counts.get(id) ?? 0,
    conversationForRequest: (r) => (r === 'req-new' ? 'new-chat' : null),
    emit: (v) => void emitted.push(v)
  }
  m = new WidgetManager(deps)
})

afterEach(() => {
  vi.useRealTimers()
})

// Shows the tally in chat A on screen and makes it ready and visible.
function showReady(conv = 'A'): FakeView {
  m.display({ conversationId: conv })
  expect(m.show(conv, 'tally/counter', { label: 'Cups' }, { start: 0 }).ok).toBe(true)
  const v = view()
  v.events.ready()
  m.bounds({ instanceId: last()!.instanceId, rect: RECT, visible: true })
  return v
}

describe('nothing showing', () => {
  it('creates no view and reports no widget until the assistant shows one', () => {
    m.display({ conversationId: 'A' })
    expect(views).toEqual([])
    expect(emitted).toEqual([null])
    expect(records.get('A')).toBeUndefined()
  })

  it('lists only the catalog, with plugin text as plain descriptions', () => {
    expect(m.keys('A')).toEqual(['tally/counter', 'gauge/meter'])
    const lines = m.describe('A')
    expect(lines[0]).toContain('tally/counter: Tally. Counts things.')
    expect(lines[0]).toContain('"maxLength":10')
  })
})

describe('showing', () => {
  it('mounts the widget without running any plugin tool', () => {
    const v = showReady()
    expect(v.code).toBe('code:tally/b1/counter')
    expect(v.sent[0]).toMatchObject({
      type: 'mount',
      widgetId: 'counter',
      input: { label: 'Cups' },
      restored: false
    })
    expect(invoked).toEqual([])
    expect(v.visible).toBe(true)
    expect(v.sent.at(-1)).toEqual({ type: 'visibility', visible: true })
    expect(last()).toMatchObject({ conversationId: 'A', pluginId: 'tally', title: 'Tally' })
  })

  it('refuses unknown widgets and input that fails its schema', () => {
    m.display({ conversationId: 'A' })
    expect(m.show('A', 'tally/other', {}, { start: 0 }).ok).toBe(false)
    expect(m.show('A', 'tally/counter', { label: 'x'.repeat(11) }, { start: 0 }).ok).toBe(false)
    expect(m.show('A', 'tally/counter', { extra: 1 }, { start: 0 }).ok).toBe(false)
    expect(m.show('A', 'tally/counter', [1], { start: 0 }).ok).toBe(false)
    expect(views).toEqual([])
  })

  it('updates the same widget in place, and replaces a different one', () => {
    const v = showReady()
    expect(m.show('A', 'tally/counter', { label: 'Mugs' }, { start: 0 }).content).toMatch(/Updated/)
    expect(views).toHaveLength(1)
    expect(v.sent.at(-1)).toEqual({ type: 'input', input: { label: 'Mugs' } })
    m.show('A', 'gauge/meter', { value: 3 }, { start: 0 })
    expect(views).toHaveLength(2)
    expect(v.sent.at(-1)).toEqual({ type: 'unmount' })
    vi.advanceTimersByTime(300)
    expect(v.destroyed).toBe(true)
    expect(records.get('A')!.active!.pluginId).toBe('gauge')
    expect(view().sent[0]).toMatchObject({ presentation: 'compact' })
  })

  it("is kept for a chat that isn't on screen and appears when it opens", () => {
    m.display({ conversationId: 'B' })
    m.show('A', 'gauge/meter', { value: 5 }, { start: 0 })
    expect(views).toEqual([])
    m.display({ conversationId: 'A' })
    expect(view().sent[0]).toMatchObject({ type: 'mount', input: { value: 5 } })
  })

  it('finds a new chat by its turn before the renderer has its id', () => {
    m.display({ conversationId: null, requestId: 'req-new' })
    m.show('new-chat', 'gauge/meter', { value: 1 }, { start: 0 })
    expect(views).toHaveLength(1)
    m.display({ conversationId: 'new-chat' })
    expect(views).toHaveLength(1)
    expect(view().destroyed).toBe(false)
  })

  it('hides on request and clears the record', () => {
    const v = showReady()
    expect(m.hide('A').ok).toBe(true)
    vi.advanceTimersByTime(300)
    expect(v.destroyed).toBe(true)
    expect(records.get('A')).toEqual({})
    expect(last()).toBeNull()
  })
})

describe('closing', () => {
  it('stays closed for the rest of the reply, and a new message can reopen it', () => {
    const v = showReady()
    counts.set('A', 4)
    m.dismiss(last()!.instanceId)
    vi.advanceTimersByTime(300)
    expect(v.destroyed).toBe(true)
    expect(last()).toBeNull()
    expect(records.get('A')).toEqual({ dismissed: { key: 'tally/counter', at: 4 } })
    // The same reply (it started before the close) can't bring it back.
    const again = m.show('A', 'tally/counter', {}, { start: 3 })
    expect(again.ok).toBe(false)
    expect(again.content).toMatch(/closed/)
    expect(views).toHaveLength(1)
    // Refreshing or reopening the chat doesn't either.
    m.display({ conversationId: 'B' })
    m.display({ conversationId: 'A' })
    expect(views).toHaveLength(1)
    expect(m.describe('A')[0]).toContain('the user closed it')
    // Another widget may still be shown.
    expect(m.show('A', 'gauge/meter', { value: 1 }, { start: 3 }).ok).toBe(true)
    // A later message asking for it does.
    expect(m.show('A', 'tally/counter', {}, { start: 4 }).ok).toBe(true)
    expect(records.get('A')!.dismissed).toBeUndefined()
  })
})

describe('switching chats', () => {
  it("removes one chat's widget and restores the other's without replaying anything", () => {
    const v = showReady('A')
    m.display({ conversationId: 'B' })
    vi.advanceTimersByTime(300)
    expect(v.destroyed).toBe(true)
    expect(last()).toBeNull()
    m.display({ conversationId: 'A' })
    const back = view()
    expect(back).not.toBe(v)
    expect(back.sent[0]).toMatchObject({ type: 'mount', restored: true, input: { label: 'Cups' } })
    expect(invoked).toEqual([])
  })

  it('forgets a widget whose plugin was disabled or updated since', () => {
    showReady('A')
    m.display({ conversationId: 'B' })
    catalog = catalog.map((e) => (e.pluginId === 'tally' ? { ...e, buildId: 'b2' } : e))
    m.display({ conversationId: 'A' })
    expect(views).toHaveLength(1)
    expect(records.get('A')!.active).toBeUndefined()
  })

  it('forgets a deleted chat', () => {
    showReady('A')
    m.conversationDeleted('A')
    expect(records.get('A')).toEqual({})
  })
})

describe('lifecycle', () => {
  it('hides and pauses refresh while the window or the area is hidden', () => {
    const v = showReady()
    vi.advanceTimersByTime(5000)
    expect(types(v).filter((t) => t === 'refresh')).toHaveLength(1)
    m.windowVisibility(false)
    expect(v.visible).toBe(false)
    expect(v.sent.at(-1)).toEqual({ type: 'visibility', visible: false })
    vi.advanceTimersByTime(20000)
    expect(types(v).filter((t) => t === 'refresh')).toHaveLength(1)
    m.windowVisibility(true)
    m.bounds({ instanceId: last()!.instanceId, rect: RECT, visible: false })
    expect(v.visible).toBe(false)
    m.bounds({ instanceId: last()!.instanceId, rect: RECT, visible: true })
    vi.advanceTimersByTime(5000)
    expect(types(v).filter((t) => t === 'refresh')).toHaveLength(2)
  })

  it('takes the widget down when its plugin is disabled or updated', () => {
    const v = showReady()
    m.pluginChanged('tally')
    expect(v.destroyed).toBe(false)
    catalog = catalog.filter((e) => e.pluginId !== 'tally')
    m.pluginChanged('tally')
    vi.advanceTimersByTime(300)
    expect(v.destroyed).toBe(true)
    expect(records.get('A')!.active).toBeUndefined()
    expect(last()).toBeNull()
  })

  it('destroys the view at once on shutdown', () => {
    const v = showReady()
    m.shutdown()
    expect(v.destroyed).toBe(true)
  })

  it('applies presentations the widget declares, and clamps its height', () => {
    m.display({ conversationId: 'A' })
    m.show('A', 'gauge/meter', { value: 1 }, { start: 0 })
    const v = view()
    v.events.ready()
    const id = last()!.instanceId
    m.setPresentation(id, 'expanded')
    expect(v.sent.at(-1)).toEqual({ type: 'presentation', presentation: 'expanded' })
    v.events.setHeight(5000)
    expect(last()!.height).toBe(220)
    v.events.setHeight(1)
    expect(last()!.height).toBe(56)
    expect(records.get('A')!.active).toMatchObject({ presentation: 'expanded', height: 56 })
  })
})

describe('failures stay in the widget', () => {
  it('shows an error with a close button when the widget throws on mount', () => {
    m.display({ conversationId: 'A' })
    m.show('A', 'tally/counter', {}, { start: 0 })
    const v = view()
    v.events.fail('crash-on-mount')
    expect(v.destroyed).toBe(true)
    expect(last()!.error).toMatch(/crash-on-mount/)
    m.dismiss(last()!.instanceId)
    expect(last()).toBeNull()
  })

  it("fails a widget that doesn't finish loading in time", () => {
    m.display({ conversationId: 'A' })
    m.show('A', 'tally/counter', {}, { start: 0 })
    vi.advanceTimersByTime(8000)
    expect(view().destroyed).toBe(true)
    expect(last()!.error).toMatch(/within 8 seconds/)
  })

  it('reports a crashed view, and the assistant can show it again', () => {
    const v = showReady()
    v.events.gone('it crashed: oom')
    expect(last()!.error).toMatch(/crashed/)
    expect(m.show('A', 'tally/counter', {}, { start: 0 }).ok).toBe(true)
    expect(views).toHaveLength(2)
  })

  it("contains a view that can't be created", () => {
    createThrows = true
    m.display({ conversationId: 'A' })
    expect(m.show('A', 'tally/counter', {}, { start: 0 }).ok).toBe(true)
    expect(last()!.error).toMatch(/no window/)
  })
})

describe('calls from a widget', () => {
  it("runs reads of its own plugin's listed tools, with data", async () => {
    const v = showReady()
    const r = await v.events.call('count', {})
    expect(r).toEqual({ status: 'completed', content: 'ran tally__count', data: { n: 1 } })
    expect(invoked[0].name).toBe('tally__count')
    // The host is told whose call it is, so the chat's mode decides whether
    // the plugin may run there (needsChatDesign).
    expect(invoked[0].conversationId).toBe('A')
    expect(catalogFor.length).toBeGreaterThan(0)
    expect(catalogFor.every((c) => c === 'A')).toBe(true)
    expect((await v.events.call('other', {})).status).toBe('not-run')
    expect((await v.events.call('gauge__scale', {})).status).toBe('not-run')
    expect(invoked).toHaveLength(1)
  })

  it("refuses calls while it can't be seen or before it is ready", async () => {
    m.display({ conversationId: 'A' })
    m.show('A', 'tally/counter', {}, { start: 0 })
    const v = view()
    expect((await v.events.call('count', {})).content).toMatch(/closed/)
    v.events.ready()
    expect((await v.events.call('count', {})).content).toMatch(/can't be seen/)
    m.bounds({ instanceId: last()!.instanceId, rect: RECT, visible: true })
    m.windowVisibility(false)
    expect((await v.events.call('count', {})).status).toBe('not-run')
    expect(invoked).toEqual([])
  })

  it('needs a real click or key press before a write, then the usual approval', async () => {
    const v = showReady()
    invokeImpl = async (_name, approve) =>
      (await approve({
        pluginId: 'tally',
        pluginName: 'Tally',
        tool: 'add',
        label: 'Add 1',
        input: {}
      }))
        ? { content: 'added', isError: false, outcome: 'completed' }
        : { content: 'declined', isError: true, outcome: 'not-run' }
    expect((await v.events.call('add', { amount: 1 })).content).toMatch(/click or key press/)
    expect(invoked).toEqual([])
    v.events.input()
    const pending = v.events.call('add', { amount: 1 })
    await vi.advanceTimersByTimeAsync(0)
    const card = last()!.approval!
    expect(card.label).toBe('Add 1')
    // A second write while one waits is refused, not queued.
    expect((await v.events.call('add', { amount: 1 })).status).toBe('not-run')
    m.decide(card.id, true)
    expect(await pending).toMatchObject({ status: 'completed', content: 'added' })
    expect(last()!.approval).toBeUndefined()
    // The gesture expires.
    vi.advanceTimersByTime(5001)
    expect((await v.events.call('add', { amount: 1 })).content).toMatch(/click or key press/)
  })

  it('declines a waiting approval when the widget goes away', async () => {
    const v = showReady()
    let asked: boolean | undefined
    invokeImpl = async (_n, approve) => {
      asked = await approve({
        pluginId: 'tally',
        pluginName: 'Tally',
        tool: 'add',
        label: 'x',
        input: {}
      })
      return { content: 'declined', isError: true, outcome: 'not-run' }
    }
    v.events.input()
    const pending = v.events.call('add', { amount: 1 })
    await vi.advanceTimersByTimeAsync(0)
    m.dismiss(last()!.instanceId)
    expect((await pending).status).toBe('not-run')
    expect(asked).toBe(false)
  })

  it('runs one of each read at a time, cancels reads on close, and limits the rate', async () => {
    const v = showReady()
    let release: (o: ToolOutcome) => void = () => {}
    invokeImpl = () => new Promise((r) => (release = r))
    const first = v.events.call('count', {})
    expect((await v.events.call('count', {})).content).toMatch(/already running/)
    const signal = invoked[0].signal
    m.hide('A')
    expect(signal.aborted).toBe(true)
    release({ content: 'late', isError: false, outcome: 'completed' })
    await first

    const w = showReady()
    invokeImpl = async () => ({ content: 'ok', isError: false, outcome: 'completed' })
    for (let i = 0; i < 30; i++) expect((await w.events.call('count', {})).status).toBe('completed')
    expect((await w.events.call('count', {})).content).toMatch(/too many/)
    vi.advanceTimersByTime(60_000)
    expect((await w.events.call('count', {})).status).toBe('completed')
  })

  it('reports a write that may have happened as unknown', async () => {
    const v = showReady()
    invokeImpl = async () => {
      throw new Error('lost')
    }
    v.events.input()
    expect((await v.events.call('add', { amount: 1 })).status).toBe('unknown')
  })

  it('ignores events from a view that has been replaced', async () => {
    const v = showReady()
    m.show('A', 'gauge/meter', { value: 1 }, { start: 0 })
    v.events.setHeight(200)
    v.events.fail('late')
    expect(last()!.error).toBeUndefined()
    expect((await v.events.call('count', {})).status).toBe('not-run')
  })
})
