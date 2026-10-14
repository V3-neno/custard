import { randomUUID } from 'crypto'
import type { ApprovalRequest, ToolOutcome, ToolSnapshot } from '../plugins/host'
import { validate } from '../plugins/schema'
import {
  WIDGET_LIMITS,
  widgetKey,
  type WidgetBounds,
  type WidgetCallResult,
  type WidgetDisplay,
  type WidgetPresentation,
  type WidgetSpec,
  type WidgetView
} from '../../shared/widgets'

// The widget host's logic: which widget each conversation shows, the one
// view on screen, its lifecycle, and the checks on every call a widget makes.
// Electron specifics (the sandboxed view, IPC) are behind `ViewSurface` and
// the deps, so this runs in unit tests with fakes.
//
// Rules this enforces:
// - Only the assistant (widget_show) or a restore of what a chat already
//   showed puts a widget on screen. Tool results never do.
// - Showing, restoring or updating a widget runs no plugin tool. The widget's
//   own code may call read tools; writes need a real click or key press in
//   the widget first, and then the plugin's usual approval.
// - A widget the user closes isn't shown again in that conversation until the
//   user has sent a new message.
// - One widget per conversation; only the conversation on screen has a view.

export type CatalogEntry = {
  pluginId: string
  pluginName: string
  buildId: string
  widget: WidgetSpec
}

// What a conversation remembers, so reopening it shows the same widget.
export type WidgetRecord = {
  active?: {
    pluginId: string
    widgetId: string
    buildId: string
    input: unknown
    presentation: WidgetPresentation
    height: number
  }
  // Closed by the user when the chat had `at` messages.
  dismissed?: { key: string; at: number }
}

export type ViewHandle = {
  send(event: Record<string, unknown>): void
  setBounds(rect: WidgetBounds['rect']): void
  setVisible(visible: boolean): void
  destroy(): void
}

export type ViewEvents = {
  ready(): void
  fail(message: string): void
  call(tool: string, input: unknown): Promise<WidgetCallResult>
  setHeight(px: number): void
  log(message: string): void
  // A real mouse or keyboard event reached the view (not a script's).
  input(): void
  gone(reason: string): void
}

export type ViewSurface = {
  create(o: { pluginId: string; code: string; events: ViewEvents }): ViewHandle
}

export type ManagerDeps = {
  // The widgets a conversation may show (its mode decides which plugins it
  // may use); null for no conversation.
  catalog(conversationId: string | null): CatalogEntry[]
  widgetCode(pluginId: string, buildId: string, widgetId: string): string | null
  // Whether a tool of the plugin changes something (effect: write).
  isWrite(pluginId: string, buildId: string, tool: string): boolean | null
  invoke(
    name: string,
    input: unknown,
    o: {
      snapshot: ToolSnapshot
      signal: AbortSignal
      approve: (r: ApprovalRequest) => Promise<boolean>
      // The conversation the widget belongs to.
      conversationId: string
    }
  ): Promise<ToolOutcome>
  log(pluginId: string, line: string): void
  surface: ViewSurface
  records: { get(id: string): WidgetRecord; set(id: string, r: WidgetRecord): void }
  // How many messages a conversation has now (for the dismissal rule).
  messageCount(id: string): number
  // The conversation a turn in progress belongs to.
  conversationForRequest(requestId: string): string | null
  // To the renderer showing the chat.
  emit(view: WidgetView | null): void
  now?: () => number
}

type Instance = {
  id: string
  conversationId: string
  entry: CatalogEntry
  input: unknown
  presentation: WidgetPresentation
  height: number
  restored: boolean
  view: ViewHandle | null
  status: 'loading' | 'ready' | 'failed'
  error?: string
  slotVisible: boolean
  visibleSent: boolean | null
  rect: WidgetBounds['rect'] | null
  readsInFlight: Set<string>
  writeInFlight: boolean
  callTimes: number[]
  lastGesture: number
  controllers: Set<AbortController>
  approval?: { id: string; label: string; detail: string; resolve: (ok: boolean) => void }
  refreshTimer?: ReturnType<typeof setInterval>
  loadTimer?: ReturnType<typeof setTimeout>
}

const notRun = (content: string): WidgetCallResult => ({ status: 'not-run', content })

export function clampHeight(spec: WidgetSpec, px: number): number {
  const lo = Math.max(WIDGET_LIMITS.minHeight, spec.height?.min ?? WIDGET_LIMITS.minHeight)
  const hi = Math.min(WIDGET_LIMITS.maxHeight, spec.height?.max ?? WIDGET_LIMITS.maxHeight)
  const n = Number.isFinite(px) ? Math.round(px) : WIDGET_LIMITS.defaultHeight
  return Math.min(hi, Math.max(lo, n))
}

