import { useEffect, useState } from 'react'
import type { Job } from '../../../../../shared/design'
import { cleanError } from '../../settings/ui'
import { mediaUrl, type ViewerProps } from './types'

// A video version: native playback controls on the stored file, where it
// came from, and a saved copy through export. While its job runs, the job's
// state as the provider last reported it, with Check, Cancel and Stop
// tracking. Nothing here checks on its own: every check is a click.

const chip =
  'rounded-full border px-3 py-1 text-xs transition-colors disabled:opacity-40 border-forge-700 text-ash-400 hover:text-ash-100'

const size = (n: number): string =>
  n >= 1024 * 1024
    ? `${(n / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(n / 1024))} KB`

const STATE: Record<Job['state'], string> = {
  'not-submitted': 'Not sent yet',
  pending: 'Waiting at the provider',
  running: 'Being made',
  completed: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
  unknown: "Unknown: it may have been submitted. Don't send it again without checking."
}

function JobPanel({ chat, jobId }: { chat: string; jobId: string }): React.JSX.Element {
  const [job, setJob] = useState<Job | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    window.custard.design
      .jobs(chat)
      .then((all) => live && setJob(all.find((j) => j.id === jobId) ?? null))
    const off = window.custard.design.onEvent((e) => {
      if (e.type === 'job' && e.conversationId === chat && e.job.id === jobId) setJob(e.job)
    })
    return () => {
      live = false
      off()
    }
  }, [chat, jobId])

  const act = async (action: 'check' | 'cancel' | 'stop'): Promise<void> => {
    setBusy(true)
    setNote(null)
    try {
      const r = await window.custard.design.job(chat, action, jobId)
      if ('error' in r) setNote(r.error)
      else {
        setJob(r.job)
        setNote(r.text)
      }
    } catch (err) {
      setNote(cleanError(err))
    } finally {
      setBusy(false)
    }
  }

  if (!job) return <p className="text-sm text-ash-500">This version’s job record is gone.</p>
  const open = job.state === 'pending' || job.state === 'running'
  return (
    <div className="space-y-3 rounded-2xl border border-forge-700 bg-forge-900/60 p-4">
      <div className="flex items-center gap-2 text-sm text-ash-200">
        {open && <span className="h-2 w-2 animate-pulse rounded-full bg-molten-400" />}
        <span>{STATE[job.state]}</span>
        {job.progress !== undefined && open && (
          <span className="text-ash-500">· {Math.round(job.progress * 100)}% per the provider</span>
        )}
      </div>
      {job.progress !== undefined && open && (
        <div className="h-1 overflow-hidden rounded-full bg-forge-800">
          <div
            className="h-full bg-molten-400/70"
            style={{ width: `${Math.round(job.progress * 100)}%` }}
          />
        </div>
      )}
      {job.error && <p className="text-xs text-ash-400">{job.error}</p>}
      {open && (
        <div className="flex flex-wrap gap-2">
          <button className={chip} disabled={busy} onClick={() => act('check')}>
            Check now
          </button>
          <button className={chip} disabled={busy} onClick={() => act('cancel')}>
            Cancel job
          </button>
          {job.tracking && (
            <button
              className={chip}
              disabled={busy}
              onClick={() => act('stop')}
              title="Custard stops checking; the job keeps running at the provider."
            >
              Stop tracking
            </button>
          )}
        </div>
      )}
      {note && <p className="text-xs text-ash-500">{note}</p>}
    </div>
  )
}

export default function VideoViewer(props: ViewerProps): React.JSX.Element {
  // Keyed by version, so playback errors and notes start fresh for each one.
  return <Version key={props.version.id} {...props} />
}

function Version({ chat, artifact, version }: ViewerProps): React.JSX.Element {
  const [broken, setBroken] = useState(false)
  const [saved, setSaved] = useState<string | null>(null)
  const file = version.files.find((f) => f.mime.startsWith('video/'))

  const from =
    version.source.kind === 'plugin'
      ? `Made by the ${version.source.pluginId} plugin (${version.source.providerId})`
      : null

  const save = async (): Promise<void> => {
    setSaved(null)
    try {
      const r = await window.custard.design.export(chat, artifact.id, version.id)
      setSaved(r.ok ? `Saved to ${r.path}` : r.canceled ? null : r.error)
    } catch (err) {
      setSaved(cleanError(err))
    }
  }

  if (version.status === 'pending' && version.jobId)
    return <JobPanel chat={chat} jobId={version.jobId} />
  if (version.status !== 'succeeded' || !file)
    return (
      <div className="rounded-2xl border border-forge-700 bg-forge-900/60 p-4 text-sm text-ash-400">
        {version.status === 'cancelled' ? 'This version was cancelled.' : 'This version failed.'}
        {version.error && <span className="mt-1 block text-xs text-ash-500">{version.error}</span>}
      </div>
    )
  return (
    <div className="flex min-h-0 flex-col gap-3">
      {broken ? (
        <div className="flex aspect-video items-center justify-center rounded-2xl border border-forge-700 bg-forge-950 text-sm text-ash-500">
          The video file is missing or can’t be played here.
        </div>
      ) : (
        <video
          className="max-h-[70vh] w-full rounded-2xl border border-forge-700 bg-black"
          src={mediaUrl(chat, artifact.id, version.id, file.path)}
          controls
          playsInline
          preload="metadata"
          onError={() => setBroken(true)}
        />
      )}
      <div className="flex flex-wrap items-center gap-2 text-xs text-ash-500">
        <span>
          {file.mime.replace('video/', '').toUpperCase()} · {size(file.size)}
        </span>
        {from && <span>· {from}</span>}
        <button className={`${chip} ml-auto`} onClick={save}>
          Save a copy
        </button>
      </div>
      {saved && <p className="text-xs text-ash-500">{saved}</p>}
    </div>
  )
}
