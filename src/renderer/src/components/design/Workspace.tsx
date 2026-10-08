import { useEffect, useState } from 'react'
import type { Artifact, ArtifactKind, Version } from '../../../../shared/design'
import HtmlViewer from './HtmlViewer'
import { DEVICES, type Device } from './devices'
import type { Latest } from './useOutputs'
import SkillsUsed from './SkillsUsed'
import ImageViewer from './viewers/ImageViewer'
import VideoViewer from './viewers/VideoViewer'

// Design's output workspace, beside the conversation: one tab per output,
// its versions (revisions and separate variations), the selected one shown
// (HTML as a sandboxed preview or code, images and video in their viewers),
// export, and which skills shaped it. Only shown when the chat has outputs.

const pill = (on: boolean): string =>
  `rounded-full px-3 py-1 text-xs font-medium transition-colors ${
    on
      ? 'molten-fill text-forge-950'
      : 'border border-forge-700 bg-forge-850/80 text-ash-300 hover:border-molten-500/50 hover:text-molten-200'
  }`
const chip =
  'rounded-full border border-forge-700 px-2.5 py-0.5 text-[11px] text-ash-400 transition-colors hover:border-molten-500/50 hover:text-ash-100 disabled:opacity-40'
const KIND: Record<ArtifactKind, string> = { html: 'Page', image: 'Image', video: 'Video' }
const STATUS: Record<Version['status'], string> = {
  pending: 'in progress',
  succeeded: '',
  failed: 'failed',
  cancelled: 'cancelled'
}

function versionLabel(a: Artifact, v: Version): string {
  const parent = a.versions.find((x) => x.id === v.parent)
  if (v.relation === 'first') return `v${v.n} · first version`
  return `v${v.n} · ${v.relation === 'variation' ? 'variation' : 'revision'} of v${parent?.n ?? '?'}`
}

const viewKey = 'custard.design.view'
const deviceKey = 'custard.design.device'
const stored = <T extends string>(k: string, ok: readonly T[], d: T): T => {
  const v = localStorage.getItem(k)
  return ok.includes(v as T) ? (v as T) : d
}

