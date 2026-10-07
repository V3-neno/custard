import type { ChatMemory } from '../../../../shared/chat'

type Props = {
  memory?: ChatMemory
  disabled: boolean
  onToggle: (off: boolean) => void
}

// What automatic memory did with this chat, and the per-chat switch.
function status(m?: ChatMemory): string | null {
  const job = m?.job
  if (m?.off)
    return job?.notes?.length
      ? `Not remembering this chat. What was already saved stays in ${job.notes.join(' and ')} until you edit it.`
      : 'Not remembering this chat.'
  if (!job) return null
  switch (job.status) {
    case 'pending':
      return job.reason ? `Waiting to save to memory. ${job.reason}` : 'Saving to memory…'
    case 'saved':
      return `Saved to memory in ${job.notes?.join(' and ') || 'your vault'}.`
    case 'skipped':
      return `Not saved to memory: ${job.reason ?? 'nothing needed remembering.'}`
    case 'failed':
      return `Couldn't save to memory. ${job.reason ?? ''}`
    case 'off':
      return `Not saved to memory: ${job.reason ?? 'memory is off.'}`
  }
}

function MemoryBar({ memory, disabled, onToggle }: Props): React.JSX.Element {
  const text = status(memory)
  return (
    <div className="mb-2 flex items-center justify-between gap-3 px-2 text-xs text-ash-400">
      <span
        aria-label="Memory status"
        aria-live="polite"
        className="min-w-0 truncate"
        title={text ?? ''}
      >
        {text}
      </span>
      <label className="flex shrink-0 items-center gap-1.5">
        <input
          type="checkbox"
          checked={!!memory?.off}
          disabled={disabled}
          onChange={(e) => onToggle(e.target.checked)}
        />
        Don&apos;t remember this chat
      </label>
    </div>
  )
}

export default MemoryBar
