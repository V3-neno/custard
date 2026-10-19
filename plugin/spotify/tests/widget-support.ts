import type { WidgetCallResult, WidgetContext } from 'custard-plugin-sdk/widget'
import { fromMetadata, type Snapshot } from '../src/widget-data'

export function snapshot(now = 1000000): Snapshot {
  return fromMetadata({
    observed_at: new Date(now).toISOString(), state: 'playing', currently_playing_type: 'track',
    position_ms: 10000, duration_ms: 180000,
    track: { title: 'Song', artists: ['Artist'], uri: 'spotify:track:AAAAAAAAAAAAAAAAAAAAAA' },
    device: { id: 'device-1', name: 'Computer', is_active: true, is_restricted: false },
    actions: { availability: { next_track: true, pause_playback: true, resume_playback: true, seek: true } }
  })
}
export type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void }
export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
export async function flush(): Promise<void> { for (let i = 0; i < 12; i++) await Promise.resolve() }
export type TestContext = {
  ctx: WidgetContext & { visible: boolean; restored: boolean; input: unknown }
  calls: { tool: string; input: Record<string, unknown> }[]
  heights: number[]
  clock: () => number
  advance: (ms: number) => void
  respond: (f: (tool: string) => Promise<WidgetCallResult>) => void
}
export function context(): TestContext {
  const calls: { tool: string; input: Record<string, unknown> }[] = []
  const heights: number[] = []
  let now = 1000000
  let handler = async (tool: string): Promise<WidgetCallResult> => tool === 'now_playing' ?
    { status: 'completed', content: 'Snapshot', data: snapshot(now) } :
    { status: 'completed', content: `Spotify accepted ${tool}. Playback has not been verified.` }
  const ctx = {
    widgetId: 'player', input: {}, presentation: 'compact', visible: false, restored: false,
    call: (tool: string, input: Record<string, unknown> = {}) => { calls.push({ tool, input }); return handler(tool) },
    setHeight: (height: number) => { heights.push(height) }, log: () => {}
  } as WidgetContext & { visible: boolean; restored: boolean; input: unknown }
  return { ctx, calls, heights, clock: () => now, advance: (ms: number) => { now += ms },
    respond: (f: (tool: string) => Promise<WidgetCallResult>) => { handler = f } }
}

// Deliberately minimal DOM double, usable both in Custard's Chromium test
// sandbox and its Node-based test adapter. This is not a native-view/a11y test.
// innerHTML throws: any metadata interpolation would fail these tests.
export class ElementDouble {
  children: ElementDouble[] = []
  className = ''; textContent = ''; id = ''; title = ''; type = ''; value = ''
  min = ''; max = ''; step = ''; disabled = false; hidden = false; tabIndex = -1
  style: Record<string, string> = {}
  attributes: Record<string, string> = {}
  listeners = new Map<string, Set<() => void>>()
  constructor(readonly tagName: string, readonly ownerDocument: DocumentDouble) {}
  set innerHTML(_value: string) { throw new Error('HTML interpolation is forbidden') }
  append(...els: ElementDouble[]): void { this.children.push(...els) }
  replaceChildren(...els: ElementDouble[]): void { this.children = els }
  setAttribute(k: string, v: string): void { this.attributes[k] = v }
  addEventListener(k: string, fn: () => void): void {
    if (!this.listeners.has(k)) this.listeners.set(k, new Set())
    this.listeners.get(k)!.add(fn)
  }
  removeEventListener(k: string, fn: () => void): void { this.listeners.get(k)?.delete(fn) }
  emit(k: string): void { if (!this.disabled) for (const fn of this.listeners.get(k) ?? []) fn() }
  all(): ElementDouble[] { return [this, ...this.children.flatMap((c) => c.all())] }
  find(text: string): ElementDouble { return this.all().find((e) => e.textContent === text)! }
  get listenerCount(): number { return [...this.listeners.values()].reduce((n, s) => n + s.size, 0) }
}
export class DocumentDouble {
  frames = new Map<number, () => void>()
  private next = 0
  defaultView = {
    // Pending clock redraws; tick() runs them whatever their delay.
    setTimeout: (fn: () => void) => { const id = ++this.next; this.frames.set(id, fn); return id },
    clearTimeout: (id: number) => { this.frames.delete(id) }
  }
  createElement(tag: string): ElementDouble { return new ElementDouble(tag, this) }
  tick(): void { const frames = [...this.frames.values()]; this.frames.clear(); frames.forEach((fn) => fn()) }
}
export const rootDouble = (): { doc: DocumentDouble; element: ElementDouble; root: HTMLElement } => {
  const doc = new DocumentDouble()
  const element = doc.createElement('div')
  return { doc, element, root: element as unknown as HTMLElement }
}
