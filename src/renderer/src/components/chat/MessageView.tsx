import { useContext, useState } from 'react'
import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import Markdown from '../Markdown'
import Orb from '../Orb'
import { toolLabel } from '../../../../shared/vault'
import type { ActionRecord, ActionStatus, Notice, WebSource } from '../../../../shared/chat'
import { splitSources } from '../../../../shared/web'
import { ToolLabelsContext } from '../../toolLabels'
import { VaultEditsContext } from '../../vaultEdits'

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

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

function SourceLink({ s }: { s: WebSource }): React.JSX.Element {
  return (
    <li className="truncate">
      <a
        href={s.url}
        target="_blank"
        rel="noreferrer"
        title={s.citedText ? `"${s.citedText}"` : s.url}
        className="text-ash-300 hover:text-molten-200 hover:underline"
      >
        {s.title || hostOf(s.url)}
      </a>
      <span className="text-ash-500"> · {hostOf(s.url)}</span>
    </li>
  )
}

// The web pages a turn used: the ones the answer cites, and the ones only
// searched or read. Being retrieved doesn't make a page a source for a claim.
export function SourcesList({
  sources,
  answer
}: {
  sources: WebSource[]
  answer: string
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const { cited, consulted } = splitSources(sources, answer)
  if (!cited.length && !consulted.length) return null
  return (
    <div className="-mt-3 text-xs" aria-label="Sources">
      {cited.length > 0 && (
        <>
          <p className="mb-1 text-ash-400">Cited</p>
          <ol className="mb-2 flex flex-col gap-0.5">
            {cited.map((s) => (
              <SourceLink key={s.url} s={s} />
            ))}
          </ol>
        </>
      )}
      {consulted.length > 0 && (
        <>
          <button onClick={() => setOpen(!open)} className="text-ash-500 hover:text-ash-300">
            {open ? '▾' : '▸'} Also consulted, not cited ({consulted.length})
          </button>
          {open && (
            <ul className="mt-1 flex flex-col gap-0.5">
              {consulted.map((s) => (
                <SourceLink key={s.url} s={s} />
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  )
}

export function UserBubble({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="flex justify-end">
      <div className="max-w-[80%] rounded-3xl rounded-br-lg border border-forge-700 bg-forge-800 px-4 py-2.5 text-[15px] whitespace-pre-wrap text-ash-100 [overflow-wrap:anywhere]">
        {text}
      </div>
    </div>
  )
}

const pill =
  'rounded-full border border-molten-500/50 px-2.5 py-0.5 text-[11px] text-molten-200 transition-colors hover:border-molten-400 hover:shadow-[0_0_10px_rgb(var(--glow)/0.25)] disabled:opacity-40'

// Under a note edit: Undo, or what became of it.
function EditUndo({ callId }: { callId: string }): React.JSX.Element | null {
  const { edits, undo } = useContext(VaultEditsContext)
  const [busy, setBusy] = useState(false)
  const [said, setSaid] = useState<{ ok: boolean; message: string } | null>(null)
  const e = edits[callId]
  if (!e) return null
  if (e.undone)
    return (
      <p className="-mt-1 mb-2 ml-[18px] text-[11px] text-ash-500">
        Undone{said?.ok ? `: ${e.path} is back as it was.` : '.'}
      </p>
    )
  return (
    <div className="-mt-1 mb-2 ml-[18px] flex flex-wrap items-center gap-2 text-[11px] text-ash-500">
      <button
        disabled={busy}
        className={pill}
        onClick={async () => {
          setBusy(true)
          setSaid(await undo(callId))
          setBusy(false)
        }}
        title={`Puts back the version from before this edit, only if ${e.path} hasn't changed since.`}
      >
        Undo
      </button>
      {said && !said.ok && (
        <span role="alert" className="text-ember-600 [overflow-wrap:anywhere]">
          {said.message}
        </span>
      )}
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
            <div key={i}>
              <ToolLine
                label={toolLabel(b.name, b.input, labels)}
                status={lineStatus(actions?.[b.id]?.status)}
              />
              {b.name === 'vault_edit' && <EditUndo callId={b.id} />}
            </div>
          )
        if (b.type === 'text') return <Markdown key={i} text={b.text} />
        return null
      })}
    </div>
  )
}

export default MessageView
