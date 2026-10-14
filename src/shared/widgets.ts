// Plugin widgets: plugin-made UI that the assistant can show next to the
// message box. Custard owns the space, its limits and the bridge; the plugin
// owns everything drawn inside. See docs/plugins/WIDGETS.md.

// Widget contract versions this Custard can host. A widget declares one; a
// version this Custard can't host is a manifest error, so the build is
// refused at review rather than failing in a chat.
export const WIDGET_API_VERSION = 1
export const SUPPORTED_WIDGET_API_VERSIONS = [1]

export type WidgetPresentation = 'compact' | 'expanded'

// A widget in plugin.json.
export type WidgetSpec = {
  id: string
  // Shown in the host's header and to the user on the review screen.
  title: string
  // When the widget helps, for the assistant. Plugin text: treated as data.
  description: string
  widgetApi: number
  // The UI module, bundled on its own and run in the widget's sandbox.
  entry: string
  // What the assistant may pass as the widget's input (validated by the host).
  inputSchema?: import('./plugins').JsonSchema
  // This plugin's tools the widget may call. Write tools still ask the user
  // (per the plugin's "ask every time" settings) and need a real click or key
  // press in the widget first.
  tools: string[]
  // Preferred height in px, clamped to the host's limits.
  height?: { initial?: number; min?: number; max?: number }
  presentations?: WidgetPresentation[]
  // Ask the host for a refresh signal this often while the widget is visible.
  refreshSeconds?: number
}

// The host's limits.
export const WIDGET_LIMITS = {
  minHeight: 32,
  maxHeight: 360,
  defaultHeight: 120,
  minRefreshSeconds: 5,
  maxRefreshSeconds: 3600,
  // Calls a widget instance may make per minute, and the size of data it may
  // receive from one call.
  callsPerMinute: 30,
  dataBytes: 64 * 1024,
  inputBytes: 16 * 1024,
  // A write needs a real click or key press in the widget this recently.
  gestureMs: 5000,
  // From mount until the widget says it's ready.
  loadMs: 8000
} as const

// What the renderer shows for the conversation on screen.
export type WidgetView = {
  conversationId: string
  instanceId: string
  pluginId: string
  pluginName: string
  widgetId: string
  title: string
  height: number
  presentation: WidgetPresentation
  presentations: WidgetPresentation[]
  // Set when the widget failed; the host shows this instead of the widget.
  error?: string
  // A write the widget asked for, waiting for the user.
  approval?: { id: string; label: string; detail: string }
}

// Sent by the renderer: which conversation is on screen, and where the
// widget's area is.
export type WidgetDisplay = {
  conversationId: string | null
  // The turn in progress, for a chat that has no id on screen yet.
  requestId?: string | null
  theme?: Record<string, string>
}

export type WidgetBounds = {
  instanceId: string
  rect: { x: number; y: number; width: number; height: number }
  // False when something covers the area, or it is scrolled or sized away.
  visible: boolean
}

// What a widget call returns to the widget.
export type WidgetCallResult = {
  status: 'completed' | 'failed' | 'not-run' | 'unknown'
  content: string
  data?: unknown
  // Set instead of `data` when the tool returned data that was left out, with
  // the reason ("it is 70 KB and the limit is 64 KB").
  dataDropped?: string
}

export const widgetKey = (pluginId: string, widgetId: string): string => `${pluginId}/${widgetId}`
