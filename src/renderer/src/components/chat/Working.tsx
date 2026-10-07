import { useState } from 'react'
import Orb, { type OrbState } from '../Orb'

export type Segment =
  | { kind: 'thinking' | 'text'; text: string }
  | {
      kind: 'tool'
      id: string
      label: string
      status: 'running' | 'done' | 'error' | 'not-run' | 'unknown'
      write?: boolean
    }
  | { kind: 'fallback'; to: string }
  | { kind: 'compacting' }

type Stage = {
  label: string
  detail?: string
  status: 'active' | 'done' | 'error' | 'skipped'
  orb: OrbState
}

export type Approval = {
  id: string
  plugin: string
  label: string
  detail: string
  warning?: string
  once?: boolean
  edit?: { path: string; old: string; new: string }
}

// The latest line of the thinking summary, as a hint of what it's on now.
function latestThought(text: string): string | undefined {
  const line = text
    .split('\n')
    .map((l) => l.replace(/[*#_`]/g, '').trim())
    .filter(Boolean)
    .pop()
  return line && line.length > 90 ? `${line.slice(0, 90)}…` : line
}

function toStages(segments: Segment[]): Stage[] {
  const stages: Stage[] = [
    {
      label: 'Reading your message',
      status: segments.length ? 'done' : 'active',
      orb: 'breathing'
    }
  ]
  segments.forEach((seg, i) => {
    const last = i === segments.length - 1
    const status: Stage['status'] = last ? 'active' : 'done'
    if (seg.kind === 'tool')
      stages.push({
        label: seg.label,
        detail:
          seg.status === 'unknown'
            ? 'Outcome unknown'
            : seg.status === 'not-run'
              ? 'Not run'
              : undefined,
        status:
          seg.status === 'error' || seg.status === 'unknown'
            ? 'error'
            : seg.status === 'not-run'
              ? 'skipped'
              : seg.status === 'running'
                ? 'active'
                : 'done',
        orb: seg.write ? 'weaving' : 'searching'
      })
    else if (seg.kind === 'compacting')
      stages.push({ label: 'Summarizing earlier messages to make room', status, orb: 'weaving' })
    else if (seg.kind === 'fallback')
      stages.push({ label: `Continuing with ${seg.to}`, status, orb: 'connecting' })
    else if (seg.kind === 'thinking')
      stages.push({ label: 'Thinking', detail: latestThought(seg.text), status, orb: 'working' })
    else stages.push({ label: 'Writing', status, orb: 'composing' })
  })
  // Between a finished vault action and the model's next move.
  const last = segments[segments.length - 1]
  if (last?.kind === 'tool' && last.status !== 'running')
    stages.push({ label: 'Working out the next step', status: 'active', orb: 'solving' })
  return stages
}

// Shown while a reply is being made: the orb holds the centre and thin stage
// lines underneath tick off what it's doing. The answer itself appears, in
// the normal format, once it's finished.
// Exactly what a note edit replaces, and with what.
function EditPreview({
  edit
}: {
  edit: { path: string; old: string; new: string }
}): React.JSX.Element {
  const box =
    'mt-1 max-h-40 overflow-auto rounded-lg bg-forge-950 p-2 text-[11px] whitespace-pre-wrap [overflow-wrap:anywhere]'
  return (
    <div className="mt-2 text-xs">
      <p className="text-ash-500">Replaces this, which appears once in the note:</p>
      <pre
        aria-label="Text replaced"
        className={`${box} text-ash-400 line-through decoration-ember-600/60`}
      >
        {edit.old}
      </pre>
      <p className="mt-2 text-ash-500">With:</p>
      <pre aria-label="Replacement" className={`${box} text-ash-200`}>
        {edit.new || '(nothing: the passage is removed)'}
      </pre>
      <p className="mt-2 text-ash-500">
        A copy of the note from before the edit is kept, and you can undo it from the chat.
      </p>
    </div>
  )
}

// A plugin action waiting for the user. Nothing runs until they choose.
function ApprovalCard({ a }: { a: Approval }): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const answer = (d: 'once' | 'chat' | 'deny'): void => {
    setBusy(true)
    window.custard.chat.approve(a.id, d)
  }
  return (
    <div
      className="stage-in w-full max-w-md rounded-2xl border border-molten-500/40 bg-forge-850 p-4"
      role="alertdialog"
      aria-label={a.edit ? 'Allow note edit' : 'Allow plugin action'}
    >
      <p className="text-sm text-ash-100">
        <span className="text-molten-200">{a.plugin}</span> wants to: {a.label}
      </p>
      {a.warning && <p className="mt-2 text-sm text-ember-600">{a.warning}</p>}
      {a.edit && <EditPreview edit={a.edit} />}
      {a.detail && a.detail !== '{}' && (
        <pre className="mt-2 max-h-40 overflow-auto rounded-lg bg-forge-950 p-2 text-[11px] text-ash-400">
          {a.detail}
        </pre>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          disabled={busy}
          onClick={() => answer('once')}
          className="molten-fill rounded-lg px-3 py-1.5 text-sm font-medium text-forge-950 disabled:opacity-40"
        >
          Allow
        </button>
        {!a.warning && !a.once && (
          <button
            disabled={busy}
            onClick={() => answer('chat')}
            className="rounded-lg border border-forge-700 px-3 py-1.5 text-sm text-ash-300 hover:text-molten-200 disabled:opacity-40"
          >
            Allow for this chat
          </button>
        )}
        <button
          disabled={busy}
          onClick={() => answer('deny')}
          className="rounded-lg border border-forge-700 px-3 py-1.5 text-sm text-ash-400 hover:border-ember-600 hover:text-ember-600 disabled:opacity-40"
        >
          Don&apos;t allow
        </button>
      </div>
    </div>
  )
}

function Working({
  segments,
  approvals = []
}: {
  segments: Segment[]
  approvals?: Approval[]
}): React.JSX.Element {
  const stages = toStages(segments)
  const current = stages[stages.length - 1]
  return (
    <div className="flex min-h-[45vh] flex-col items-center justify-center gap-8 py-6">
      <Orb size={96} state={approvals.length ? 'breathing' : current.orb} />
      <ol className="flex w-full max-w-md flex-col gap-2.5" aria-live="polite">
        {stages.map((s, i) => (
          <li key={i} className="stage-in">
            <div className="flex items-center gap-2.5 text-xs">
              <span
                className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center text-[10px] ${
                  s.status === 'error'
                    ? 'text-ember-600'
                    : s.status === 'done'
                      ? 'text-molten-400'
                      : 'text-molten-200'
                }`}
              >
                {s.status === 'done'
                  ? '✓'
                  : s.status === 'error'
                    ? '✕'
                    : s.status === 'skipped'
                      ? '–'
                      : '●'}
              </span>
              <span
                className={`truncate ${s.status === 'active' ? 'text-ash-100' : s.status === 'error' ? 'text-ember-600' : 'text-ash-400'}`}
              >
                {s.label}
              </span>
            </div>
            <div
              className={`stage-track mt-1.5 ml-6 ${s.status === 'active' ? 'is-active' : ''}`}
            />
            {(s.status === 'active' || s.status === 'error' || s.status === 'skipped') &&
              s.detail && (
                <p className="mt-1.5 ml-6 truncate text-[11px] text-ash-500">{s.detail}</p>
              )}
          </li>
        ))}
      </ol>
      {approvals.map((a) => (
        <ApprovalCard key={a.id} a={a} />
      ))}
    </div>
  )
}

export default Working
