// custard-plugin-sdk/widget, widget API version 1. Documented in
// docs/plugins/WIDGETS.md.
//
// A widget is UI a plugin draws in a space Custard gives it next to the
// message box. It runs in its own sandboxed view: no Node.js, no network, no
// access to Custard's window. The only way out is `ctx.call`, which runs one
// of the plugin's own tools listed in the widget's `tools` in plugin.json,
// through the same checks and approvals as any plugin action.

export const WIDGET_API_VERSION = 1

export type WidgetPresentation = 'compact' | 'expanded'

export type WidgetCallResult = {
  // completed / failed: the tool ran. not-run: nothing was done (declined,
  // refused, rate-limited, hidden). unknown: a write was sent but its result
  // isn't known; don't repeat it blindly.
  status: 'completed' | 'failed' | 'not-run' | 'unknown'
  // The tool's text result (what the model would see).
  content: string
  // The tool's `data`, if it returned any (see ToolResult in the main SDK).
  data?: unknown
  // Set when the tool returned `data` that Custard left out (over 64 KB, not
  // JSON, or holding a saved credential), with the reason in words. Show the
  // user that the view is out of date rather than keep showing old data.
  dataDropped?: string
}

export interface WidgetContext {
  readonly widgetId: string
  // The latest input from the assistant. Untrusted: validate before use.
  readonly input: unknown
  readonly presentation: WidgetPresentation
  // False while the widget can't be seen (window hidden, area covered).
  readonly visible: boolean
  // True when shown again after the chat was reopened or Custard restarted.
  // Nothing was run on restore; the widget decides what to load.
  readonly restored: boolean
  // Runs one of this plugin's tools listed in the widget's `tools`.
  call(tool: string, input?: Record<string, unknown>): Promise<WidgetCallResult>
  // Asks for a height in px; the host clamps it to the widget's limits.
  setHeight(px: number): void
  // A line in the plugin's log in Settings (redacted, kept short).
  log(message: string): void
}

export interface WidgetDefinition {
  // Draw into `root`. The document is the widget's own; Custard's theme is
  // offered as CSS variables (--custard-text, --custard-accent, …) on :root.
  mount(root: HTMLElement, ctx: WidgetContext): void | Promise<void>
  // The assistant showed the widget again with new input.
  update?(input: unknown, ctx: WidgetContext): void | Promise<void>
  visibility?(visible: boolean, ctx: WidgetContext): void
  presentation?(presentation: WidgetPresentation, ctx: WidgetContext): void
  // The host's periodic signal (refreshSeconds), sent only while visible.
  refresh?(ctx: WidgetContext): void | Promise<void>
  // Last chance to clean up; the view is destroyed shortly after.
  unmount?(ctx: WidgetContext): void
}

export function defineWidget(def: WidgetDefinition): WidgetDefinition {
  return def
}
