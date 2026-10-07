import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import {
  defaultChatSettings,
  type ChatSettings,
  type Conversation,
  type ConversationSummary
} from '../../../../shared/chat'
import Composer from './Composer'
import MessageView, { FallbackNote, Thinking, ToolLine, UserBubble } from './MessageView'
import Markdown from '../Markdown'

type Segment =
  | { kind: 'thinking' | 'text'; text: string }
  | { kind: 'tool'; id: string; label: string; status: 'running' | 'done' | 'error' }
  | { kind: 'fallback'; to: string }
type Live = { requestId: string; userText: string; segments: Segment[] }

const isToolResults = (m: BetaMessageParam | undefined): boolean =>
  !!m && typeof m.content !== 'string' && m.content.every((b) => b.type === 'tool_result')

// Streamed text joins the previous segment of the same kind, or starts a new one.
function appendText(segments: Segment[], kind: 'thinking' | 'text', text: string): Segment[] {
  const last = segments[segments.length - 1]
  if (last && last.kind === kind)
    return [...segments.slice(0, -1), { kind, text: last.text + text }]
  return [...segments, { kind, text }]
}

function upsertTool(segments: Segment[], tool: Extract<Segment, { kind: 'tool' }>): Segment[] {
  const i = segments.findIndex((s) => s.kind === 'tool' && s.id === tool.id)
  return i < 0 ? [...segments, tool] : segments.map((s, j) => (j === i ? tool : s))
}

function ChatView({
  hasKey,
  onOpenSettings
}: {
  hasKey: boolean
  onOpenSettings: () => void
}): React.JSX.Element {
  const [list, setList] = useState<ConversationSummary[]>([])
  const [current, setCurrent] = useState<Conversation | null>(null)
  const [live, setLive] = useState<Live | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [settings, setSettings] = useState<ChatSettings>(defaultChatSettings)
  const bottom = useRef<HTMLDivElement>(null)
  // The request in flight, read by the event listener without re-subscribing.
  const pending = useRef<{ requestId: string; userText: string } | null>(null)

  const refreshList = useCallback(() => window.custard.conversations.list().then(setList), [])

  useEffect(() => {
    refreshList()
    window.custard.settings.get().then(setSettings)
  }, [refreshList])

  useEffect(
    () =>
      window.custard.chat.onEvent((e) => {
        const p = pending.current
        if (!p || e.requestId !== p.requestId) return
        switch (e.type) {
          case 'thinking':
            setLive((l) => l && { ...l, segments: appendText(l.segments, 'thinking', e.text) })
            break
          case 'text':
            setLive((l) => l && { ...l, segments: appendText(l.segments, 'text', e.text) })
            break
          case 'fallback':
            setLive((l) => l && { ...l, segments: [...l.segments, { kind: 'fallback', to: e.to }] })
            break
          case 'tool':
            setLive(
              (l) =>
                l && {
                  ...l,
                  segments: upsertTool(l.segments, {
                    kind: 'tool',
                    id: e.id,
                    label: e.label,
                    status: e.status
                  })
                }
            )
            break
          case 'done':
          case 'error':
            pending.current = null
            setCurrent(e.conversation)
            setLive(null)
            if (e.type === 'error') {
              setError(e.message)
              setDraft(p.userText)
            }
            refreshList()
            break
        }
      }),
    [refreshList]
  )

  useEffect(() => bottom.current?.scrollIntoView({ block: 'end' }), [current, live])

  const send = (text: string): void => {
    const requestId = crypto.randomUUID()
    setError(null)
    setDraft('')
    pending.current = { requestId, userText: text }
    setLive({ requestId, userText: text, segments: [] })
    window.custard.chat.send({ requestId, conversationId: current?.id ?? null, text, settings })
  }

  const open = async (id: string): Promise<void> => {
    if (live) return
    setError(null)
    setCurrent(await window.custard.conversations.get(id))
  }

  const remove = async (id: string): Promise<void> => {
    await window.custard.conversations.delete(id)
    if (current?.id === id) setCurrent(null)
    refreshList()
  }

  const updateSettings = (s: ChatSettings): void => {
    setSettings(s)
    window.custard.settings.set(s)
  }

  const failedTools = useMemo(() => {
    const ids = new Set<string>()
    for (const m of current?.messages ?? [])
      if (typeof m.content !== 'string')
        for (const b of m.content)
          if (b.type === 'tool_result' && b.is_error) ids.add(b.tool_use_id)
    return ids
  }, [current])

  const empty = !current && !live

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex w-60 shrink-0 flex-col border-r border-ink-700">
        <button
          onClick={() => !live && (setCurrent(null), setError(null))}
          className="m-3 rounded-lg border border-ink-700 px-3 py-2 text-left text-sm hover:border-custard-400/60"
        >
          + New chat
        </button>
        <div className="flex-1 overflow-y-auto px-2 pb-3">
          {list.map((c) => (
            <div
              key={c.id}
              className={`group flex items-center rounded-lg text-sm ${
                current?.id === c.id
                  ? 'bg-ink-700 text-custard-50'
                  : 'text-ink-300 hover:bg-ink-800'
              }`}
            >
              <button onClick={() => open(c.id)} className="flex-1 truncate px-3 py-2 text-left">
                {c.title}
              </button>
              <button
                onClick={() => remove(c.id)}
                title="Delete chat"
                className="hidden px-2 text-ink-500 group-hover:block hover:text-custard-300"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex-1 overflow-y-auto">
          {empty ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-ink-500">
              <span className="text-4xl">🍮</span>
              {hasKey ? (
                <span>What are we talking about today?</span>
              ) : (
                <button onClick={onOpenSettings} className="text-custard-300 hover:underline">
                  Add your Claude API key to start chatting
                </button>
              )}
            </div>
          ) : (
            <div className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-6">
              {current?.messages.map((m, i) =>
                isToolResults(m) ? null : (
                  // A reply that continues after vault actions sits flush with the part before it.
                  <div key={i} className={isToolResults(current.messages[i - 1]) ? '-mt-6' : ''}>
                    <MessageView message={m} failedTools={failedTools} />
                  </div>
                )
              )}
              {live && (
                <>
                  <UserBubble text={live.userText} />
                  <div>
                    {live.segments.map((seg, i) => {
                      if (seg.kind === 'thinking') return <Thinking key={i} text={seg.text} />
                      if (seg.kind === 'fallback') return <FallbackNote key={i} to={seg.to} />
                      if (seg.kind === 'tool')
                        return <ToolLine key={i} label={seg.label} status={seg.status} />
                      return <Markdown key={i} text={seg.text} />
                    })}
                    {live.segments[live.segments.length - 1]?.kind !== 'text' && (
                      <Thinking text="" live />
                    )}
                  </div>
                </>
              )}
              <div ref={bottom} />
            </div>
          )}
        </div>
        {error && (
          <div className="mx-auto mb-2 w-full max-w-3xl px-6 text-sm text-red-300">{error}</div>
        )}
        <Composer
          busy={!!live}
          settings={settings}
          onSettings={updateSettings}
          onSend={send}
          onStop={() => live && window.custard.chat.stop(live.requestId)}
          draft={draft}
          setDraft={setDraft}
        />
      </div>
    </div>
  )
}

export default ChatView
