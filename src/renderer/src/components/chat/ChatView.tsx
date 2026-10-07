import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import {
  modes,
  providerNames,
  providerOf,
  type ActionRecord,
  type ChatLink,
  type WebSource,
  type ChatSettings,
  type Conversation,
  type ConversationSummary,
  type Mode
} from '../../../../shared/chat'
import HistoryDrawer from '../HistoryDrawer'
import ModeBubbles from '../ModeBubbles'
import Orb, { type OrbState } from '../Orb'
import Composer from './Composer'
import MessageView, { NoticeLine, SourcesList, UserBubble } from './MessageView'
import { VaultEditsContext } from '../../vaultEdits'
import Working, { type Approval, type Segment } from './Working'
import WorkspaceBar from './WorkspaceBar'
import {
  CompactionLine,
  ContinuedIn,
  HandoffCard,
  HandoffProgress,
  LengthNotice,
  type HandoffState
} from './LongChat'
import type { Workspace } from '../../../../shared/plugins'
type Live = { requestId: string; userText: string; segments: Segment[]; approvals: Approval[] }

const isToolResults = (m: BetaMessageParam | undefined): boolean =>
  !!m && typeof m.content !== 'string' && m.content.some((b) => b.type === 'tool_result')

const CONTINUE = 'Continue from where you were cut off.'

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

const copy: Record<Mode, { headline: string; placeholder: string; orb: OrbState }> = {
  chat: { headline: "What's on your mind?", placeholder: 'Message {provider}…', orb: 'breathing' },
  code: {
    headline: 'What are we building?',
    placeholder: 'Describe the code you need…',
    orb: 'connecting'
  },
  design: {
    headline: 'What should we shape?',
    placeholder: 'Describe what you want to design…',
    orb: 'shaping'
  },
  skills: {
    headline: 'What should Custard learn?',
    placeholder: 'Teach a skill, or ask to tidy up your vault…',
    orb: 'weaving'
  }
}

type Props = {
  mode: Mode
  onModeChange: (mode: Mode) => void
  hasKey: boolean
  settings: ChatSettings
  onSettings: (s: ChatSettings) => void
  onOpenSettings: () => void
  historyOpen: boolean
  onCloseHistory: () => void
  // A temporary chat is never remembered; see App.
  temporary: boolean
  onTemporary: (temporary: boolean) => void
  newChat: number
  onBusy: (busy: boolean) => void
}