export default function Workspace({
  chat,
  outputs,
  latest,
  onDraft
}: {
  chat: string
  outputs: Artifact[]
  latest: Latest
  // Puts text in the message box; never sends it.
  onDraft: (text: string) => void
}): React.JSX.Element {
  const [tab, setTab] = useState<string | null>(null)
  const [view, setView] = useState<'preview' | 'code'>(() =>
    stored(viewKey, ['preview', 'code'], 'preview')
  )
  const [deviceId, setDeviceId] = useState<Device['id']>(() =>
    stored(deviceKey, ['desktop', 'tablet', 'phone'], 'desktop')
  )
  const [exported, setExported] = useState<{ key: string; text: string; error: boolean } | null>(
    null
  )
  const [exporting, setExporting] = useState(false)
  useEffect(() => localStorage.setItem(viewKey, view), [view])
  useEffect(() => localStorage.setItem(deviceKey, deviceId), [deviceId])

  // The output that just changed comes to the front.
  const [seen, setSeen] = useState(latest?.seq ?? 0)
  if (latest && latest.seq !== seen) {
    setSeen(latest.seq)
    setTab(latest.id)
  }

  const artifact = outputs.find((a) => a.id === tab) ?? outputs[outputs.length - 1]
  const selected = artifact.versions.find((v) => v.id === artifact.selected) ?? artifact.versions[0]
  const newest = artifact.versions[artifact.versions.length - 1]
  const device = DEVICES.find((d) => d.id === deviceId) ?? DEVICES[0]
  const key = `${artifact.id}/${selected.id}`

  const select = (v: Version): void => {
    if (v.status === 'succeeded' && v.id !== artifact.selected)
      void window.custard.design.select(chat, artifact.id, v.id)
  }
  const doExport = async (): Promise<void> => {
    setExporting(true)
    const r = await window.custard.design.export(chat, artifact.id, selected.id).catch((e) => ({
      ok: false as const,
      error: String(e?.message ?? e)
    }))
    setExporting(false)
    if (r.ok)
      setExported({
        key,
        text: `Exported ${r.files === 1 ? 'to' : `${r.files} files to`} ${r.path}`,
        error: false
      })
    else if (!('canceled' in r && r.canceled)) setExported({ key, text: r.error, error: true })
  }

  return (
    <aside className="flex h-full min-h-0 min-w-0 flex-col gap-2 p-3" aria-label="Design outputs">
      {outputs.length > 1 && (
        <nav className="flex shrink-0 gap-1.5 overflow-x-auto pb-1" aria-label="Outputs">
          {outputs.map((a) => {
            const last = a.versions[a.versions.length - 1]
            return (
              <button
                key={a.id}
                onClick={() => setTab(a.id)}
                aria-current={a.id === artifact.id}
                className={`${pill(a.id === artifact.id)} shrink-0`}
              >
                {a.name}
                <span className="ml-1.5 opacity-60">{KIND[a.kind]}</span>
                {last.status !== 'succeeded' && (
                  <span className="ml-1.5 opacity-80">· {STATUS[last.status]}</span>
                )}
              </button>
            )
          })}
        </nav>
      )}

      <header className="flex shrink-0 flex-wrap items-center gap-2">
        <h2
          className="min-w-0 flex-1 truncate text-sm font-semibold text-molten-200"
          title={artifact.name}
        >
          {artifact.name}
          <span className="ml-2 text-xs font-normal text-ash-500">
            {versionLabel(artifact, selected)}
          </span>
        </h2>
        <button className={chip} onClick={() => void doExport()} disabled={exporting}>
          {exporting ? 'Exporting…' : 'Export'}
        </button>
      </header>

      <div className="flex shrink-0 flex-wrap gap-1" role="group" aria-label="Versions">
        {artifact.versions.map((v) => (
          <button
            key={v.id}
            onClick={() => select(v)}
            disabled={v.status !== 'succeeded'}
            aria-pressed={v.id === selected.id}
            title={
              v.status === 'succeeded'
                ? versionLabel(artifact, v)
                : `${versionLabel(artifact, v)} · ${STATUS[v.status]}${v.error ? `: ${v.error}` : ''}`
            }
            className={`rounded-full px-2.5 py-0.5 text-[11px] transition-colors ${
              v.id === selected.id
                ? 'bg-molten-400/20 text-molten-200 ring-1 ring-molten-400/50'
                : v.status === 'succeeded'
                  ? 'border border-forge-700 text-ash-400 hover:text-ash-100'
                  : 'border border-dashed border-forge-700 text-ash-500'
            }`}
          >
            {v.relation === 'variation' && <span aria-label="variation">◇ </span>}v{v.n}
            {v.status !== 'succeeded' && ` · ${STATUS[v.status]}`}
          </button>
        ))}
      </div>

      {newest.id !== selected.id &&
        newest.status !== 'succeeded' &&
        newest.status !== 'pending' && (
          <p className="shrink-0 px-1 text-xs text-ember-600" role="status">
            v{newest.n} {STATUS[newest.status]}
            {newest.error ? `: ${newest.error}` : ''}. Showing v{selected.n}, the last version that
            worked.
          </p>
        )}

      {artifact.kind === 'html' && (
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          <div className="flex gap-1" role="group" aria-label="View">
            <button className={pill(view === 'preview')} onClick={() => setView('preview')}>
              Preview
            </button>
            <button className={pill(view === 'code')} onClick={() => setView('code')}>
              Code
            </button>
          </div>
          {view === 'preview' && (
            <div className="ml-auto flex gap-1" role="group" aria-label="Width">
              {DEVICES.map((d) => (
                <button
                  key={d.id}
                  className={pill(d.id === device.id)}
                  onClick={() => setDeviceId(d.id)}
                >
                  {d.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col">
        {selected.status !== 'succeeded' ? (
          <p className="m-auto text-sm text-ash-500">
            {selected.status === 'pending'
              ? 'Not ready yet.'
              : `This version ${STATUS[selected.status]}.`}
          </p>
        ) : artifact.kind === 'html' ? (
          <HtmlViewer
            chat={chat}
            artifact={artifact}
            version={selected}
            view={view}
            device={device}
          />
        ) : artifact.kind === 'image' ? (
          <ImageViewer chat={chat} artifact={artifact} version={selected} />
        ) : (
          <VideoViewer chat={chat} artifact={artifact} version={selected} />
        )}
      </div>

      {exported?.key === key && (
        <p
          className={`shrink-0 px-1 text-xs break-all ${exported.error ? 'text-ember-600' : 'text-ash-400'}`}
          role="status"
        >
          {exported.text}
        </p>
      )}

      <div className="flex shrink-0 flex-wrap gap-1.5">
        <button
          className={chip}
          onClick={() => onDraft(`Revise "${artifact.name}" (v${selected.n}): `)}
        >
          Revise
        </button>
        <button
          className={chip}
          onClick={() =>
            onDraft(`Make a variation of "${artifact.name}" (v${selected.n}) beside it: `)
          }
        >
          Variation
        </button>
      </div>

      <SkillsUsed chat={chat} artifact={artifact} version={selected} onDraft={onDraft} />
    </aside>
  )
}
