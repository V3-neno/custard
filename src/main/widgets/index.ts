import { app, BrowserWindow, type WebContents } from 'electron'
import { handle, on } from '../ipc'
import { pluginHost } from '../plugins'
import { conversationMode, messageCount } from '../store'
import type { Mode } from '../../shared/chat'
import type { WidgetBounds, WidgetDisplay, WidgetPresentation } from '../../shared/widgets'
import { WidgetManager } from './manager'
import { widgetRecords } from './records'
import { createSurface } from './surface'

// The widget host's Electron wiring: one manager for the app window, the
// renderer's channels, and the signals that end a widget (plugin changes,
// window state, quitting). The rules are in manager.ts.

let manager: WidgetManager | null = null
let win: BrowserWindow | null = null
let renderer: WebContents | null = null
// Set by chat.ts: the conversation a turn in progress belongs to.
let requestLookup: (requestId: string) => string | null = () => null

export function setRequestLookup(fn: (requestId: string) => string | null): void {
  requestLookup = fn
}

// A widget's plugin may run in its conversation only if that conversation's
// mode allows the plugin (see needsChatDesign in plugins/host.ts). Without a
// known conversation, the strictest mode applies.
function modeOf(conversationId: string | null): Mode {
  return (conversationId && conversationMode(conversationId)) || 'chat'
}

export function widgets(): WidgetManager {
  if (manager) return manager
  const host = pluginHost()
  const m = new WidgetManager({
    catalog: (conversationId) => host.widgetCatalog(modeOf(conversationId)),
    widgetCode: (id, buildId, widgetId) => host.widgetCode(id, buildId, widgetId),
    isWrite: (id, buildId, tool) => host.toolWrites(id, buildId, tool),
    invoke: (name, input, { conversationId, ...o }) =>
      host.invoke(name, input, { ...o, mode: modeOf(conversationId) }),
    log: (id, line) => host.widgetLog(id, line),
    surface: createSurface(() => win),
    records: widgetRecords,
    messageCount,
    conversationForRequest: (r) => requestLookup(r),
    emit: (view) => {
      if (renderer && !renderer.isDestroyed()) renderer.send('widgets:state', view)
    }
  })
  manager = m
  host.onChange((id) => m.pluginChanged(id))
  return m
}

// The window the renderer showing chats lives in; its state decides whether
// a widget counts as visible.
function attach(sender: WebContents): void {
  if (renderer === sender) return
  const w = BrowserWindow.fromWebContents(sender)
  if (!w) return
  if (win && win !== w) widgets().shutdown()
  renderer = sender
  win = w
  const visible = (): void =>
    widgets().windowVisibility(!w.isDestroyed() && w.isVisible() && !w.isMinimized())
  for (const ev of ['minimize', 'restore', 'hide', 'show'] as const) w.on(ev as 'show', visible)
  w.on('closed', () => {
    if (win !== w) return
    widgets().shutdown()
    win = null
    renderer = null
  })
  visible()
}

export function registerWidgetHandlers(): void {
  on('widgets:display', (e, d: WidgetDisplay) => {
    attach(e.sender)
    widgets().display(d && typeof d === 'object' ? d : { conversationId: null })
  })
  on('widgets:bounds', (e, b: WidgetBounds) => {
    if (e.sender !== renderer || !b || typeof b !== 'object' || !b.rect) return
    widgets().bounds(b)
  })
  handle('widgets:dismiss', (e, instanceId: string) => {
    if (e.sender === renderer) widgets().dismiss(String(instanceId))
  })
  handle('widgets:presentation', (e, instanceId: string, p: WidgetPresentation) => {
    if (e.sender === renderer) widgets().setPresentation(String(instanceId), p)
  })
  handle('widgets:decide', (e, approvalId: string, allow: boolean) => {
    if (e.sender === renderer) widgets().decide(String(approvalId), allow === true)
  })
  app.on('before-quit', () => manager?.shutdown())
}
