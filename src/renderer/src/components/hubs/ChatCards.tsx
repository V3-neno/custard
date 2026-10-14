import type { ConversationSummary } from '../../../../shared/chat'
import { TemporaryIcon } from '../icons'

// A workspace's chats as cards, newest first: the summary's title, the goal
// underneath, and what each worked on. Pressing one opens it.

function when(ts: number): string {
  const d = new Date(ts)
  const days = Math.floor((Date.now() - ts) / 86_400_000)
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (days < 1) return `Today ${time}`
  if (days < 7) return `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`
  return d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })
}

type Props = {
  // Null while loading.
  chats: ConversationSummary[] | null
  empty: string
  onOpen: (chatId: string) => void
}

function ChatCards({ chats, empty, onOpen }: Props): React.JSX.Element | null {
  return chats === null ? null : chats.length === 0 ? (
    <p className="rounded-2xl border border-dashed border-forge-700 py-10 text-center text-sm text-ash-500">
      {empty}
    </p>
  ) : (
    <div className="grid gap-3 sm:grid-cols-2" role="list" aria-label="Chats in this workspace">
      {chats.map((c) => (
        <button
          key={c.id}
          role="listitem"
          aria-label={`Chat ${c.title}`}
          title={c.noteTitle ? `Started with: ${c.title}` : undefined}
          onClick={() => onOpen(c.id)}
          className="flex flex-col rounded-2xl border border-forge-700 bg-forge-850/60 p-4 text-left transition-colors hover:border-molten-500/40"
        >
          <span className="line-clamp-2 font-medium text-ash-100">{c.noteTitle ?? c.title}</span>
          {c.goal || c.summary ? (
            <span className="mt-1 line-clamp-3 text-sm text-ash-400" data-chat-summary>
              {c.goal ?? c.summary}
            </span>
          ) : (
            <span className="mt-1 text-sm text-ash-500 italic">
              No summary yet. It is written a little after a turn ends.
            </span>
          )}
          {c.tags?.length ? (
            <span className="mt-2 flex flex-wrap gap-1.5" data-chat-tags>
              {c.tags.map((t) => (
                <span
                  key={t}
                  className="rounded-full border border-forge-700 px-2 py-0.5 text-[11px] text-ash-400"
                >
                  {t}
                </span>
              ))}
            </span>
          ) : null}
          <span className="mt-3 flex items-center gap-1.5 text-xs text-ash-500">
            {when(c.updatedAt)}
            {c.temporary && (
              <>
                · <TemporaryIcon /> Temporary
              </>
            )}
          </span>
        </button>
      ))}
    </div>
  )
}

export default ChatCards
