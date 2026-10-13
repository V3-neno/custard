import { chatHasOutsideText } from '../../../../shared/outsideText'
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
import { SentReferences } from './References'
import { SentFiles } from './Attachments'
import {
  acceptsAttachments,
  ATTACHMENT_LIMITS,
  type DraftAttachment
} from '../../../../shared/attachments'
import Working, { type Approval, type Segment } from './Working'
import PathBar, { type Crumb } from './PathBar'
import ProposalCard from './ProposalCard'
import SkillsHub from '../hubs/SkillsHub'
import PluginsHub from '../hubs/PluginsHub'
import PluginWorkspace from '../hubs/PluginWorkspace'
import WidgetSlot from './WidgetSlot'
import UsageMeter from './UsageMeter'
import { formatCost } from '../../../../shared/pricing'
import type { UsageMonth } from '../../../../shared/chat'
import { cleanError } from '../settings/ui'
import {
  CompactionLine,
  ContinuedIn,
  HandoffCard,
  HandoffProgress,
  LengthNotice,
  type HandoffState
} from './LongChat'
import type { Workspace } from '../../../../shared/plugins'
import DesignWorkspace from '../design/Workspace'
import { useOutputs } from '../design/useOutputs'
type Live = {
  requestId: string
  userText: string
  files?: number
  segments: Segment[]
  approvals: Approval[]
}

const folderName = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p

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
    headline: 'Which plugin are we building?',
    placeholder: 'Brainstorm, or ask to open or create a plugin…',
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
  // Clicking the shown mode again: back to its start page (Plugins: the hub).
  home: number
  onBusy: (busy: boolean) => void
  onOutsideText: (outside: boolean) => void
}

const unsent = new Map<Mode, { text: string; draftId: string; files: DraftAttachment[] }>()
// The chat open in each mode, so leaving a mode (say, to manage a plugin in
// Plugins mode) and coming back returns to it.
const openChats = new Map<Mode, string>()
// Plugins mode: the workspace entered (null: the hub), kept across modes.
let openWorkspace: Workspace | null = null
// History's mode filter (null: every mode), kept across modes.
let historyFilter: Mode | null = null

const NARROW = 900
const PANE_MIN = 320
const CHAT_MIN = 360
const PANE_KEY = 'custard.design.paneWidth'

// Narrow windows: the conversation and Design's outputs take turns.
function SideSwitch({
  side,
  onSide,
  count
}: {
  side: 'chat' | 'outputs'
  onSide: (s: 'chat' | 'outputs') => void
  count: number
}): React.JSX.Element {
  const cls = (on: boolean): string =>
    `rounded-full px-3 py-1 text-xs font-medium transition-colors ${
      on
        ? 'molten-fill text-forge-950'
        : 'border border-forge-700 text-ash-300 hover:text-molten-200'
    }`
  return (
    <div className="flex shrink-0 justify-center gap-1 pt-2" role="group" aria-label="Show">
      <button className={cls(side === 'chat')} onClick={() => onSide('chat')}>
        Conversation
      </button>
      <button className={cls(side === 'outputs')} onClick={() => onSide('outputs')}>
        Outputs ({count})
      </button>
    </div>
  )
}

