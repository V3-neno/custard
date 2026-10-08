import type {
  WidgetCallResult,
  WidgetContext,
  WidgetDefinition,
  WidgetPresentation
} from './widget'

// Runs inside a widget's sandboxed view. It connects the plugin's widget to
// the host bridge. It enforces nothing: every call is checked again in the
// main process.

type HostEvent =
  | {
      type: 'mount'
      widgetId: string
      input: unknown
      presentation: WidgetPresentation
      visible: boolean
      restored: boolean
      theme: Record<string, string>
    }
  | { type: 'input'; input: unknown }
  | { type: 'visibility'; visible: boolean }
  | { type: 'presentation'; presentation: WidgetPresentation }
  | { type: 'refresh' }
  | { type: 'theme'; theme: Record<string, string> }
  | { type: 'unmount' }

type Bridge = {
  register(onEvent: (e: HostEvent) => void): void
  ready(): void
  fail(message: string): void
  call(tool: string, input: unknown): Promise<WidgetCallResult>
  setHeight(px: number): void
  log(message: string): void
}

const describe = (err: unknown): string =>
  String((err as { message?: string })?.message ?? err).slice(0, 300)

function applyTheme(theme: Record<string, string> | undefined): void {
  for (const [k, v] of Object.entries(theme ?? {}))
    if (/^--custard-[a-z-]+$/.test(k) && typeof v === 'string')
      document.documentElement.style.setProperty(k, v)
}

export function startWidget(def: WidgetDefinition): void {
  const host = (globalThis as unknown as { custardWidgetHost: Bridge }).custardWidgetHost
  const state = {
    widgetId: '',
    input: undefined as unknown,
    presentation: 'compact' as WidgetPresentation,
    visible: true,
    restored: false
  }
  const ctx: WidgetContext = {
    get widgetId() {
      return state.widgetId
    },
    get input() {
      return state.input
    },
    get presentation() {
      return state.presentation
    },
    get visible() {
      return state.visible
    },
    get restored() {
      return state.restored
    },
    call: (tool, input) => host.call(String(tool), input ?? {}),
    setHeight: (px) => host.setHeight(Number(px)),
    log: (message) => host.log(String(message))
  }
  // A hook that throws is logged; only a failed mount takes the widget down.
  const guard = async (what: string, fn: () => unknown): Promise<void> => {
    try {
      await fn()
    } catch (err) {
      host.log(`${what} failed: ${describe(err)}`)
    }
  }
  addEventListener('error', (e) => host.log(`Error: ${describe(e.error ?? e.message)}`))
  addEventListener('unhandledrejection', (e) => host.log(`Unhandled: ${describe(e.reason)}`))

  host.register(async (e) => {
    switch (e.type) {
      case 'mount': {
        Object.assign(state, {
          widgetId: e.widgetId,
          input: e.input,
          presentation: e.presentation,
          visible: e.visible,
          restored: e.restored
        })
        applyTheme(e.theme)
        const root = document.createElement('div')
        root.id = 'widget-root'
        document.body.appendChild(root)
        try {
          await def.mount(root, ctx)
          host.ready()
        } catch (err) {
          host.fail(describe(err))
        }
        break
      }
      case 'input':
        state.input = e.input
        await guard('update', () => def.update?.(e.input, ctx))
        break
      case 'visibility':
        state.visible = e.visible
        await guard('visibility', () => def.visibility?.(e.visible, ctx))
        break
      case 'presentation':
        state.presentation = e.presentation
        await guard('presentation', () => def.presentation?.(e.presentation, ctx))
        break
      case 'theme':
        applyTheme(e.theme)
        break
      case 'refresh':
        await guard('refresh', () => def.refresh?.(ctx))
        break
      case 'unmount':
        await guard('unmount', () => def.unmount?.(ctx))
        break
    }
  })
}
