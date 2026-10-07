import type { ChatMemory } from '../../../../shared/chat'

type Props = {
  memory?: ChatMemory
  disabled: boolean
  onToggle: (off: boolean) => void
}

// What became of the latest capture. The switch says whether this chat is
// remembered from now on; this line only reports the last attempt.
// `detail` is shown after the text (cut to fit), `title` on hover.
type Last = { text: string; detail?: string; title?: string }

function lastCapture(m?: ChatMemory): Last | null {
  const job = m?.job
  if (m?.off)
    return job?.notes?.length && job.status === 'saved'
      ? {
          text: 'Earlier saves stay in your vault',
          title: `Saved earlier in ${job.notes.join(', ')}. Edit or delete them in Obsidian.`
        }
      : null
  if (!job) return null
  switch (job.status) {
    case 'pending':
      return job.reason
        ? { text: 'Waiting to save', detail: job.reason, title: job.reason }
        : { text: 'Saving to memory…' }
    case 'saved':
      return { text: 'Saved to memory', title: job.notes?.join('\n') }
    case 'skipped':
      return { text: 'Last part not saved', detail: job.reason, title: job.reason }
    case 'failed':
      return { text: "Couldn't save", detail: job.reason, title: job.reason }
    case 'off':
      return { text: 'Not saved', detail: job.reason, title: job.reason }
  }
}

function MemoryBar({ memory, disabled, onToggle }: Props): React.JSX.Element {
  const on = !memory?.off
  const last = lastCapture(memory)
  return (
    <div className="mb-2 flex items-center justify-center gap-2 text-xs">
      <button
        role="switch"
        aria-checked={on}
        aria-label="Remember this chat"
        disabled={disabled}
        onClick={() => onToggle(on)}
        title={
          on
            ? 'Custard may save what matters from this chat to your vault. Click to stop.'
            : 'Nothing from this chat is saved. Click to remember it from now on.'
        }
        className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 transition-colors disabled:opacity-40 ${
          on
            ? 'border-forge-700 bg-forge-850/80 text-ash-400 hover:border-molten-500/50 hover:text-molten-200'
            : 'border-ember-700/70 bg-forge-850/80 text-ash-500 hover:text-ash-300'
        }`}
      >
        <span
          className={`h-1.5 w-1.5 rounded-full ${on ? 'bg-molten-400 shadow-[0_0_6px_rgb(var(--glow)/0.6)]' : 'bg-ash-500/60'}`}
        />
        {on ? 'Remembering' : 'Not remembering'}
      </button>
      {last && (
        <span
          aria-label="Memory status"
          aria-live="polite"
          title={last.title}
          className="max-w-[28rem] truncate text-ash-500"
        >
          {last.text}
          {last.detail && <span className="text-ash-500/70"> · {last.detail}</span>}
        </span>
      )}
    </div>
  )
}

export default MemoryBar