function ChatView(props: Props): React.JSX.Element {
  const { mode, onModeChange, hasKey, settings, onSettings, onOpenSettings } = props
  const { historyOpen, onCloseHistory, temporary, onTemporary, newChat, onBusy } = props
  const [list, setList] = useState<ConversationSummary[]>([])
  const [current, setCurrent] = useState<Conversation | null>(null)
  const [live, setLive] = useState<Live | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  // The last send stopped because the chat is too long (nothing was kept).
  const [overflow, setOverflow] = useState(false)
  // Both belong to the chat they were made for.
  const [handoffFor, setHandoffFor] = useState<{ id: string; state: HandoffState } | null>(null)
  const [linksFor, setLinksFor] = useState<{ id: string; links: ChatLink[] } | null>(null)
  // Code mode: the workspace for the next new conversation.
  const [workspace, setWorkspace] = useState<Workspace | null>(null)
  const bottom = useRef<HTMLDivElement>(null)
  // The request in flight, read by the event listener without re-subscribing.
  const pending = useRef<{ requestId: string; userText: string } | null>(null)

  const refreshList = useCallback(
    () => window.custard.conversations.list(mode).then(setList),
    [mode]
  )

  useEffect(() => {
    refreshList()
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
                    status: e.status,
                    write: e.write
                  })
                }
            )
            break
          case 'approval':
            setLive(
              (l) =>
                l && {
                  ...l,
                  approvals: [
                    ...l.approvals,
                    {
                      id: e.id,
                      plugin: e.plugin,
                      label: e.label,
                      detail: e.detail,
                      warning: e.warning,
                      once: e.once,
                      edit: e.edit
                    }
                  ]
                }
            )
            break
          case 'compacting':
            setLive((l) => l && { ...l, segments: [...l.segments, { kind: 'compacting' }] })
            break
          case 'approval-done':
            setLive((l) => l && { ...l, approvals: l.approvals.filter((a) => a.id !== e.id) })
            break
          case 'done':
          case 'error':
            pending.current = null
            setCurrent(e.conversation)
            setLive(null)
            // When the turn was kept, what happened is in the chat with a
            // notice, and the message isn't put back to be sent twice.
            if (e.type === 'error' && !e.kept) {
              setError(e.message)
              setDraft(p.userText)
            }
            setOverflow(e.type === 'error' && !e.kept && !!e.overflow)
            refreshList()
            break
        }
      }),
    [refreshList]
  )

  // Memory capture finishes after the turn; its status comes separately.
  useEffect(
    () =>
      window.custard.memory.onUpdate((u) =>
        setCurrent((c) => (c && c.id === u.conversationId ? { ...c, memory: u.memory } : c))
      ),
    []
  )

  // Asks first in the main process, listing the notes it will delete.
  const forgetChat = async (id: string): Promise<void> => {
    const memory = await window.custard.memory.forgetChat(id)
    setCurrent((c) => (c && c.id === id ? { ...c, memory: memory ?? undefined } : c))
  }

  useEffect(() => onBusy(!!live), [live, onBusy])

  // The header's Temporary switch: a chat that has started gives way to a
  // new one of the chosen kind.
  const firstNewChat = useRef(newChat)
  useEffect(() => {
    if (newChat === firstNewChat.current) return
    setCurrent(null)
    setError(null)
  }, [newChat])

  // An opened chat decides the switch; a new one keeps what was chosen.
  const currentTemporary = current ? !!current.memory?.temporary : null
  useEffect(() => {
    if (currentTemporary !== null) onTemporary(currentTemporary)
  }, [currentTemporary, onTemporary])

  useEffect(() => bottom.current?.scrollIntoView({ block: 'end' }), [current, live])

  // Chats that carry this one on.
  const currentId = current?.id ?? null
  useEffect(() => {
    if (!currentId) return
    let gone = false
    window.custard.conversations
      .continuations(currentId)
      .then((links) => !gone && setLinksFor({ id: currentId, links }))
    return () => {
      gone = true
    }
  }, [currentId])
  const continuedIn = linksFor?.id === currentId ? linksFor.links : []
  const handoff = handoffFor?.id === currentId ? handoffFor.state : null

  // Continue in a new chat. The original is never changed; the new chat
  // opens once its handoff is ready, and whatever is in the box stays there.
  const continueNew = async (withoutSummary = false): Promise<void> => {
    if (!current || live) return
    const id = current.id
    setHandoffFor({ id, state: { busy: true } })
    const r = await window.custard.chat.continue(id, withoutSummary)
    if (!r.ok)
      return setHandoffFor({
        id,
        state: { busy: false, error: r.error, canSkip: r.canSkipSummary }
      })
    setHandoffFor(null)
    setError(null)
    setOverflow(false)
    setCurrent(r.conversation)
    refreshList()
  }

  const send = (text: string): void => {
    const requestId = crypto.randomUUID()
    setError(null)
    setOverflow(false)
    setDraft('')
    pending.current = { requestId, userText: text }
    setLive({ requestId, userText: text, segments: [], approvals: [] })
    window.custard.chat.send({
      requestId,
      conversationId: current?.id ?? null,
      mode,
      text,
      settings,
      ...(mode === 'code' && !current && workspace ? { workspace } : {}),
      ...(!current && temporary ? { temporary: true } : {})
    })
  }

  const open = async (id: string): Promise<void> => {
    if (live) return
    setError(null)
    setOverflow(false)
    setCurrent(await window.custard.conversations.get(id))
    onCloseHistory()
  }

  const startNew = (): void => {
    if (live) return
    onTemporary(false)
    setCurrent(null)
    setError(null)
    setOverflow(false)
    onCloseHistory()
  }

  const remove = async (id: string): Promise<void> => {
    await window.custard.conversations.delete(id)
    if (current?.id === id) setCurrent(null)
    refreshList()
  }

  // Each tool call's outcome. Chats saved before outcomes were recorded only
  // know which calls failed.
  const actions = useMemo(() => {
    const all: Record<string, ActionRecord> = { ...(current?.actions ?? {}) }
    for (const m of current?.messages ?? [])
      if (typeof m.content !== 'string')
        for (const b of m.content)
          if (b.type === 'tool_result' && b.is_error && !all[b.tool_use_id])
            all[b.tool_use_id] = { name: '', label: '', write: false, status: 'failed', key: '' }
    return all
  }, [current])

  // Where each turn ends (the message before the next thing the user wrote)
  // mapped to its sources and its answer text.
  const turnSources = useMemo(() => {
    const out = new Map<number, { sources: WebSource[]; answer: string }>()
    const msgs = current?.messages ?? []
    const all = current?.sources ?? []
    if (!all.length) return out
    let start = -1
    msgs.forEach((m, i) => {
      if (m.role === 'user' && !isToolResults(m)) start = i
      const next = msgs[i + 1]
      const ends = !next || (next.role === 'user' && !isToolResults(next))
      if (!ends || start < 0) return
      const sources = all.filter((s) => s.turn === start)
      if (!sources.length) return
      const answer = msgs
        .slice(start, i + 1)
        .filter((x) => x.role === 'assistant')
        .flatMap((x) =>
          typeof x.content === 'string'
            ? [x.content]
            : x.content.flatMap((b) => (b.type === 'text' ? [b.text] : []))
        )
        .join('\n')
      out.set(i, { sources, answer })
    })
    return out
  }, [current])

  const notices = current?.notices ?? []
  const lastNotice = notices[notices.length - 1]
  const atEnd = lastNotice?.after === current?.messages.length
  const canContinue = !live && lastNotice?.kind === 'cut-off' && atEnd
  // Offered when the chat stopped for length, or when it is getting long;
  // not once it has been continued.
  const tooLong = overflow || (lastNotice?.kind === 'too-long' && atEnd)
  const showLength =
    !!current && !live && !continuedIn.length && (tooLong || !!current.context?.warn)

  const empty = !current && !live
  const editsValue = {
    edits: current?.vaultEdits ?? {},
    undo: async (callId: string): Promise<{ ok: boolean; message: string }> => {
      if (!current) return { ok: false, message: 'No chat is open.' }
      const r = await window.custard.chat.undoEdit(current.id, callId)
      if (r.ok) setCurrent((c) => (c && c.id === r.conversation.id ? r.conversation : c))
      return { ok: r.ok, message: r.message }
    }
  }
  const modeLabel = modes.find((m) => m.id === mode)?.label ?? 'Chat'
  const providerName = providerNames[providerOf(settings.model)]

  return (
    <VaultEditsContext.Provider value={editsValue}>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div className="flex-1 overflow-y-auto">
          {empty ? (
            <div className="flex h-full flex-col items-center justify-center gap-6 px-6 pb-10">
              <Orb size={128} state={copy[mode].orb} />
              <div className="text-center">
                <h1 className="text-3xl font-semibold tracking-tight text-molten-200">
                  {copy[mode].headline}
                </h1>
                <p className="mt-2 text-sm text-ash-400">
                  {hasKey ? (
                    modes.find((m) => m.id === mode)?.hint
                  ) : (
                    <button onClick={onOpenSettings} className="text-molten-300 hover:underline">
                      Add your {providerName} API key to get started
                    </button>
                  )}
                </p>
              </div>
            </div>
          ) : (
            <div className="mx-auto flex max-w-3xl flex-col gap-6 px-6 pt-8 pb-6">
              {current?.continuedFrom && <HandoffCard k={current.continuedFrom} onOpen={open} />}
              {current?.messages.map((m, i) => (
                <Fragment key={i}>
                  {(current.compactions ?? [])
                    .filter((k) => k.after === i)
                    .slice(-1)
                    .map((k) => (
                      <CompactionLine key={`k${i}`} k={k} />
                    ))}
                  {!isToolResults(m) && (
                    // A reply that continues after vault actions sits flush with the part before it.
                    <div className={isToolResults(current.messages[i - 1]) ? '-mt-6' : ''}>
                      <MessageView message={m} actions={actions} />
                    </div>
                  )}
                  {turnSources.has(i) && (
                    <SourcesList
                      sources={turnSources.get(i)!.sources}
                      answer={turnSources.get(i)!.answer}
                    />
                  )}
                  {notices
                    // The length notice below says it, with the way on.
                    .filter(
                      (n) => n.after === i + 1 && !(showLength && n === lastNotice && tooLong)
                    )
                    .map((n, j) => (
                      <NoticeLine
                        key={j}
                        notice={n}
                        onContinue={
                          canContinue && n === lastNotice ? () => send(CONTINUE) : undefined
                        }
                      />
                    ))}
                </Fragment>
              ))}
              {showLength && !handoff && (
                <LengthNotice
                  use={current.context}
                  tooLong={tooLong}
                  busy={!!handoff}
                  onContinue={() => continueNew()}
                />
              )}
              {handoff && (
                <HandoffProgress
                  state={handoff}
                  onRetry={() => continueNew()}
                  onSkip={() => continueNew(true)}
                  onCancel={() => setHandoffFor(null)}
                />
              )}
              {!live && continuedIn.length > 0 && <ContinuedIn links={continuedIn} onOpen={open} />}
              {live && (
                <>
                  <UserBubble text={live.userText} />
                  <Working segments={live.segments} approvals={live.approvals} />
                </>
              )}
              <div ref={bottom} />
            </div>
          )}
        </div>

        <div className="mx-auto w-full max-w-3xl px-6 pb-6">
          {/* The length notice in the chat already says it, with the way on. */}
          {error && !(overflow && showLength) && (
            <div className="mb-2 px-2 text-sm text-ember-600">{error}</div>
          )}
          {mode === 'code' && (
            <WorkspaceBar
              fixed={current ? current.workspace : null}
              value={workspace}
              onChange={setWorkspace}
              disabled={!!live}
            />
          )}
          <ModeBubbles mode={mode} disabled={!!live} onChange={onModeChange} />
          <Composer
            busy={!!live}
            placeholder={copy[mode].placeholder.replace('{provider}', providerName)}
            settings={settings}
            onSettings={onSettings}
            onSend={send}
            onStop={() => live && window.custard.chat.stop(live.requestId)}
            draft={draft}
            setDraft={setDraft}
          />
        </div>

        {historyOpen && (
          <HistoryDrawer
            modeLabel={modeLabel}
            conversations={list}
            currentId={current?.id ?? null}
            onOpen={open}
            onNew={startNew}
            onDelete={remove}
            onForget={forgetChat}
            onClose={onCloseHistory}
          />
        )}
      </div>
    </VaultEditsContext.Provider>
  )
}

export default ChatView