export class WidgetManager {
  private live: Instance | null = null
  private displayed: WidgetDisplay = { conversationId: null }
  private windowVisible = true
  private readonly now: () => number

  constructor(private d: ManagerDeps) {
    this.now = d.now ?? Date.now
  }

  // The assistant's tools

  keys(conversationId: string | null): string[] {
    return this.d.catalog(conversationId).map((e) => widgetKey(e.pluginId, e.widget.id))
  }

  // What the assistant is told it can show, for one conversation.
  describe(conversationId: string | null): string[] {
    const dismissed = conversationId ? this.d.records.get(conversationId).dismissed?.key : undefined
    return this.d.catalog(conversationId).map((e) => {
      const key = widgetKey(e.pluginId, e.widget.id)
      const note = key === dismissed ? ' (the user closed it in this chat)' : ''
      const schema = e.widget.inputSchema
        ? ` Input: ${JSON.stringify(e.widget.inputSchema).slice(0, 600)}`
        : ''
      return `- ${key}: ${e.widget.title}. ${e.widget.description.replace(/\s+/g, ' ').trim()}${schema}${note}`
    })
  }

  show(
    conversationId: string,
    key: unknown,
    input: unknown,
    turn: { start: number }
  ): { ok: boolean; content: string } {
    const entry = this.d
      .catalog(conversationId)
      .find((e) => widgetKey(e.pluginId, e.widget.id) === key)
    if (!entry)
      return {
        ok: false,
        content: `There is no widget "${String(key)}" to show. Available: ${
          this.d
            .catalog(conversationId)
            .map((e) => widgetKey(e.pluginId, e.widget.id))
            .join(', ') || 'none'
        }.`
      }
    const rec = this.d.records.get(conversationId)
    if (rec.dismissed && rec.dismissed.key === key && turn.start < rec.dismissed.at)
      return {
        ok: false,
        content: `The user closed the ${entry.widget.title} widget during this reply, so it was not shown again. Show it only if they ask for it in a new message.`
      }
    const value = input ?? {}
    if (typeof value !== 'object' || Array.isArray(value))
      return { ok: false, content: 'The widget input must be an object.' }
    let size = 0
    try {
      size = JSON.stringify(value).length
    } catch {
      return { ok: false, content: 'The widget input must be plain JSON.' }
    }
    if (size > WIDGET_LIMITS.inputBytes)
      return { ok: false, content: 'The widget input is too large.' }
    if (entry.widget.inputSchema) {
      const errors = validate(entry.widget.inputSchema, value)
      if (errors.length)
        return { ok: false, content: `Invalid widget input: ${errors.slice(0, 5).join('; ')}` }
    }
    const a = rec.active
    const same =
      a &&
      a.pluginId === entry.pluginId &&
      a.widgetId === entry.widget.id &&
      a.buildId === entry.buildId
    const presentations = entry.widget.presentations ?? ['compact']
    const next: WidgetRecord = {
      // A new request reopens a widget the user closed earlier.
      ...(rec.dismissed && rec.dismissed.key !== key ? { dismissed: rec.dismissed } : {}),
      active: {
        pluginId: entry.pluginId,
        widgetId: entry.widget.id,
        buildId: entry.buildId,
        input: value,
        presentation: same ? a!.presentation : presentations[0],
        height: same
          ? a!.height
          : clampHeight(entry.widget, entry.widget.height?.initial ?? WIDGET_LIMITS.defaultHeight)
      }
    }
    this.d.records.set(conversationId, next)
    const live = this.live
    if (same && live && live.conversationId === conversationId && live.status !== 'failed') {
      live.input = value
      if (live.status === 'ready') live.view?.send({ type: 'input', input: value })
      return {
        ok: true,
        content: `Updated the ${entry.widget.title} widget. No plugin action ran.`
      }
    }
    if (live && live.conversationId === conversationId) this.unmount('replaced')
    if (this.isDisplayed(conversationId)) this.mount(conversationId, false)
    return {
      ok: true,
      content: `${same ? 'Updated' : 'Showing'} the ${entry.widget.title} widget next to the message box${
        this.isDisplayed(conversationId) ? '' : ' (it appears when this chat is open)'
      }. Showing it ran no plugin action.`
    }
  }

  hide(conversationId: string): { ok: boolean; content: string } {
    const rec = this.d.records.get(conversationId)
    if (!rec.active) return { ok: true, content: 'No widget was showing.' }
    this.d.records.set(conversationId, { ...rec, active: undefined })
    if (this.live?.conversationId === conversationId) this.unmount('hidden by the assistant')
    this.emit()
    return { ok: true, content: 'Hid the widget.' }
  }

