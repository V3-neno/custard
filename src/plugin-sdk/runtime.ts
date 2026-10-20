import type {
  Caller,
  ConfigValue,
  FetchInit,
  PluginContext,
  PluginDefinition,
  PluginResponse,
  ToolResult
} from './index'

// Runs inside the plugin's sandboxed window. It connects the plugin's tool
// handlers to the host bridge. It enforces nothing: every capability call is
// checked again in the main process.

type Bridge = {
  register(handlers: {
    call(
      callId: string,
      tool: string,
      input: unknown,
      config: Record<string, ConfigValue>,
      meta?: { caller?: Caller }
    ): Promise<{ content: string; isError: boolean; data?: unknown }>
    cancel(callId: string): void
    tools(): string[]
  }): void
  cap(
    callId: string,
    name: string,
    args: unknown
  ): Promise<{ ok: true; value: unknown } | { ok: false; error: string }>
}

// Host refusals and failures; their messages are written by the host for the model.
class HostError extends Error {
  readonly pluginError = true
}

type WireResponse = { status: number; headers: Record<string, string>; body: string }

function toResponse(r: WireResponse): PluginResponse {
  return {
    status: r.status,
    ok: r.status >= 200 && r.status < 300,
    headers: { get: (n) => r.headers[n.toLowerCase()] ?? null },
    text: async () => r.body,
    json: async <T>() => JSON.parse(r.body) as T
  }
}

function normalize(r: ToolResult): { content: string; isError: boolean; data?: unknown } {
  if (typeof r === 'string') return { content: r, isError: false }
  if (r && typeof r.content === 'string')
    return {
      content: r.content,
      isError: !!r.isError,
      ...(r.data !== undefined ? { data: r.data } : {})
    }
  return { content: 'The tool returned no result.', isError: true }
}

const CALLERS: readonly Caller[] = ['assistant', 'widget', 'automation', 'design']

// Anything the host didn't name is read as the assistant: the value that
// claims the least.
const callerOf = (c: unknown): Caller =>
  CALLERS.includes(c as Caller) ? (c as Caller) : 'assistant'

export function start(def: PluginDefinition): void {
  const host = (globalThis as unknown as { custardPluginHost: Bridge }).custardPluginHost
  const running = new Map<string, AbortController>()

  const contextFor = (
    callId: string,
    signal: AbortSignal,
    config: Record<string, ConfigValue>,
    caller: Caller
  ): PluginContext => {
    const cap = async (name: string, args: unknown): Promise<unknown> => {
      if (signal.aborted) throw new HostError('The call was cancelled.')
      const r = await host.cap(callId, name, args)
      if (!r.ok) throw new HostError(r.error)
      return r.value
    }
    return {
      signal,
      caller,
      config: Object.freeze({ ...config }),
      fetch: async (url: string, init?: FetchInit) =>
        toResponse((await cap('fetch', { url, init })) as WireResponse),
      storage: {
        get: async <T>(key: string) => (await cap('storage.get', { key })) as T | undefined,
        set: async (key: string, value: unknown) => void (await cap('storage.set', { key, value })),
        delete: async (key: string) => void (await cap('storage.delete', { key }))
      },
      openExternal: async (url: string) => void (await cap('openExternal', { url })),
      log: (message: string) => void cap('log', { message: String(message) }).catch(() => {})
    }
  }

  host.register({
    tools: () => Object.keys(def.tools),
    cancel: (callId) => running.get(callId)?.abort(),
    call: async (callId, tool, input, config, meta) => {
      const handler = def.tools[tool]
      if (!handler) return { content: `This plugin has no handler for ${tool}.`, isError: true }
      const controller = new AbortController()
      running.set(callId, controller)
      try {
        return normalize(
          await handler(
            input,
            contextFor(callId, controller.signal, config, callerOf(meta?.caller))
          )
        )
      } catch (err) {
        const e = err as { message?: string; pluginError?: boolean }
        return {
          content: e?.pluginError
            ? String(e.message)
            : `The plugin failed: ${String(e?.message ?? err)}`,
          isError: true
        }
      } finally {
        running.delete(callId)
      }
    }
  })
}
