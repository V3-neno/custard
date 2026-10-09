import { useEffect, useRef, useState } from 'react'
import type { WidgetView } from '../../../../shared/widgets'

// The space for a plugin widget, above the mode bubbles. With no widget it
// renders nothing at all: no frame, no placeholder, no gap. The widget itself
// is drawn by the plugin in its own sandboxed view, which the main process
// lays over the body below; this component only reports where that is and
// whether anything covers it. The header, close button and approvals are
// Custard's, outside the widget's area, so a widget can't draw over them.

const chip =
  'rounded-full border px-2.5 py-0.5 text-[11px] transition-colors border-forge-700 text-ash-400 hover:text-ash-100'

// Custard's palette, offered to widgets as --custard-* variables.
const THEME: Record<string, string> = {
  '--custard-text': '--color-ash-100',
  '--custard-text-muted': '--color-ash-400',
  '--custard-text-faint': '--color-ash-500',
  '--custard-accent': '--color-molten-400',
  '--custard-accent-strong': '--color-molten-300',
  '--custard-accent-soft': '--color-molten-200',
  '--custard-background': '--color-forge-900',
  '--custard-surface': '--color-forge-850',
  '--custard-surface-raised': '--color-forge-800',
  '--custard-border': '--color-forge-700',
  '--custard-danger': '--color-ember-600',
  '--custard-font': '--font-sans',
  '--custard-font-mono': '--font-mono'
}

function theme(): Record<string, string> {
  const css = getComputedStyle(document.documentElement)
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(THEME)) {
    const value = css.getPropertyValue(v).trim()
    if (value) out[k] = value
  }
  return out
}

function WidgetSlot({
  conversationId,
  requestId,
  provider
}: {
  conversationId: string | null
  requestId: string | null
  provider: string
}): React.JSX.Element | null {
  const [view, setView] = useState<WidgetView | null>(null)
  const body = useRef<HTMLDivElement>(null)

  useEffect(() => window.custard.widgets.onState(setView), [])

  // Which chat is on screen; the main process shows that chat's widget.
  useEffect(() => {
    window.custard.widgets.display({ conversationId, requestId, theme: theme() })
    // The provider's tint is applied by the app after this runs; send it again.
    const frame = requestAnimationFrame(() =>
      window.custard.widgets.display({ conversationId, requestId, theme: theme() })
    )
    return () => cancelAnimationFrame(frame)
  }, [conversationId, requestId, provider])
  useEffect(() => () => window.custard.widgets.display({ conversationId: null }), [])

  const shown =
    view && (view.conversationId === conversationId || (!conversationId && !!requestId))
      ? view
      : null
  const instanceId = shown && !shown.error ? shown.instanceId : null

  // Where the widget's view goes, and whether it can be seen: something
  // drawn over the area (a drawer, a dialog) hides the view, since a native
  // view would otherwise sit on top of it.
  useEffect(() => {
    const el = body.current
    if (!instanceId || !el) return
    let last = ''
    const report = (): void => {
      const r = el.getBoundingClientRect()
      // Inset from the corners, which the frame's rounding clips.
      const dx = Math.min(24, r.width / 2)
      const points = [
        [r.left + dx, r.top + 2],
        [r.right - dx, r.top + 2],
        [r.left + dx, r.bottom - 2],
        [r.right - dx, r.bottom - 2],
        [r.left + r.width / 2, r.top + r.height / 2]
      ]
      const clear =
        document.visibilityState === 'visible' &&
        r.width > 0 &&
        r.height > 0 &&
        r.bottom > 0 &&
        r.top < window.innerHeight &&
        points.every(([x, y]) => {
          const hit = document.elementFromPoint(x, y)
          return hit === el || (!!hit && el.contains(hit))
        })
      const rect = { x: r.left, y: r.top, width: r.width, height: r.height }
      const key = JSON.stringify([rect, clear])
      if (key === last) return
      last = key
      window.custard.widgets.bounds({ instanceId, rect, visible: clear })
    }
    report()
    const resize = new ResizeObserver(report)
    resize.observe(el)
    resize.observe(document.body)
    const mutations = new MutationObserver(report)
    mutations.observe(document.body, { childList: true, subtree: true, attributes: true })
    window.addEventListener('resize', report)
    document.addEventListener('visibilitychange', report)
    const timer = setInterval(report, 500)
    return () => {
      resize.disconnect()
      mutations.disconnect()
      window.removeEventListener('resize', report)
      document.removeEventListener('visibilitychange', report)
      clearInterval(timer)
    }
  }, [instanceId])

  if (!shown) return null
  const close = (): void => void window.custard.widgets.dismiss(shown.instanceId)
  const next = shown.presentation === 'compact' ? 'expanded' : 'compact'
  return (
    <section
      className="stage-in mb-2 overflow-hidden rounded-2xl border border-forge-700 bg-forge-850"
      aria-label={`${shown.title} widget`}
      data-widget={`${shown.pluginId}/${shown.widgetId}`}
    >
      <header className="flex items-center gap-2 px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate text-xs text-ash-400">
          {shown.pluginName !== shown.title && (
            <>
              <span className="text-ash-500">{shown.pluginName}</span>
              <span className="text-forge-600"> · </span>
            </>
          )}
          <span className="text-molten-200">{shown.title}</span>
        </span>
        {!shown.error && shown.presentations.includes(next) && (
          <button
            className={chip}
            onClick={() => void window.custard.widgets.presentation(shown.instanceId, next)}
          >
            {next === 'expanded' ? 'Expand' : 'Compact'}
          </button>
        )}
        <button
          onClick={close}
          aria-label={`Close the ${shown.title} widget`}
          title="Close"
          className="flex h-6 w-6 items-center justify-center rounded-full text-ash-500 transition-colors hover:bg-forge-800 hover:text-ash-100"
        >
          ✕
        </button>
      </header>
      {shown.approval && (
        <div
          className="mx-3 mb-2 rounded-xl border border-molten-500/40 bg-forge-900 p-3"
          role="alertdialog"
          aria-label="Allow widget action"
        >
          <p className="text-sm text-ash-100">
            <span className="text-molten-200">{shown.pluginName}</span> wants to:{' '}
            {shown.approval.label}
          </p>
          {shown.approval.detail && shown.approval.detail !== '{}' && (
            <pre
              aria-label="Everything this action will do"
              tabIndex={0}
              className="mt-2 max-h-40 overflow-auto rounded-lg bg-forge-950 p-2 text-[11px] whitespace-pre-wrap break-words text-ash-400"
            >
              {shown.approval.detail}
            </pre>
          )}
          <div className="mt-2 flex gap-2">
            <button
              onClick={() => void window.custard.widgets.decide(shown.approval!.id, true)}
              className="molten-fill rounded-lg px-3 py-1 text-sm font-medium text-forge-950"
            >
              Allow
            </button>
            <button
              onClick={() => void window.custard.widgets.decide(shown.approval!.id, false)}
              className="rounded-lg border border-forge-700 px-3 py-1 text-sm text-ash-300 hover:text-molten-200"
            >
              Decline
            </button>
          </div>
        </div>
      )}
      {shown.error ? (
        <p className="px-3 pb-3 text-sm text-ember-600" role="status">
          {shown.error}
        </p>
      ) : (
        <div ref={body} data-widget-body style={{ height: shown.height }} />
      )}
    </section>
  )
}

export default WidgetSlot