  // The renderer

  display(d: WidgetDisplay): void {
    this.displayed = {
      conversationId: typeof d.conversationId === 'string' ? d.conversationId : null,
      requestId: typeof d.requestId === 'string' ? d.requestId : null,
      theme: d.theme && typeof d.theme === 'object' ? d.theme : {}
    }
    const target = this.target()
    if (this.live && this.live.conversationId !== target) this.unmount('another chat is open')
    if (this.live?.status === 'ready')
      this.live.view?.send({ type: 'theme', theme: this.displayed.theme ?? {} })
    if (target && !this.live) this.mount(target, true)
    this.emit()
  }

  bounds(b: WidgetBounds): void {
    const inst = this.live
    if (!inst || inst.id !== b.instanceId) return
    const r = b.rect
    const ok = [r.x, r.y, r.width, r.height].every((n) => Number.isFinite(n))
    inst.rect = ok
      ? {
          x: Math.round(r.x),
          y: Math.round(r.y),
          width: Math.max(0, Math.round(r.width)),
          height: Math.max(0, Math.round(r.height))
        }
      : null
    inst.slotVisible = ok && !!b.visible && inst.rect!.width > 0 && inst.rect!.height > 0
    if (inst.rect) inst.view?.setBounds(inst.rect)
    this.syncVisibility()
  }

  // The user's close button. The widget stays closed in this conversation
  // until the user sends another message.
  dismiss(instanceId: string): void {
    const inst = this.live
    if (!inst || inst.id !== instanceId) return
    this.d.records.set(inst.conversationId, {
      dismissed: {
        key: widgetKey(inst.entry.pluginId, inst.entry.widget.id),
        at: this.d.messageCount(inst.conversationId)
      }
    })
    this.unmount('closed by the user')
    this.emit()
  }

  setPresentation(instanceId: string, p: WidgetPresentation): void {
    const inst = this.live
    if (!inst || inst.id !== instanceId) return
    if (!(inst.entry.widget.presentations ?? ['compact']).includes(p)) return
    inst.presentation = p
    this.saveActive(inst)
    if (inst.status === 'ready') inst.view?.send({ type: 'presentation', presentation: p })
    this.emit()
  }

  decide(approvalId: string, allow: boolean): void {
    const a = this.live?.approval
    if (!a || a.id !== approvalId) return
    this.live!.approval = undefined
    a.resolve(allow === true)
    this.emit()
  }

  windowVisibility(visible: boolean): void {
    this.windowVisible = visible
    this.syncVisibility()
  }

  // Plugins and conversations

  pluginChanged(pluginId: string): void {
    const inst = this.live
    if (!inst || inst.entry.pluginId !== pluginId) return
    if (this.current(inst)) return
    const rec = this.d.records.get(inst.conversationId)
    this.d.records.set(inst.conversationId, { ...rec, active: undefined })
    this.unmount('the plugin was disabled, updated or removed')
    this.emit()
  }

  conversationDeleted(id: string): void {
    if (this.live?.conversationId === id) this.unmount('the chat was deleted')
    this.d.records.set(id, {})
    this.emit()
  }

  shutdown(): void {
    this.unmount('Custard is closing', true)
  }

  // Internals

  // The conversation on screen. A new chat has no id in the renderer until
  // its first reply ends, so it is found by the turn in progress.
  private target(): string | null {
    const d = this.displayed
    return d.conversationId ?? (d.requestId ? this.d.conversationForRequest(d.requestId) : null)
  }

  private isDisplayed(conversationId: string): boolean {
    return this.target() === conversationId
  }

  // The catalog entry, if the plugin and build are still enabled and approved.
  private current(inst: Instance): CatalogEntry | undefined {
    const e = inst.entry
    return this.d
      .catalog(inst.conversationId)
      .find(
        (c) => c.pluginId === e.pluginId && c.widget.id === e.widget.id && c.buildId === e.buildId
      )
  }

  private saveActive(inst: Instance): void {
    const rec = this.d.records.get(inst.conversationId)
    if (!rec.active || rec.active.widgetId !== inst.entry.widget.id) return
    this.d.records.set(inst.conversationId, {
      ...rec,
      active: { ...rec.active, presentation: inst.presentation, height: inst.height }
    })
  }

