// custard-plugin-sdk, API version 1. Documented in docs/plugins/API.md.
//
// Plugin code runs in a sandboxed window with no Node.js and no direct
// network. Everything it can do outside its own memory goes through the
// context below, and the host checks each call against the permissions the
// user granted.

export const API_VERSION = 1

export type ConfigValue = string | number | boolean

export interface PluginResponse {
  status: number
  ok: boolean
  headers: { get(name: string): string | null }
  text(): Promise<string>
  json<T = unknown>(): Promise<T>
}

export interface FetchInit {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD'
  headers?: Record<string, string>
  body?: string
  // Ask the host to add the signed-in account's access token. Only works for
  // the manifest's auth.apiHosts; the plugin never sees the token.
  auth?: boolean
}

export interface PluginContext {
  // Aborted when the call times out, is cancelled or the plugin is disabled.
  signal: AbortSignal
  // https requests to hosts in permissions.network.
  fetch(url: string, init?: FetchInit): Promise<PluginResponse>
  // Plugin-scoped key-value storage (needs permissions.storage). Values are JSON.
  storage: {
    get<T = unknown>(key: string): Promise<T | undefined>
    set(key: string, value: unknown): Promise<void>
    delete(key: string): Promise<void>
  }
  // The user's non-secret configuration values. Secrets are never given to plugins.
  config: Record<string, ConfigValue>
  // Open a URL matching permissions.openExternal with the OS.
  openExternal(url: string): Promise<void>
  // A line in the plugin's log in Settings. Keep it short; it is redacted.
  log(message: string): void
}

// `data` is for the plugin's widgets only (see custard-plugin-sdk/widget): the
// model sees `content`, never `data`. Keep it JSON and under 64 KB.
export type ToolResult = string | { content: string; isError?: boolean; data?: unknown }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ToolHandler<I = any> = (
  input: I,
  ctx: PluginContext
) => Promise<ToolResult> | ToolResult

export interface PluginDefinition {
  // One handler per tool in plugin.json, by its short name ("search", not "spotify__search").
  tools: Record<string, ToolHandler>
}

export function definePlugin(def: PluginDefinition): PluginDefinition {
  return def
}

// Throw this for an expected failure; its message is shown to the model as is.
// Other errors are reported with a generic message plus their redacted text.
export class PluginError extends Error {
  readonly pluginError = true
}
