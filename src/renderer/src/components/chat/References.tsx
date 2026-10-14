import { useEffect, useMemo, useRef, useState } from 'react'
import {
  modes,
  type ChatLink,
  type ChatReference,
  type ConversationSummary,
  type Mode
} from '../../../../shared/chat'
import { ChatLinkIcon } from '../icons'

// Earlier chats picked in the message box: their summary notes in
// Custard/Chats go with the message (see main/earlierChats). Only chats with a
// note can be picked; temporary and forgotten chats have none.

export const MAX_REFERENCES = 3

const modeLabel = (m: Mode): string => modes.find((x) => x.id === m)?.label ?? m

const fold = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

export function ReferenceButton({
  current,
  picked,
  onAdd,
  disabled
}: {
  current: string | null
  picked: ChatLink[]
  onAdd: (c: ChatLink) => void
  disabled: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [chats, setChats] = useState<ConversationSummary[] | null>(null)
  const [query, setQuery] = useState('')
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    // Closes on a click anywhere else, or Escape.
    const away = (e: MouseEvent): void => {
      if (!box.current?.contains(e.target as Node)) setOpen(false)
    }
    const esc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', esc)
    }
  }, [open])

  const full = picked.length >= MAX_REFERENCES
  const shown = useMemo(() => {
    const words = fold(query).split(/\s+/).filter(Boolean)
    return (chats ?? []).filter(
      (c) =>
        c.id !== current &&
        !!c.summary &&
        !c.temporary &&
        words.every((w) => fold(`${c.title} ${c.summary}`).includes(w))
    )
  }, [chats, query, current])

  return (
    <div ref={box} className="relative">
      <button
        onClick={() => {
          if (open) return setOpen(false)
          setQuery('')
          setChats(null)
          setOpen(true)
          void window.custard.conversations
            .list(null)
            .then(setChats)
            .catch(() => setChats([]))
        }}
        disabled={disabled}
        title="Reference an earlier chat: its summary note goes with your message"
        aria-label="Reference a chat"
        aria-expanded={open}
        className={`flex h-8 w-8 items-center justify-center rounded-full border text-base transition-colors disabled:opacity-40 ${
          open
            ? 'border-molten-500/50 text-molten-200'
            : 'border-forge-700 text-ash-400 hover:border-molten-500/50 hover:text-molten-200'
        }`}
      >
        <ChatLinkIcon />
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Reference a chat"
          className="absolute bottom-10 left-0 z-30 w-[360px] max-w-[80vw] rounded-2xl border border-forge-700 bg-forge-900 p-2 shadow-[0_10px_40px_rgb(0_0_0/0.5)]"
        >
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find a chat"
            aria-label="Find a chat to reference"
            className="mb-2 w-full rounded-xl border border-forge-700 bg-forge-850 px-3 py-1.5 text-sm text-ash-100 outline-none placeholder:text-ash-500 focus:border-molten-500/50"
          />
          <ul className="max-h-64 overflow-y-auto" aria-label="Chats you can reference">
            {chats === null && <li className="px-2 py-1.5 text-xs text-ash-500">Loading…</li>}
            {chats !== null && shown.length === 0 && (
              <li className="px-2 py-1.5 text-xs text-ash-500">
                {query ? 'No chat matches.' : 'No earlier chats with a summary note yet.'}
              </li>
            )}
            {shown.map((c) => {
              const already = picked.some((p) => p.id === c.id)
              return (
                <li key={c.id}>
                  <button
                    onClick={() => {
                      onAdd({ id: c.id, title: c.title, mode: c.mode })
                      setOpen(false)
                    }}
                    disabled={already || full}
                    className="w-full rounded-xl px-2 py-1.5 text-left transition-colors hover:bg-forge-800 disabled:opacity-40"
                  >
                    <span className="flex items-baseline gap-2">
                      <span className="truncate text-sm text-ash-100">{c.title}</span>
                      <span className="shrink-0 text-[10px] text-ash-500 uppercase">
                        {modeLabel(c.mode)}
                        {already ? ' · added' : ''}
                      </span>
                    </span>
                    <span className="line-clamp-2 block text-xs text-ash-400">{c.summary}</span>
                  </button>
                </li>
              )
            })}
          </ul>
          <p className="mt-2 border-t border-forge-800 px-2 pt-2 text-[11px] text-ash-500">
            {full
              ? `A message can reference ${MAX_REFERENCES} chats at most.`
              : 'Only chats with a summary note in Custard/Chats are listed. The note goes with your message, not the whole chat.'}
          </p>
        </div>
      )}
    </div>
  )
}

// Picked chats, above the message box.
export function DraftReferences({
  items,
  onRemove,
  disabled
}: {
  items: ChatLink[]
  onRemove: (id: string) => void
  disabled: boolean
}): React.JSX.Element | null {
  if (!items.length) return null
  return (
    <ul aria-label="Chats to reference" className="mb-2 flex flex-wrap gap-2 px-1">
      {items.map((r) => (
        <li
          key={r.id}
          className="flex max-w-[260px] items-center gap-1.5 rounded-full border border-forge-700 bg-forge-900 py-0.5 pr-1 pl-2.5 text-xs"
        >
          <ChatLinkIcon className="shrink-0 text-molten-300" />
          <span className="truncate text-ash-200" title={r.title}>
            {r.title}
          </span>
          <button
            onClick={() => onRemove(r.id)}
            disabled={disabled}
            aria-label={`Remove ${r.title}`}
            title="Remove"
            className="rounded-full px-1.5 text-ash-500 hover:text-ember-600 disabled:opacity-40"
          >
            ×
          </button>
        </li>
      ))}
    </ul>
  )
}

// Under a sent message: the chats it referenced, each opening that chat.
export function SentReferences({
  items,
  onOpen
}: {
  items: ChatReference[]
  onOpen: (id: string, mode: Mode) => void
}): React.JSX.Element | null {
  if (!items.length) return null
  return (
    <div
      aria-label="Referenced chats"
      className="mt-1.5 flex flex-wrap justify-end gap-1.5 text-xs text-ash-500"
    >
      <span className="py-0.5">Referenced:</span>
      {items.map((r) => (
        <button
          key={r.chat}
          onClick={() => onOpen(r.chat, r.mode)}
          title={`Open "${r.title}". Its summary note as it was when sent is what the assistant sees.`}
          className="flex max-w-[220px] items-center gap-1 rounded-full border border-forge-700 px-2 py-0.5 text-ash-300 hover:border-molten-500/50 hover:text-molten-200"
        >
          <ChatLinkIcon className="shrink-0" />
          <span className="truncate">{r.title}</span>
        </button>
      ))}
    </div>
  )
}