  // Puts the conversation's widget on screen. Never runs a plugin tool.
  private mount(conversationId: string, restored: boolean): void {
    const rec = this.d.records.get(conversationId)
    const a = rec.active
    if (!a) return
    const entry = this.d
      .catalog(conversationId)
      .find(
        (c) => c.pluginId === a.pluginId && c.widget.id === a.widgetId && c.buildId === a.buildId
      )
    // The plugin was disabled, updated or its widget removed since: forget it.
    const code = entry && this.d.widgetCode(a.pluginId, a.buildId, a.widgetId)
    if (!entry || !code) {
      this.d.records.set(conversationId, { ...rec, active: undefined })
      return
    }
    const inst: Instance = {
      id: randomUUID(),
      conversationId,
      entry,
      input: a.input,
      presentation: a.presentation,
      height: clampHeight(entry.widget, a.height),
      restored,
      view: null,
      status: 'loading',
      slotVisible: false,
      visibleSent: null,
      rect: null,
      readsInFlight: new Set(),
      writeInFlight: false,
      callTimes: [],
      lastGesture: 0,
      controllers: new Set()
    }
    this.live = inst
    const mine = (): boolean => this.live === inst
    try {
      inst.view = this.d.surface.create({
        pluginId: entry.pluginId,
        code,
        events: {
          ready: () => {
            if (!mine() || inst.status !== 'loading') return
            clearTimeout(inst.loadTimer)
            inst.status = 'ready'
            if (inst.rect) inst.view?.setBounds(inst.rect)
            this.syncVisibility()
            this.emit()
          },
          fail: (msg) =>
            mine() && this.failed(inst, `It failed to start: ${String(msg).slice(0, 200)}`),
          call: (tool, input) => this.call(inst, tool, input),
          setHeight: (px) => {
            if (!mine()) return
            const h = clampHeight(entry.widget, px)
            if (h === inst.height) return
            inst.height = h
            this.saveActive(inst)
            this.emit()
          },
          log: (m) => mine() && this.d.log(entry.pluginId, `widget ${entry.widget.id}: ${m}`),
          input: () => {
            if (mine()) inst.lastGesture = this.now()
          },
          gone: (reason) => mine() && this.failed(inst, `It stopped (${reason}).`)
        }
      })
    } catch (err) {
      this.failed(inst, `It couldn't be opened: ${(err as Error)?.message ?? String(err)}`)
      return
    }
    inst.view.setVisible(false)
    inst.view.send({
      type: 'mount',
      widgetId: entry.widget.id,
      input: inst.input,
      presentation: inst.presentation,
      visible: false,
      restored,
      theme: this.displayed.theme ?? {}
    })
    inst.loadTimer = setTimeout(() => {
      if (mine() && inst.status === 'loading')
        this.failed(inst, `It didn't finish loading within ${WIDGET_LIMITS.loadMs / 1000} seconds.`)
    }, WIDGET_LIMITS.loadMs)
  }

  // The widget broke: its view goes, the chat stays. The host shows why, with
  // a close button.
  private failed(inst: Instance, why: string): void {
    if (inst.status === 'failed') return
    inst.status = 'failed'
    inst.error = `The ${inst.entry.widget.title} widget isn't available. ${why}`
    this.d.log(inst.entry.pluginId, `widget ${inst.entry.widget.id}: ${why}`)
    this.teardown(inst, false)
    this.emit()
  }

  private teardown(inst: Instance, graceful: boolean): void {
    clearTimeout(inst.loadTimer)
    if (inst.refreshTimer) clearInterval(inst.refreshTimer)
    inst.refreshTimer = undefined
    // Reads stop; a write already sent runs to its end (its outcome is the
    // plugin's to report), but a write still waiting for approval is declined.
    for (const c of inst.controllers) c.abort()
    inst.controllers.clear()
    if (inst.approval) {
      inst.approval.resolve(false)
      inst.approval = undefined
    }
    const view = inst.view
    inst.view = null
    if (!view) return
    if (graceful && inst.status === 'ready') {
      try {
        view.send({ type: 'unmount' })
      } catch {
        // Already gone.
      }
      setTimeout(() => view.destroy(), 300)
    } else view.destroy()
  }

  private unmount(_reason: string, immediate = false): void {
    const inst = this.live
    if (!inst) return
    this.live = null
    this.teardown(inst, !immediate)
  }

  private syncVisibility(): void {
    const inst = this.live
    if (!inst || inst.status !== 'ready' || !inst.view) return
    const visible = this.isDisplayed(inst.conversationId) && inst.slotVisible && this.windowVisible
    inst.view.setVisible(visible)
    if (inst.visibleSent !== visible) {
      inst.visibleSent = visible
      inst.view.send({ type: 'visibility', visible })
    }
    // Refresh signals only while it can be seen.
    const every = inst.entry.widget.refreshSeconds
    if (visible && every && !inst.refreshTimer)
      inst.refreshTimer = setInterval(() => {
        if (this.live === inst && inst.visibleSent) inst.view?.send({ type: 'refresh' })
      }, every * 1000)
    if (!visible && inst.refreshTimer) {
      clearInterval(inst.refreshTimer)
      inst.refreshTimer = undefined
    }
  }

