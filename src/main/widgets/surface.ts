import { ipcMain, WebContentsView, type BrowserWindow, type WebContents } from 'electron'
import { join } from 'path'
import { lockContents, lockedSession, sandboxPreferences } from '../plugins/runtime'
import type { ViewEvents, ViewHandle, ViewSurface } from './manager'

// Each widget is drawn by its own WebContentsView laid over the space the
// chat window leaves for it. The view is a plugin sandbox like the plugin's
// own code: its own renderer process, Chromium's sandbox, no Node.js,
// context isolation, and a session where every request except data: URLs is
// cancelled, so a widget can't load or send anything over the network, even
// by navigating. Its only way out is the widget preload (preload/widget.ts),
// and the main process identifies the widget by the view a message comes
// from, never by anything the widget says.

const CSP =
  "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:"
const PAGE = `data:text/html,${encodeURIComponent(
  `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}"><title>widget</title><style>html,body{margin:0;padding:0;background:transparent;color-scheme:dark;overflow:hidden}</style><body></body>`
)}`

const views = new Map<number, ViewEvents>()

// Widget views are refused on the app's own IPC channels (see main/ipc).
export const isWidgetContents = (wc: WebContents): boolean => views.has(wc.id)

let wired = false
function wireIpc(): void {
  if (wired) return
  wired = true
  const from = (e: { sender: WebContents }): ViewEvents | undefined => views.get(e.sender.id)
  ipcMain.on('widget-view:ready', (e) => from(e)?.ready())
  ipcMain.on('widget-view:fail', (e, m: unknown) => from(e)?.fail(String(m)))
  ipcMain.on('widget-view:height', (e, px: unknown) => from(e)?.setHeight(Number(px)))
  ipcMain.on('widget-view:log', (e, m: unknown) => from(e)?.log(String(m).slice(0, 300)))
  ipcMain.handle('widget-view:call', async (e, tool: unknown, input: unknown) => {
    const v = from(e)
    if (!v) return { status: 'not-run', content: 'Unknown caller.' }
    return v.call(String(tool), input)
  })
}

const widgetPreloadPath = (): string => join(__dirname, '../preload/widget.js')

// Real input reaching the view. Scripts can't produce these.
const GESTURES = new Set(['mouseDown', 'mouseUp', 'keyDown', 'rawKeyDown'])

export function createSurface(window: () => BrowserWindow | null): ViewSurface {
  return {
    create({ pluginId, code, events }): ViewHandle {
      wireIpc()
      const win = window()
      if (!win || win.isDestroyed()) throw new Error('The chat window is gone.')
      const partition = `custard-widget-${pluginId}`
      const view = new WebContentsView({
        webPreferences: { ...sandboxPreferences(partition, widgetPreloadPath()), images: true }
      })
      const wc = view.webContents
      lockContents(wc)
      view.setBackgroundColor('#00000000')
      view.setVisible(false)
      win.contentView.addChildView(view)
      views.set(wc.id, events)

      let destroyed = false
      let loaded = false
      const queue: Record<string, unknown>[] = []
      const send = (ev: Record<string, unknown>): void => {
        if (destroyed || wc.isDestroyed()) return
        if (!loaded) queue.push(ev)
        else wc.send('widget-view:event', ev)
      }
      const destroy = (): void => {
        if (destroyed) return
        destroyed = true
        views.delete(wc.id)
        // Kill the renderer first: closing one stuck in a loop can block.
        if (!wc.isDestroyed() && !wc.isCrashed()) wc.forcefullyCrashRenderer()
        if (!win.isDestroyed()) win.contentView.removeChildView(view)
        if (!wc.isDestroyed()) wc.close()
      }
      wc.on('render-process-gone', (_e, d) => {
        if (destroyed) return
        events.gone(`it crashed: ${d.reason}`)
        destroy()
      })
      wc.on('unresponsive', () => {
        if (destroyed) return
        events.gone('it stopped responding')
        destroy()
      })
      wc.on('input-event', (_e, input) => {
        if (GESTURES.has(input.type)) events.input()
      })

      void lockedSession(partition)
        .then(() => wc.loadURL(PAGE))
        .then(() =>
          wc.executeJavaScript(
            `(function () { try {\n${code}\n; return null } catch (e) { return String((e && e.message) || e) } })()`
          )
        )
        .then((thrown: unknown) => {
          if (typeof thrown === 'string') throw new Error(thrown)
          loaded = true
          for (const ev of queue.splice(0)) wc.send('widget-view:event', ev)
        })
        .catch((err: Error) => {
          if (destroyed) return
          events.fail(`it failed to load: ${String(err?.message ?? err).slice(0, 200)}`)
          destroy()
        })

      return {
        send,
        setBounds: (r) => {
          if (destroyed || win.isDestroyed()) return
          // The renderer measures in CSS pixels; the view is placed in DIPs.
          const z = win.webContents.getZoomFactor()
          view.setBounds({
            x: Math.round(r.x * z),
            y: Math.round(r.y * z),
            width: Math.round(r.width * z),
            height: Math.round(r.height * z)
          })
        },
        setVisible: (v) => {
          if (!destroyed) view.setVisible(v)
        },
        destroy
      }
    }
  }
}
