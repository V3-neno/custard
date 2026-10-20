// custard-plugin-sdk, API version 1. Documented in docs/plugins/API.md.
//
// Plugin code runs in a sandboxed window with no Node.js and no direct
// network. Everything it can do outside its own memory goes through the
// context below, and the host checks each call against the permissions the
// user granted.

export const API_VERSION = 1

export type ConfigValue = string | number | boolean

// Who started a tool call, set by the host: the model can't choose it.
//   assistant  - a tool call in a model's reply, in any mode
//   widget     - the plugin's own widget. A write from a widget also means the
//                user pressed something in it: the host refuses one without a
//                real click or key press
//   automation - a scheduled skill run (read tools only)
//   design     - Design's media jobs
//   background - Custard by itself, on the manifest's `background` schedule
//                (read tool only, no model, nobody there)
export type Caller = 'assistant' | 'widget' | 'automation' | 'design' | 'background'

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
  // Who started this call, set by the host (see Caller).
  caller: Caller
  // The plugin's event log in the user's vault (needs permissions.events).
  events: {
    // Whether the user turned the log on in Manage. Off by default.
    enabled: boolean
    // Adds one entry to the day's note. `at` (an ISO time within the last
    // day) picks the day; `record` is JSON (at most 4 KB). Custard formats
    // it. Throws when the log is off or the entry is refused; it never
    // changes the tool's result unless the plugin lets it.
    append(entry: { at: string; record: Record<string, unknown> }): Promise<void>
  }
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
