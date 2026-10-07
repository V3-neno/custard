import { useCallback, useEffect, useRef, useState } from 'react'
import {
  defaultChatSettings,
  type ChatSettings,
  type Conversation,
  type ConversationSummary
} from '../../../../shared/chat'
import Composer from './Composer'
import MessageView, { FallbackNote, Thinking, UserBubble } from './MessageView'
import Markdown from '../Markdown'

type Live = {
  requestId: string
  userText: string
  thinking: string
  text: string
  fallbackTo?: string
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
            setLive((l) => l && { ...l, thinking: l.thinking + e.text })
            break
          case 'text':
            setLive((l) => l && { ...l, text: l.text + e.text })
            break
          case 'fallback':
            setLive((l) => l && { ...l, fallbackTo: e.to })
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
    setLive({ requestId, userText: text, thinking: '', text: '' })
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
              {current?.messages.map((m, i) => (
                <MessageView key={i} message={m} />
              ))}
              {live && (
                <>
                  <UserBubble text={live.userText} />
                  <div>
                    <Thinking text={live.thinking} live={!live.text} />
                    {live.fallbackTo && <FallbackNote to={live.fallbackTo} />}
                    {live.text && <Markdown text={live.text} />}
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
