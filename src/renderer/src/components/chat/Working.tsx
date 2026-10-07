import Orb, { type OrbState } from '../Orb'

export type Segment =
  | { kind: 'thinking' | 'text'; text: string }
  | { kind: 'tool'; id: string; label: string; status: 'running' | 'done' | 'error' }
  | { kind: 'fallback'; to: string }

type Stage = {
  label: string
  detail?: string
  status: 'active' | 'done' | 'error'
  orb: OrbState
}

const isWrite = (label: string): boolean =>
  /^(Created|Added|Saved|Spotify queue|Opened|Moved|Started)/.test(label)

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
        status: seg.status === 'error' ? 'error' : seg.status === 'running' ? 'active' : 'done',
        orb: isWrite(seg.label) ? 'weaving' : 'searching'
      })
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
function Working({ segments }: { segments: Segment[] }): React.JSX.Element {
  const stages = toStages(segments)
  const current = stages[stages.length - 1]
  return (
    <div className="flex min-h-[45vh] flex-col items-center justify-center gap-8 py-6">
      <Orb size={96} state={current.orb} />
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
                {s.status === 'done' ? '✓' : s.status === 'error' ? '✕' : '●'}
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
            {s.status === 'active' && s.detail && (
              <p className="mt-1.5 ml-6 truncate text-[11px] text-ash-500">{s.detail}</p>
            )}
          </li>
        ))}
      </ol>
    </div>
  )
}

export default Working
