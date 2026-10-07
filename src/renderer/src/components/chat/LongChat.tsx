import { useState } from 'react'
import {
  chatModels,
  providerNames,
  type ChatLink,
  type Compaction,
  type Continuation,
  type ContextUse
} from '../../../../shared/chat'

// What a long chat shows: where a provider summarized earlier messages, a
// note when it is getting long, and the way on in a new chat.

const pill =
  'rounded-full border border-molten-500/50 px-3 py-1 text-xs text-molten-200 transition-colors hover:border-molten-400 hover:shadow-[0_0_10px_rgb(var(--glow)/0.25)] disabled:opacity-40'
const quiet =
  'rounded-full border border-forge-700 px-3 py-1 text-xs text-ash-400 transition-colors hover:border-molten-500/50 hover:text-molten-200 disabled:opacity-40'

const modelLabel = (id: string): string => chatModels.find((m) => m.id === id)?.label ?? id

// A thin line where earlier messages were compacted. The messages above it
// are still all here; the model now sees a summary of them.
export function CompactionLine({ k }: { k: Compaction }): React.JSX.Element {
  return (
    <div
      role="note"
      className="flex items-center gap-3 text-[11px] text-ash-500"
      title={`${providerNames[k.provider]} summarized everything above this line so the chat fits. The messages above are kept here unchanged; ${modelLabel(k.model)} now works from its summary of them and from Custard's record of actions.`}
    >
      <span className="forge-line h-px flex-1" />
      <span>Earlier messages summarized by {providerNames[k.provider]} to make room</span>
      <span className="forge-line h-px flex-1" />
    </div>
  )
}

// The chat is getting long, or has become too long to go on.
export function LengthNotice({
  use,
  tooLong,
  onContinue,
  busy
}: {
  use?: ContextUse
  tooLong: boolean
  onContinue: () => void
  busy: boolean
}): React.JSX.Element {
  const share = use ? Math.min(100, Math.round((use.tokens / use.budget) * 100)) : null
  return (
    <div
      role="status"
      aria-label="Chat length"
      className="flex flex-wrap items-center gap-3 rounded-xl border border-forge-700 px-3 py-2 text-xs text-ash-400"
    >
      <span className={tooLong ? 'text-ember-600' : 'text-molten-300'}>●</span>
      <span className="flex-1">
        {tooLong
          ? 'This chat is too long to go on. A new chat can carry on from here; this one stays as it is.'
          : `This chat is getting long: ${use?.exact ? '' : 'about '}${share}% of what ${modelLabel(use!.model)} can take in. A new chat can carry on from here.`}
      </span>
      <button onClick={onContinue} disabled={busy} className={pill}>
        Continue in a new chat
      </button>
    </div>
  )
}

export type HandoffState = { busy: true } | { busy: false; error: string; canSkip: boolean }

// While the handoff is written, and what to do when it can't be.
export function HandoffProgress({
  state,
  onRetry,
  onSkip,
  onCancel
}: {
  state: HandoffState
  onRetry: () => void
  onSkip: () => void
  onCancel: () => void
}): React.JSX.Element {
  if (state.busy)
    return (
      <div role="status" className="flex items-center gap-3 px-3 py-2 text-xs text-ash-400">
        <span className="h-2 w-2 animate-pulse rounded-full bg-molten-400" />
        Writing a short handoff for the new chat. Nothing in this chat changes.
      </div>
    )
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-2 rounded-xl border border-forge-700 px-3 py-2 text-xs text-ash-400"
    >
      <span className="text-ember-600">●</span>
      <span className="flex-1">{state.error} This chat is unchanged.</span>
      <button onClick={onRetry} className={pill}>
        Try again
      </button>
      {state.canSkip && (
        <button
          onClick={onSkip}
          className={quiet}
          title="Carries over Custard's record of actions only, with no summary of what was said."
        >
          Continue without a summary
        </button>
      )}
      <button onClick={onCancel} className={quiet}>
        Cancel
      </button>
    </div>
  )
}

const list = (title: string, items: string[]): React.JSX.Element | null =>
  items.length ? (
    <div>
      <p className="text-ash-500">{title}</p>
      <ul className="ml-4 list-disc">
        {items.map((x, i) => (
          <li key={i}>{x}</li>
        ))}
      </ul>
    </div>
  ) : null

// At the top of a chat that continues another: where it came from, and
// exactly what came with it.
export function HandoffCard({
  k,
  onOpen
}: {
  k: Continuation
  onOpen: (id: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const n = Object.values(k.counts).reduce((a, b) => a + b, 0)
  const unknown = k.counts.unknown ?? 0
  return (
    <div
      aria-label="Continued chat"
      className="rounded-2xl border border-forge-700 bg-forge-850 px-4 py-3 text-xs text-ash-400"
    >
      <p className="text-sm text-ash-200">
        Continued from{' '}
        <button onClick={() => onOpen(k.from.id)} className="text-molten-200 hover:underline">
          {k.from.title}
        </button>
      </p>
      <p className="mt-1">
        Carried over: Custard&apos;s record of {n} {n === 1 ? 'action' : 'actions'}
        {unknown ? ` (${unknown} with an unknown outcome, which still ask before repeating)` : ''}
        {k.summary
          ? ', and a model-written summary of the goal, decisions and open questions.'
          : '. No summary was written.'}{' '}
        Left out: the earlier messages, tool results, note and page contents, and reasoning. The
        original chat is unchanged.
      </p>
      <button onClick={() => setOpen(!open)} className="mt-2 text-ash-500 hover:text-ash-300">
        {open ? '▾' : '▸'} What the new chat was given
      </button>
      {open && (
        <div className="mt-2 flex flex-col gap-2 text-ash-300">
          {k.summary && (
            <>
              <p className="text-ash-500">Summary (written by a model; may be incomplete)</p>
              {k.summary.goal && <p>Goal: {k.summary.goal}</p>}
              {list('Constraints', k.summary.constraints)}
              {list('Decisions', k.summary.decisions)}
              {list('Still open', k.summary.open)}
              {k.summary.state && <p>Where it stands: {k.summary.state}</p>}
            </>
          )}
          <p className="text-ash-500">Custard&apos;s record of actions</p>
          <pre className="max-h-48 overflow-auto rounded-lg bg-forge-950 p-2 text-[11px] whitespace-pre-wrap">
            {k.ledger}
          </pre>
        </div>
      )}
    </div>
  )
}

// At the end of a chat that was continued elsewhere.
export function ContinuedIn({
  links,
  onOpen
}: {
  links: ChatLink[]
  onOpen: (id: string) => void
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-ash-400">
      <span>Continued in</span>
      {links.map((l) => (
        <button key={l.id} onClick={() => onOpen(l.id)} className={quiet}>
          {l.title}
        </button>
      ))}
    </div>
  )
}
