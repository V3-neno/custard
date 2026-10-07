import { useContext, useState } from 'react'
import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import Markdown from '../Markdown'
import Orb from '../Orb'
import { toolLabel } from '../../../../shared/vault'
import type { ActionRecord, ActionStatus, Notice } from '../../../../shared/chat'
import { ToolLabelsContext } from '../../toolLabels'

// The orb is the "buffer": it glows while Claude works and holds the
// collapsible thinking summary once there is one.
export function Thinking({
  text,
  live
}: {
  text: string
  live?: boolean
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  if (!text && !live) return null
  return (
    <div className="mb-3">
      <button
        onClick={() => text && setOpen(!open)}
        className="flex items-center gap-2.5 text-sm text-ash-400 hover:text-molten-300"
      >
        <Orb size={20} state="working" paused={!live} />
        <span className={live ? 'animate-pulse' : ''}>
          {live ? 'Thinking' : open ? 'Hide thinking' : 'Show thinking'}
        </span>
      </button>
      {open && text && (
        <div className="mt-2 ml-2 border-l border-molten-500/40 pl-4 text-sm whitespace-pre-wrap text-ash-400">
          {text}
        </div>
      )}
    </div>
  )
}

export function FallbackNote({ to }: { to: string }): React.JSX.Element {
  return <div className="mb-2 text-xs text-ash-500">Answer continued by {to}.</div>
}

type LineStatus = 'running' | 'done' | 'error' | 'not-run' | 'unknown'

const lineStatus = (s: ActionStatus | undefined): LineStatus =>
  s === 'completed' || s === undefined
    ? 'done'
    : s === 'failed'
      ? 'error'
      : s === 'pending' || s === 'running'
        ? 'running'
        : s

const statusNote: Partial<Record<LineStatus, string>> = {
  error: 'failed',
  'not-run': 'not run',
  unknown: 'outcome unknown'
}

export function ToolLine({
  label,
  status = 'done',
  write = false
}: {
  label: string
  status?: LineStatus
  write?: boolean
}): React.JSX.Element {
  const bad = status === 'error' || status === 'unknown'
  return (
    <div
      className={`mb-2 flex items-center gap-2.5 text-xs ${bad ? 'text-ember-600' : status === 'not-run' ? 'text-ash-500' : 'text-ash-400'}`}
    >
      {status === 'running' ? (
        <Orb size={16} state={write ? 'composing' : 'searching'} />
      ) : (
        <span
          className={`h-2 w-2 rounded-full ${bad ? 'bg-ember-600' : status === 'not-run' ? 'border border-ash-500' : 'bg-molten-400 shadow-[0_0_8px_rgb(var(--glow)/0.6)]'}`}
        />
      )}
      {label}
      {statusNote[status] && <span className="text-ash-500">· {statusNote[status]}</span>}
    </div>
  )
}

// A turn that ended early: stopped, failed, cut off or interrupted.
export function NoticeLine({
  notice,
  onContinue
}: {
  notice: Notice
  onContinue?: () => void
}): React.JSX.Element {
  return (
    <div
      role="status"
      className="flex items-center gap-3 rounded-xl border border-forge-700 px-3 py-2 text-xs text-ash-400"
    >
      <span className={notice.kind === 'error' ? 'text-ember-600' : 'text-molten-300'}>●</span>
      <span className="flex-1">{notice.text}</span>
      {onContinue && (
        <button onClick={onContinue} className="text-molten-200 hover:underline">
          Continue
        </button>
      )}
    </div>
  )
}

export function UserBubble({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="flex justify-end">
      <div className="max-w-[80%] rounded-3xl rounded-br-lg border border-forge-700 bg-forge-800 px-4 py-2.5 text-[15px] whitespace-pre-wrap text-ash-100">
        {text}
      </div>
    </div>
  )
}

type Props = { message: BetaMessageParam; actions?: Record<string, ActionRecord> }

function MessageView({ message, actions }: Props): React.JSX.Element | null {
  const labels = useContext(ToolLabelsContext)
  const blocks =
    typeof message.content === 'string'
      ? [{ type: 'text' as const, text: message.content }]
      : message.content

  if (message.role === 'user') {
    // Tool results are sent as user messages but aren't something the user wrote.
    if (blocks.some((b) => b.type === 'tool_result')) return null
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n')
    return <UserBubble text={text} />
  }

  return (
    <div>
      {blocks.map((b, i) => {
        if (b.type === 'thinking') return <Thinking key={i} text={b.thinking} />
        if (b.type === 'fallback') return <FallbackNote key={i} to={b.to.model} />
        if (b.type === 'tool_use')
          return (
            <ToolLine
              key={i}
              label={toolLabel(b.name, b.input, labels)}
              status={lineStatus(actions?.[b.id]?.status)}
            />
          )
        if (b.type === 'text') return <Markdown key={i} text={b.text} />
        return null
      })}
    </div>
  )
}

export default MessageView