  private visible(inst: Instance): boolean {
    return this.live === inst && inst.status === 'ready' && inst.visibleSent === true
  }

  // Every call a widget makes. The widget is told what happened; nothing is
  // retried for it.
  private async call(inst: Instance, tool: unknown, input: unknown): Promise<WidgetCallResult> {
    const { entry } = inst
    if (this.live !== inst || inst.status !== 'ready') return notRun('The widget is closed.')
    if (typeof tool !== 'string' || !entry.widget.tools.includes(tool))
      return notRun(`This widget may not use "${String(tool)}".`)
    if (!this.current(inst))
      return notRun('The plugin was disabled or updated, so nothing was done.')
    if (!this.visible(inst))
      return notRun("The widget can't be seen right now, so nothing was done.")
    const now = this.now()
    inst.callTimes = inst.callTimes.filter((t) => now - t < 60_000)
    if (inst.callTimes.length >= WIDGET_LIMITS.callsPerMinute)
      return notRun('The widget is making too many requests; try again in a minute.')
    const write = this.d.isWrite(entry.pluginId, entry.buildId, tool)
    if (write === null) return notRun('This plugin has no such tool.')
    if (write) {
      if (now - inst.lastGesture > WIDGET_LIMITS.gestureMs)
        return notRun('Actions need a click or key press in the widget first, so nothing was done.')
      if (inst.writeInFlight)
        return notRun('Another action from this widget is still running, so nothing was done.')
      if (inst.approval) return notRun('An action from this widget is waiting for approval.')
      inst.writeInFlight = true
    } else {
      if (inst.readsInFlight.has(tool))
        return notRun(`${tool} is already running for this widget; wait for its result.`)
      inst.readsInFlight.add(tool)
    }
    inst.callTimes.push(now)
    const name = `${entry.pluginId}__${tool}`
    const controller = new AbortController()
    // Writes are not cancelled when the widget closes (see teardown).
    if (!write) inst.controllers.add(controller)
    try {
      const r = await this.d.invoke(name, input ?? {}, {
        snapshot: new Map([[name, { pluginId: entry.pluginId, buildId: entry.buildId }]]),
        signal: controller.signal,
        approve: (req) => this.approve(inst, req),
        conversationId: inst.conversationId
      })
      const status = r.outcome ?? (r.isError ? 'failed' : 'completed')
      if (status === 'unknown')
        this.d.log(entry.pluginId, `widget ${entry.widget.id}: ${tool} outcome unknown`)
      return {
        status,
        content: r.content,
        ...(r.data !== undefined ? { data: r.data } : {}),
        ...(r.dataDropped ? { dataDropped: r.dataDropped } : {})
      }
    } catch (err) {
      return {
        status: write ? 'unknown' : 'failed',
        content: (err as Error)?.message ?? String(err)
      }
    } finally {
      if (write) inst.writeInFlight = false
      else inst.readsInFlight.delete(tool)
      inst.controllers.delete(controller)
    }
  }

  // A write that asks first: the host shows the card in its own area above
  // the widget, outside the widget's view, so the widget can't draw over it.
  private approve(inst: Instance, r: ApprovalRequest): Promise<boolean> {
    if (this.live !== inst || inst.approval) return Promise.resolve(false)
    let detail = ''
    try {
      detail = JSON.stringify(r.input, null, 2) ?? ''
    } catch {
      return Promise.resolve(false)
    }
    return new Promise<boolean>((resolve) => {
      inst.approval = { id: randomUUID(), label: r.label, detail, resolve }
      this.emit()
    })
  }

  private emit(): void {
    const inst = this.live
    const target = this.target()
    if (!inst || !target || inst.conversationId !== target) return this.d.emit(null)
    const w = inst.entry.widget
    this.d.emit({
      conversationId: inst.conversationId,
      instanceId: inst.id,
      pluginId: inst.entry.pluginId,
      pluginName: inst.entry.pluginName,
      widgetId: w.id,
      title: w.title,
      height: inst.height,
      presentation: inst.presentation,
      presentations: w.presentations ?? ['compact'],
      ...(inst.error ? { error: inst.error } : {}),
      ...(inst.approval
        ? {
            approval: {
              id: inst.approval.id,
              label: inst.approval.label,
              detail: inst.approval.detail
            }
          }
        : {})
    })
  }
}
