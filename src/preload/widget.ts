import { contextBridge, ipcRenderer } from 'electron'

// Preload for plugin widget views (see main/widgets/surface). It exposes one
// object to the widget's code and nothing else from Electron. The main
// process knows which widget a message comes from by the view it arrived
// from and checks every call again.

type Handler = (event: unknown) => unknown

let handler: Handler | null = null
const pending: unknown[] = []
// Host events reach the widget one at a time, in order.
let chain: Promise<unknown> = Promise.resolve()
const deliver = (event: unknown): void => {
  const h = handler
  if (!h) {
    pending.push(event)
    return
  }
  chain = chain.then(
    () => h(event),
    () => h(event)
  )
}

contextBridge.exposeInMainWorld('custardWidgetHost', {
  register(h: Handler): void {
    if (handler || typeof h !== 'function') return
    handler = h
    for (const e of pending.splice(0)) deliver(e)
  },
  ready: (): void => ipcRenderer.send('widget-view:ready'),
  fail: (message: string): void => ipcRenderer.send('widget-view:fail', String(message)),
  call: (tool: string, input: unknown): Promise<unknown> =>
    ipcRenderer.invoke('widget-view:call', String(tool), input),
  setHeight: (px: number): void => ipcRenderer.send('widget-view:height', Number(px)),
  log: (message: string): void => ipcRenderer.send('widget-view:log', String(message))
})

ipcRenderer.on('widget-view:event', (_e, event: unknown) => deliver(event))
