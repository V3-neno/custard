import { useEffect, useRef, useState } from 'react'
import type { Job, Version } from '../../../../../shared/design'
import { jobOf, mediaUrl, type ViewerProps } from './types'

// A generated image: fit or actual size, zoom, and where it came from. An
// edit (of images attached in the chat) is told apart from a new image made
// from the prompt alone. Even an edit is redrawn by the provider, so it can
// differ beyond what was asked.

const pill =
  'rounded-full border border-forge-700 px-3 py-1 text-xs text-ash-300 transition-colors hover:border-molten-500/50 hover:text-molten-200 disabled:opacity-40'
const pillOn = 'rounded-full border border-molten-500/60 px-3 py-1 text-xs text-molten-200'

const ZOOMS = [0.25, 0.5, 1, 1.5, 2, 3, 4]

function origin(v: Version, job: Job | undefined, all: Version[]): string {
  const parent = all.find((x) => x.id === v.parent)
  const of = parent ? ` v${parent.n}` : ' an earlier version'
  const op = job?.request.operation
  const refs = job?.request.references.length ?? 0
  if (v.relation === 'first')
    return op === 'image.edit'
      ? `Made from ${refs === 1 ? 'an attached image' : `${refs} attached images`}`
      : 'New image from the prompt'
  const what = v.relation === 'variation' ? 'Variation of' : 'Change to'
  const files = refs === 1 ? 'an attached image' : `${refs} attached images`
  if (op === 'image.edit') return `${what}${of}: an edit of ${files}`
  if (op === 'image.generate') return `${what}${of}: a new image from the prompt, not an edit`
  return `${what}${of}`
}

function describeSource(v: Version): string {
  const s = v.source
  if (s.kind === 'image-provider')
    return `${s.provider === 'openai' ? 'OpenAI' : s.provider} · ${s.model}`
  if (s.kind === 'plugin') return `Plugin ${s.pluginId}`
  return s.model
}

function Viewer({ chat, artifact, version }: ViewerProps): React.JSX.Element {
  const [job, setJob] = useState<Job | undefined>()
  const [zoom, setZoom] = useState<number | 'fit'>('fit')
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null)
  const [broken, setBroken] = useState(false)
  const [saved, setSaved] = useState<string | null>(null)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let live = true
    window.custard.design
      .jobs(chat)
      .then((list) => live && setJob(jobOf(list, artifact.id, version.id)))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [chat, artifact.id, version.id])

  const file = version.files.find((f) => f.mime.startsWith('image/'))
  const step = (dir: 1 | -1): void => {
    const now = zoom === 'fit' ? fitScale() : zoom
    const next =
      dir > 0 ? ZOOMS.find((z) => z > now + 0.01) : [...ZOOMS].reverse().find((z) => z < now - 0.01)
    if (next) setZoom(next)
  }
  const fitScale = (): number => {
    const el = box.current
    if (!el || !natural) return 1
    return Math.min(1, el.clientWidth / natural.w, el.clientHeight / natural.h)
  }
  const save = async (): Promise<void> => {
    const r = await window.custard.design.export(chat, artifact.id, version.id)
    setSaved(r.ok ? `Saved to ${r.path}` : r.canceled ? null : r.error)
  }

  const header = (
    <div className="flex flex-wrap items-center gap-2 border-b border-forge-800 px-3 py-2">
      <span
        className="mr-auto truncate text-xs text-ash-400"
        title={origin(version, job, artifact.versions)}
      >
        v{version.n} · {origin(version, job, artifact.versions)}
      </span>
      {file && version.status === 'succeeded' && (
        <>
          <button className={zoom === 'fit' ? pillOn : pill} onClick={() => setZoom('fit')}>
            Fit
          </button>
          <button className={zoom === 1 ? pillOn : pill} onClick={() => setZoom(1)}>
            100%
          </button>
          <button className={pill} aria-label="Zoom out" onClick={() => step(-1)}>
            −
          </button>
          <span className="w-10 text-center text-xs text-ash-500">
            {zoom === 'fit' ? 'fit' : `${Math.round(zoom * 100)}%`}
          </span>
          <button className={pill} aria-label="Zoom in" onClick={() => step(1)}>
            +
          </button>
          <button className={pill} onClick={save}>
            Save a copy
          </button>
        </>
      )}
    </div>
  )

  let body: React.JSX.Element
  if (version.status === 'pending')
    body = (
      <p className="m-auto max-w-sm text-center text-sm text-ash-400">
        Waiting for the image.{' '}
        {job?.state === 'unknown' ? job.error : 'Check it from the job list.'}
      </p>
    )
  else if (version.status !== 'succeeded' || !file)
    body = (
      <p className="m-auto max-w-sm text-center text-sm text-ember-600">
        {version.status === 'cancelled' ? 'Cancelled.' : (version.error ?? 'No image was made.')}
        <span className="mt-1 block text-ash-500">The last good version is still kept.</span>
      </p>
    )
  else if (broken)
    body = (
      <p className="m-auto text-sm text-ember-600">
        This image file is missing or damaged on this computer.
      </p>
    )
  else
    body = (
      <img
        src={mediaUrl(chat, artifact.id, version.id, file.path)}
        alt={`${artifact.name}, version ${version.n}`}
        draggable={false}
        onLoad={(e) =>
          setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })
        }
        onError={() => setBroken(true)}
        className={
          zoom === 'fit' ? 'm-auto max-h-full max-w-full object-contain' : 'm-auto max-w-none'
        }
        style={
          zoom === 'fit' || !natural
            ? undefined
            : { width: natural.w * zoom, height: natural.h * zoom }
        }
      />
    )

  return (
    <div className="flex h-full min-h-0 flex-col">
      {header}
      <div ref={box} className="flex min-h-0 flex-1 overflow-auto bg-forge-950 p-3">
        {body}
      </div>
      <div className="flex flex-wrap gap-x-3 border-t border-forge-800 px-3 py-1.5 text-[11px] text-ash-500">
        <span>{describeSource(version)}</span>
        {natural && (
          <span>
            {natural.w}×{natural.h}
          </span>
        )}
        {file && (
          <span>{Math.max(1, Math.round(file.size / 1024)).toLocaleString('en-US')} KB</span>
        )}
        {saved && <span className="text-ash-400">{saved}</span>}
      </div>
    </div>
  )
}

// A different version starts fitted again.
export default function ImageViewer(props: ViewerProps): React.JSX.Element {
  return <Viewer key={props.version.id} {...props} />
}
