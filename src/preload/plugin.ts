import { contextBridge, ipcRenderer } from 'electron'

// Preload for plugin sandboxes. It exposes exactly two functions to plugin
// code and nothing else from Electron. The host checks every capability call.

type Handlers = {
  call(
    callId: string,
    tool: string,
    input: unknown,
    config: unknown,
    meta: unknown
  ): Promise<unknown>
  cancel(callId: string): void
  tools(): string[]
}

let handlers: Handlers | null = null

contextBridge.exposeInMainWorld('custardPluginHost', {
  register(h: Handlers): void {
    if (handlers) return
    handlers = h
    ipcRenderer.send('plugin-host:ready', h.tools())
  },
  // Returns { ok, value } or { ok: false, error }; the runtime unwraps it.
  cap: (callId: string, name: string, args: unknown): Promise<unknown> =>
    ipcRenderer.invoke('plugin-host:cap', String(callId), String(name), args)
})

ipcRenderer.on(
  'plugin-host:call',
  async (_e, callId: string, tool: string, input: unknown, config: unknown, meta: unknown) => {
    let result: unknown
    try {
      if (!handlers) throw new Error('The plugin did not register.')
      result = await handlers.call(callId, tool, input, config, meta)
    } catch (err) {
      result = {
        content: `The plugin failed: ${(err as Error)?.message ?? String(err)}`,
        isError: true
      }
    }
    ipcRenderer.send('plugin-host:result', callId, result)
  }
)

ipcRenderer.on('plugin-host:cancel', (_e, callId: string) => handlers?.cancel(callId))
