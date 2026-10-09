import { useEffect, useRef, useState } from 'react'
import type { Device } from './devices'
import type { ViewerProps } from './viewers/types'

// An HTML version: its live preview or its code. The preview itself is drawn
// by the main process in a sandboxed view of its own (no preload, no network,
// see docs/design/SANDBOX.md) laid over the box below; this component only
// reports where the box is and whether anything covers it, and shows what
// the main process says about the page. Never an iframe in this window.

// Mirrors PreviewState in main/design/html/preview.ts.
type PreviewState = {
  key: string
  status: 'loading' | 'ready' | 'failed' | 'stopped'
  message?: string
  errors: string[]
  blocked: number
  zoom: number
}

function Preview({
  chat,
  artifact,
  version,
  device
}: ViewerProps & { device: Device }): React.JSX.Element {
  const box = useRef<HTMLDivElement>(null)
  const key = `${artifact.id}/${version.id}`
  const [state, setState] = useState<PreviewState | null>(null)
  const [showErrors, setShowErrors] = useState(false)

  useEffect(
    () =>
      window.custard.design.preview.onState((s) => {
        const p = s as PreviewState
        if (p?.key === key) setState(p)
      }),
    [key]
  )

  useEffect(() => {
    void window.custard.design.preview.show({
      chat,
      artifactId: artifact.id,
      versionId: version.id,
      width: device.width
    })
  }, [chat, artifact.id, version.id, device.width])
  useEffect(() => () => void window.custard.design.preview.hide(), [])

  // Where the view goes, and whether it can be seen: anything drawn over the
  // box (a drawer, a dialog) hides it, since a native view would sit on top.
  useEffect(() => {
    const el = box.current
    if (!el) return
    let last = ''
    const report = (): void => {
      const r = el.getBoundingClientRect()
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
        points.every(([x, y]) => {
          const hit = document.elementFromPoint(x, y)
          return hit === el || (!!hit && el.contains(hit))
        })
      const rect = clear
        ? { x: r.left, y: r.top, width: r.width, height: r.height }
        : { x: 0, y: 0, width: 0, height: 0 }
      const k = JSON.stringify(rect)
      if (k === last) return
      last = k
      window.custard.design.preview.bounds(rect)
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
      window.custard.design.preview.bounds({ x: 0, y: 0, width: 0, height: 0 })
    }
  }, [key])

  const s = state?.key === key ? state : null
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={box}
        data-preview-box
        className="relative min-h-0 flex-1 overflow-hidden rounded-xl border border-forge-700 bg-forge-950"
      >
        {s?.status === 'stopped' && (
          <p className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-ember-600">
            {s.message}
          </p>
        )}
      </div>
      <div
        className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[11px] text-ash-500"
        role="status"
      >
        <span title="Shown in a sandbox: no network, no access to Custard, your files or your vault">
          Generated preview · sandboxed, no network
        </span>
        <span data-preview-status={s?.status ?? 'loading'}>
          {!s || s.status === 'loading'
            ? 'Loading…'
            : s.status === 'ready'
              ? 'Loaded'
              : s.status === 'failed'
                ? (s.message ?? 'Failed to load')
                : 'Stopped'}
        </span>
        {s && s.zoom < 1 && <span>Scaled to {Math.round(s.zoom * 100)}% to fit</span>}
        {s && s.blocked > 0 && (
          <span title="Requests to the internet, your network or local files are blocked in previews">
            {s.blocked} {s.blocked === 1 ? 'request' : 'requests'} blocked
          </span>
        )}
        {s && s.errors.length > 0 && (
          <button
            className="text-ember-600 hover:underline"
            onClick={() => setShowErrors((x) => !x)}
          >
            {s.errors.length} {s.errors.length === 1 ? 'error' : 'errors'}
          </button>
        )}
        {/* Tab can't leave the preview on its own; F6 hands focus back (preview.ts). */}
        <span
          className="ml-auto"
          title="Tab moves within the preview. Press F6 to return to Custard."
          data-preview-f6-hint
        >
          <kbd className="rounded border border-forge-700 px-1 font-mono text-[10px] text-ash-400">
            F6
          </kbd>{' '}
          leaves the preview
        </span>
      </div>
      {showErrors && s && s.errors.length > 0 && (
        <ul
          aria-label="Errors from the page"
          className="mt-1 max-h-28 overflow-auto rounded-lg bg-forge-950 p-2 font-mono text-[11px] break-words text-ash-400"
        >
          {s.errors.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Code({ chat, artifact, version }: ViewerProps): React.JSX.Element {
  const [loaded, setLoaded] = useState<{ key: string; text: string | null } | null>(null)
  const [copied, setCopied] = useState(false)
  const key = `${artifact.id}/${version.id}`
  useEffect(() => {
    let gone = false
    void window.custard.design
      .source(chat, artifact.id, version.id)
      .then((text) => !gone && setLoaded({ key, text }))
    return () => {
      gone = true
    }
  }, [chat, artifact.id, version.id, key])
  const text = loaded?.key === key ? loaded.text : undefined
  const others = version.files.filter((f) => f.path !== 'index.html')
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative min-h-0 flex-1 overflow-auto rounded-xl border border-forge-700 bg-forge-950">
        {text === undefined ? (
          <p className="p-4 text-sm text-ash-500">Loading…</p>
        ) : text === null ? (
          <p className="p-4 text-sm text-ember-600">
            Custard&apos;s copy of this version is missing or changed.
          </p>
        ) : (
          <>
            <button
              onClick={() => {
                void navigator.clipboard.writeText(text)
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
              }}
              className="sticky top-2 float-right mr-2 rounded-full border border-forge-700 bg-forge-850 px-2.5 py-0.5 text-[11px] text-ash-400 hover:text-ash-100"
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
            <pre
              aria-label="index.html"
              className="p-3 font-mono text-[12px] leading-5 whitespace-pre-wrap break-words text-ash-300"
            >
              {text}
            </pre>
          </>
        )}
      </div>
      {others.length > 0 && (
        <p className="mt-1.5 px-1 text-[11px] text-ash-500">
          Also in this version: {others.map((f) => f.path).join(', ')}
        </p>
      )}
    </div>
  )
}

export default function HtmlViewer(
  props: ViewerProps & { view: 'preview' | 'code'; device: Device }
): React.JSX.Element {
  return props.view === 'code' ? <Code {...props} /> : <Preview {...props} />
}