function ChatView(props: Props): React.JSX.Element {
  const { mode, onModeChange, hasKey, settings, onSettings, onOpenSettings } = props
  const { historyOpen, onCloseHistory, temporary, onTemporary, newChat, home, onBusy } = props
  const { onOutsideText } = props
  const [list, setList] = useState<ConversationSummary[]>([])
  const [filter, setFilter] = useState<Mode | null>(historyFilter)
  const [current, setCurrent] = useState<Conversation | null>(null)
  const restoring = useRef(openChats.has(mode))
  useEffect(() => {
    const id = openChats.get(mode)
    if (!id) return
    window.custard.conversations
      .get(id)
      .then((c) => {
        restoring.current = false
        if (c) setCurrent(c)
        else openChats.delete(mode)
      })
      .catch(() => {
        restoring.current = false
        openChats.delete(mode)
      })
  }, [mode])
  useEffect(() => {
    if (restoring.current) return
    if (current) openChats.set(mode, current.id)
    else openChats.delete(mode)
  }, [mode, current])
  const [live, setLive] = useState<Live | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The unsent message (and its files) of each mode, kept when switching
  // mode, which mounts a new view.
  const saved = unsent.get(mode)
  const [draft, setDraft] = useState(saved?.text ?? '')
  // Chat mode: files for the next message. They live in a draft folder in
  // app data until sent (see main/attachments).
  const [draftId, setDraftId] = useState<string>(() => saved?.draftId ?? crypto.randomUUID())
  const [files, setFiles] = useState<DraftAttachment[]>(saved?.files ?? [])
  useEffect(() => {
    unsent.set(mode, { text: draft, draftId, files })
  }, [mode, draft, draftId, files])
  const [fileErrors, setFileErrors] = useState<{ name: string; error: string }[]>([])
  const [adding, setAdding] = useState(false)
  // The last send stopped because the chat is too long (nothing was kept).
  const [overflow, setOverflow] = useState(false)
  // Both belong to the chat they were made for.
  const [handoffFor, setHandoffFor] = useState<{ id: string; state: HandoffState } | null>(null)
  const [linksFor, setLinksFor] = useState<{ id: string; links: ChatLink[] } | null>(null)
  // Plugins mode: the workspace entered, where new chats start (null: the
  // hub). An open chat's own workspace decides it, so going back from a chat
  // lands in its workspace.
  const [workspace, setWorkspace] = useState<Workspace | null>(() =>
    mode === 'code' ? openWorkspace : null
  )
  useEffect(() => {
    if (mode === 'code') openWorkspace = workspace
  }, [mode, workspace])
  const [seenChat, setSeenChat] = useState<string | null>(null)
  if (mode === 'code' && current && current.id !== seenChat) {
    setSeenChat(current.id)
    const w = current.workspace
    setWorkspace(w?.kind === 'internal' ? { kind: 'internal', pluginId: w.pluginId } : null)
  }
  // Plugin names, for the path bar and History.
  const [pluginNames, setPluginNames] = useState<Record<string, string>>({})
  useEffect(() => {
    if (mode !== 'code' && !historyOpen) return
    window.custard.plugins
      .list()
      .then((l) => setPluginNames(Object.fromEntries(l.map((p) => [p.id, p.name]))))
      .catch(() => {})
  }, [mode, historyOpen, workspace])
  const bottom = useRef<HTMLDivElement>(null)
  // The request in flight, read by the event listener without re-subscribing.
  const pending = useRef<{
    requestId: string
    userText: string
    files: DraftAttachment[]
    draft: string
    refs: ChatLink[]
  } | null>(null)
  // Earlier chats picked for the next message.
  const [refs, setRefs] = useState<ChatLink[]>([])

  const refreshList = useCallback(
    () => window.custard.conversations.list(filter).then(setList),
    [filter]
  )

  // Also on opening History: chat notes finish after a turn, with the
  // summary each row shows.
  useEffect(() => {
    refreshList()
  }, [refreshList, historyOpen])

  // This month's estimated spend, for the budget line. Read again after
  // each turn.
  const [month, setMonth] = useState<UsageMonth | null>(null)
  const refreshMonth = useCallback(
    () =>
      void window.custard.usage
        .month()
        .then(setMonth)
        .catch(() => {}),
    []
  )
  useEffect(() => refreshMonth(), [refreshMonth])

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
                      individual: e.individual
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
            refreshMonth()
            // When the turn was kept, what happened is in the chat with a
            // notice, and the message isn't put back to be sent twice.
            if (e.type === 'error' && !e.kept) {
              setError(e.message)
              setDraft(p.userText)
              setRefs(p.refs)
              // The files went back to their draft; show them again.
              if (p.files.length) {
                setDraftId(p.draft)
                void window.custard.attachments.list(p.draft).then(setFiles)
              }
            }
            setOverflow(e.type === 'error' && !e.kept && !!e.overflow)
            refreshList()
            break
        }
      }),
    [refreshList, refreshMonth]
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
  const outsideText = chatHasOutsideText(current)
  useEffect(() => onOutsideText(outsideText), [outsideText, onOutsideText])

  // The header's Temporary switch: a chat that has started gives way to a
  // new one of the chosen kind.
  const firstNewChat = useRef(newChat)
  useEffect(() => {
    if (newChat === firstNewChat.current) return
    setCurrent(null)
    setError(null)
  }, [newChat])
  const firstHome = useRef(home)
  useEffect(() => {
    if (home === firstHome.current) return
    setWorkspace(null)
  }, [home])

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

  // Files picked, pasted or dropped: checked and copied by the main process.
  const addFiles = async (picked: File[]): Promise<void> => {
    setAdding(true)
    const errors: { name: string; error: string }[] = []
    const max = Math.max(ATTACHMENT_LIMITS.imageBytes, ATTACHMENT_LIMITS.pdfBytes)
    for (const f of picked.slice(0, ATTACHMENT_LIMITS.perMessage + 1)) {
      // Not read at all when it's plainly too big.
      if (f.size > max) {
        errors.push({
          name: f.name || 'file',
          error: `It is ${(f.size / 1_000_000).toFixed(1)} MB; attached files can be up to ${max / 1_000_000} MB.`
        })
        continue
      }
      const name = f.name || `pasted.${f.type.split('/')[1] ?? 'bin'}`
      const r = await window.custard.attachments.add(
        draftId,
        name,
        new Uint8Array(await f.arrayBuffer())
      )
      if (r.ok) setFiles((x) => [...x, r.attachment])
      else errors.push({ name: r.name, error: r.error })
    }
    setFileErrors(errors)
    setAdding(false)
  }
  const pickFiles = async (): Promise<void> => {
    setAdding(true)
    const results = await window.custard.attachments.pick(draftId)
    setFiles((x) => [...x, ...results.flatMap((r) => (r.ok ? [r.attachment] : []))])
    setFileErrors(results.flatMap((r) => (r.ok ? [] : [{ name: r.name, error: r.error }])))
    setAdding(false)
  }
  const removeFile = (id: string): void => {
    setFiles((x) => x.filter((f) => f.id !== id))
    void window.custard.attachments.remove(draftId, id)
  }

  const send = (text: string): void => {
    const requestId = crypto.randomUUID()
    const sending = acceptsAttachments(mode) ? files : []
    setError(null)
    setOverflow(false)
    setDraft('')
    setFiles([])
    setFileErrors([])
    pending.current = { requestId, userText: text, files: sending, draft: draftId, refs }
    setRefs([])
    // The next message gets a new draft; this one is consumed by the send.
    if (sending.length) setDraftId(crypto.randomUUID())
    setLive({ requestId, userText: text, files: sending.length, segments: [], approvals: [] })
    window.custard.chat.send({
      ...(sending.length ? { attachments: { draft: draftId, ids: sending.map((f) => f.id) } } : {}),
      requestId,
      conversationId: current?.id ?? null,
      mode,
      text,
      settings,
      ...(mode === 'code' && !current && workspace ? { workspace } : {}),
      ...(!current && temporary ? { temporary: true } : {}),
      ...(refs.length ? { references: refs.map((r) => r.id) } : {})
    })
  }

  const open = async (id: string): Promise<void> => {
    if (live) return
    setError(null)
    setOverflow(false)
    setCurrent(await window.custard.conversations.get(id))
    onCloseHistory()
  }

  // A chat from another mode opens in that mode.
  const openIn = (id: string, other: Mode | undefined): void => {
    if (!other || other === mode) {
      void open(id)
      return
    }
    if (live) return
    openChats.set(other, id)
    onCloseHistory()
    onModeChange(other)
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
    try {
      await window.custard.conversations.delete(id)
    } catch (e) {
      setError(cleanError(e))
      return
    }
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

  // Hub chat offers to enter a workspace, shown where their turn ends.
  const turnProposals = useMemo(() => {
    const out = new Map<number, NonNullable<Conversation['proposals']>>()
    const msgs = current?.messages ?? []
    const all = current?.proposals ?? []
    if (!all.length) return out
    let start = -1
    msgs.forEach((m, i) => {
      if (m.role === 'user' && !isToolResults(m)) start = i
      const next = msgs[i + 1]
      const ends = !next || (next.role === 'user' && !isToolResults(next))
      if (!ends || start < 0) return
      const here = all.filter((p) => p.turn === start)
      if (here.length) out.set(i, here)
    })
    return out
  }, [current])
  const [proposalError, setProposalError] = useState<{ id: string; error: string } | null>(null)
  const answerProposal = async (id: string, yes: boolean): Promise<void> => {
    if (!current || live) return
    setProposalError(null)
    const r = await window.custard.chat.proposal(current.id, id, yes)
    if (!r.ok) return setProposalError({ id, error: r.error })
    if (!r.enter) return setCurrent(r.conversation)
    // A new chat in the workspace, with the request to check and send.
    setCurrent(null)
    setError(null)
    setWorkspace({ kind: 'internal', pluginId: r.enter.pluginId })
    fillBox(r.enter.request)
    refreshList()
  }

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

  // Design: the output workspace beside the conversation, once the chat has
  // outputs. Its width is the user's, kept across chats; in a narrow window
  // the conversation and the outputs take turns.
  const { outputs, latest } = useOutputs(mode === 'design' ? (current?.id ?? null) : null)
  const showPane = mode === 'design' && !!current && outputs.length > 0
  const [narrow, setNarrow] = useState(() => window.innerWidth < NARROW)
  const [side, setSide] = useState<'chat' | 'outputs'>('chat')
  const [paneWidth, setPaneWidth] = useState(() => {
    const w = Number(localStorage.getItem(PANE_KEY))
    return Number.isFinite(w) && w > 0 ? w : Math.round(window.innerWidth * 0.5)
  })
  useEffect(() => {
    const onResize = (): void => setNarrow(window.innerWidth < NARROW)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  // A new or changed output is shown, on a narrow window too.
  const [seenOutput, setSeenOutput] = useState(latest?.seq ?? 0)
  if (latest && latest.seq !== seenOutput) {
    setSeenOutput(latest.seq)
    setSide('outputs')
  }
  const clampPane = (w: number): number =>
    Math.round(Math.max(PANE_MIN, Math.min(w, window.innerWidth - CHAT_MIN)))
  const dragPane = (e: React.PointerEvent<HTMLDivElement>): void => {
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    const move = (m: PointerEvent): void => setPaneWidth(clampPane(window.innerWidth - m.clientX))
    const up = (): void => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      setPaneWidth((w) => {
        localStorage.setItem(PANE_KEY, String(w))
        return w
      })
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }
  const nudgePane = (e: React.KeyboardEvent): void => {
    const step = e.key === 'ArrowLeft' ? 40 : e.key === 'ArrowRight' ? -40 : 0
    if (!step) return
    e.preventDefault()
    setPaneWidth((w) => {
      const next = clampPane(w + step)
      localStorage.setItem(PANE_KEY, String(next))
      return next
    })
  }
  // Puts a request from a hub in the message box, cursor at its end.
  const fillBox = (text: string): void => {
    setDraft(text)
    setTimeout(() => {
      const box = document.querySelector<HTMLTextAreaElement>('textarea')
      box?.focus()
      box?.setSelectionRange(text.length, text.length)
    })
  }
  const providerName = providerNames[providerOf(settings.model)]
  // Plugins mode's path: the hub, then the workspace, then the chat.
  const toHub = (): void => {
    if (live) return
    setCurrent(null)
    setError(null)
    setWorkspace(null)
  }
  const toWorkspace = (): void => {
    if (live) return
    const w = current?.workspace
    if (w?.kind === 'internal') setWorkspace({ kind: 'internal', pluginId: w.pluginId })
    setCurrent(null)
    setError(null)
  }
  const chatTitle = live && !current ? live.userText : (current?.chatNote?.title ?? current?.title)
  const crumbs: Crumb[] | null = (() => {
    if (mode !== 'code' || (empty && !workspace)) return null
    const out: Crumb[] = [
      { label: 'All plugins', onClick: toHub, title: 'Back to the Plugins hub' }
    ]
    const w = current ? current.workspace : workspace
    if (w?.kind === 'internal')
      out.push({
        label: pluginNames[w.pluginId] ?? w.pluginId,
        title: `plugin/${w.pluginId}`,
        onClick: toWorkspace
      })
    else if (w) out.push({ label: `General Code (removed) · ${folderName(w.root)} · read only` })
    else out.push({ label: 'Hub chat (brainstorm only)' })
    if (chatTitle) out.push({ label: chatTitle })
    return out
  })()
  const inPlugin =
    mode !== 'code'
      ? null
      : current
        ? current.workspace?.kind === 'internal'
          ? current.workspace.pluginId
          : null
        : workspace?.kind === 'internal'
          ? workspace.pluginId
          : null
  const placeholder = inPlugin
    ? `Describe a change to ${pluginNames[inPlugin] ?? inPlugin}…`
    : copy[mode].placeholder.replace('{provider}', providerName)
  const split = showPane && !narrow
  const chatHidden = showPane && narrow && side === 'outputs'
  const modeLabel = modes.find((m) => m.id === mode)?.label ?? 'Chat'

  return (
    <div className="relative flex min-h-0 flex-1">
      <div className={`min-h-0 min-w-0 flex-1 flex-col ${chatHidden ? 'hidden' : 'flex'}`}>
        {showPane && narrow && <SideSwitch side={side} onSide={setSide} count={outputs.length} />}
        <div className="flex-1 overflow-y-auto">
          {mode === 'code' && crumbs && <PathBar crumbs={crumbs} />}
          {empty && mode === 'code' && workspace?.kind === 'internal' ? (
            <PluginWorkspace
              key={workspace.pluginId}
              pluginId={workspace.pluginId}
              onOpen={(id) => void open(id)}
              onBack={toHub}
            />
          ) : empty && mode === 'code' ? (
            <PluginsHub
              onEnter={(pluginId) => {
                setWorkspace({ kind: 'internal', pluginId })
                fillBox('')
              }}
            />
          ) : empty && mode === 'skills' ? (
            <SkillsHub onOpenSettings={onOpenSettings} onStart={fillBox} />
          ) : empty ? (
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
                      <SentFiles
                        chat={current.id}
                        files={(current.attachments ?? []).filter((a) => a.message === i)}
                      />
                      <SentReferences
                        items={(current.references ?? []).filter((r) => r.message === i)}
                        onOpen={openIn}
                      />
                    </div>
                  )}
                  {turnProposals.get(i)?.map((p) => (
                    <ProposalCard
                      key={p.id}
                      p={p}
                      names={pluginNames}
                      busy={!!live}
                      error={proposalError?.id === p.id ? proposalError.error : undefined}
                      onAnswer={(yes) => void answerProposal(p.id, yes)}
                    />
                  ))}
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
                  {live.files ? (
                    <p className="-mt-4 text-right text-[11px] text-ash-500">
                      Sending with {live.files} {live.files === 1 ? 'file' : 'files'}
                    </p>
                  ) : null}
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
          <WidgetSlot
            conversationId={current?.id ?? null}
            requestId={live?.requestId ?? null}
            provider={providerOf(settings.model)}
          />
          <ModeBubbles mode={mode} disabled={!!live} onChange={onModeChange} />
          {month?.budget && month.cost >= month.budget * 0.8 && (
            <p
              className={`mb-2 text-center text-xs ${month.cost >= month.budget ? 'text-molten-300' : 'text-ash-400'}`}
              data-budget-line
            >
              {month.cost >= month.budget
                ? `This month's estimated spend, ${formatCost(month.cost)}, is over your ${formatCost(month.budget)} budget. Custard keeps working; change the budget in Settings.`
                : `This month's estimated spend is ${formatCost(month.cost)} of your ${formatCost(month.budget)} budget.`}
            </p>
          )}
          <Composer
            meter={<UsageMeter usage={current?.usage} context={current?.context} />}
            busy={!!live}
            placeholder={placeholder}
            settings={settings}
            onSettings={onSettings}
            onSend={send}
            onStop={() => live && window.custard.chat.stop(live.requestId)}
            draft={draft}
            setDraft={setDraft}
            references={{
              current: current?.id ?? null,
              items: refs,
              onAdd: (c) => setRefs((x) => (x.some((r) => r.id === c.id) ? x : [...x, c])),
              onRemove: (id) => setRefs((x) => x.filter((r) => r.id !== id))
            }}
            {...(acceptsAttachments(mode)
              ? {
                  files: {
                    items: files,
                    errors: fileErrors,
                    adding,
                    onPick: () => void pickFiles(),
                    onAdd: (f: File[]) => void addFiles(f),
                    onRemove: removeFile,
                    onDismiss: () => setFileErrors([])
                  }
                }
              : {})}
          />
        </div>
      </div>

      {split && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the outputs"
          tabIndex={0}
          onPointerDown={dragPane}
          onKeyDown={nudgePane}
          className="group flex w-2 shrink-0 cursor-col-resize items-stretch justify-center focus:outline-none"
        >
          <div className="w-px bg-forge-700 transition-colors group-hover:bg-molten-500/60 group-focus:bg-molten-500/60" />
        </div>
      )}
      {showPane && (split || side === 'outputs') && (
        <div
          className={`flex min-h-0 min-w-0 flex-col ${split ? 'shrink-0' : 'flex-1'}`}
          style={split ? { width: clampPane(paneWidth) } : undefined}
        >
          {narrow && <SideSwitch side={side} onSide={setSide} count={outputs.length} />}
          <DesignWorkspace
            chat={current.id}
            outputs={outputs}
            latest={latest}
            onDraft={(text) => {
              setDraft(text)
              setSide('chat')
            }}
          />
        </div>
      )}

      {historyOpen && (
        <HistoryDrawer
          modeLabel={modeLabel}
          conversations={list}
          pluginNames={pluginNames}
          filter={filter}
          onFilter={(f) => {
            historyFilter = f
            setFilter(f)
          }}
          currentId={current?.id ?? null}
          onOpen={(id) => openIn(id, list.find((c) => c.id === id)?.mode)}
          onNew={startNew}
          onDelete={remove}
          onForget={forgetChat}
          onClose={onCloseHistory}
        />
      )}
    </div>
  )
}

export default ChatView
