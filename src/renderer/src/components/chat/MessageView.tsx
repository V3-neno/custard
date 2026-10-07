import { useState } from 'react'
import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import Markdown from '../Markdown'

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
    <div className="mb-2 text-sm">
      <button onClick={() => setOpen(!open)} className="text-ink-300 hover:text-custard-300">
        {live && !text ? 'Thinking…' : `${open ? '▾' : '▸'} Thought process`}
      </button>
      {open && text && (
        <div className="mt-2 border-l-2 border-ink-700 pl-3 whitespace-pre-wrap text-ink-300">
          {text}
        </div>
      )}
    </div>
  )
}

export function FallbackNote({ to }: { to: string }): React.JSX.Element {
  return <div className="mb-2 text-xs text-ink-500">Answer continued by {to}.</div>
}

export function UserBubble({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="flex justify-end">
      <div className="max-w-[80%] rounded-2xl bg-ink-700 px-4 py-2 whitespace-pre-wrap">{text}</div>
    </div>
  )
}

function MessageView({ message }: { message: BetaMessageParam }): React.JSX.Element {
  const blocks =
    typeof message.content === 'string'
      ? [{ type: 'text' as const, text: message.content }]
      : message.content

  if (message.role === 'user') {
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n')
    return <UserBubble text={text} />
  }

  return (
    <div>
      {blocks.map((b, i) => {
        if (b.type === 'thinking') return <Thinking key={i} text={b.thinking} />
        if (b.type === 'fallback') return <FallbackNote key={i} to={b.to.model} />
        if (b.type === 'text') return <Markdown key={i} text={b.text} />
        return null
      })}
    </div>
  )
}

export default MessageView
