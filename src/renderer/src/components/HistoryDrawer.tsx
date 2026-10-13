import { useState } from 'react'
import { modes, type ConversationSummary, type Mode } from '../../../shared/chat'
import { CloseIcon, PlusIcon, TemporaryIcon } from './icons'

type Props = {
  modeLabel: string
  // Every mode's chats, or one mode's (filter).
  conversations: ConversationSummary[]
  // Plugins chats show their plugin's name.
  pluginNames: Record<string, string>
  filter: Mode | null
  onFilter: (f: Mode | null) => void
  currentId: string | null
  onOpen: (id: string) => void
  onNew: () => void
  onDelete: (id: string) => void
  onForget: (id: string) => void
  onClose: () => void
}

function when(ts: number): string {
  const days = Math.floor((Date.now() - ts) / 86_400_000)
  if (days < 1) return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (days < 7) return new Date(ts).toLocaleDateString([], { weekday: 'short' })
  return new Date(ts).toLocaleDateString([], { day: 'numeric', month: 'short' })
}

function HistoryDrawer(props: Props): React.JSX.Element {
  const { modeLabel, conversations, filter, onFilter, currentId, onOpen, onNew, onDelete } = props
  const { onForget, onClose, pluginNames } = props
  const [find, setFind] = useState('')
  const q = find.trim().toLowerCase()
  // Finds by either title, and by what its note says (goal, where it
  // stands, tags).
  const shown = q
    ? conversations.filter((c) =>
        [c.title, c.noteTitle, c.goal, c.summary, ...(c.tags ?? [])].some((x) =>
          x?.toLowerCase().includes(q)
        )
      )
    : conversations
  const label = (m: Mode): string => modes.find((x) => x.id === m)?.label ?? m
  const filterChip = (on: boolean): string =>
    `rounded-full px-2.5 py-0.5 text-xs transition-colors ${
      on ? 'bg-forge-700 text-ash-100' : 'text-ash-400 hover:text-ash-100'
    }`
  return (
    <div className="fixed inset-0 z-20 flex" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50" />
      <aside
        className="drawer-in relative flex h-full w-80 flex-col border-r border-forge-700 bg-forge-900/95 backdrop-blur"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center px-5 pt-5 pb-3">
          <div>
            <div className="text-xs tracking-[0.2em] text-ash-500 uppercase">History</div>
            <div className="text-lg font-semibold text-molten-200">
              {filter ? label(filter) : 'All chats'}
            </div>
          </div>
          <button
            onClick={onClose}
            className="ml-auto rounded-full p-2 text-ash-400 hover:bg-forge-800 hover:text-molten-300"
          >
            <CloseIcon />
          </button>
        </div>
        <button
          onClick={onNew}
          className="mx-4 mb-3 flex items-center gap-2 rounded-xl border border-forge-700 px-3 py-2.5 text-sm text-ash-300 transition-colors hover:border-molten-500/50 hover:text-molten-200"
        >
          <PlusIcon /> {modeLabel === 'Chat' ? 'New chat' : `New ${modeLabel.toLowerCase()} chat`}
        </button>
        <div
          role="group"
          aria-label="Show chats from"
          className="mx-4 mb-2 flex flex-wrap gap-1 rounded-2xl border border-forge-700 p-0.5"
        >
          <button className={filterChip(filter === null)} onClick={() => onFilter(null)}>
            All
          </button>
          {modes.map((m) => (
            <button
              key={m.id}
              className={filterChip(filter === m.id)}
              onClick={() => onFilter(m.id)}
            >
              {m.label}
            </button>
          ))}
        </div>
        <input
          aria-label="Find a chat"
          value={find}
          onChange={(e) => setFind(e.target.value)}
          placeholder="Find a chat…"
          className="mx-4 mb-3 rounded-full border border-forge-700 bg-forge-900 px-3 py-1 text-xs outline-none focus:border-molten-500/60"
        />
        <div className="forge-line mx-4 mb-2" />
        <div className="flex-1 overflow-y-auto px-3 pb-4">
          {shown.length === 0 && (
            <p className="px-2 py-6 text-center text-sm text-ash-500">
              {q
                ? 'No chat matches that.'
                : filter
                  ? `Nothing here yet. Chats you start in ${label(filter)} will show up here.`
                  : 'Nothing here yet. Your chats will show up here.'}
            </p>
          )}
          {shown.map((c) => (
            <div
              key={c.id}
              className={`group flex items-center rounded-xl transition-colors ${
                currentId === c.id
                  ? 'bg-forge-800 text-molten-200'
                  : 'text-ash-300 hover:bg-forge-850 hover:text-ash-100'
              }`}
            >
              <button onClick={() => onOpen(c.id)} className="min-w-0 flex-1 px-3 py-2.5 text-left">
                <div className="truncate text-sm" title={c.noteTitle ? c.title : undefined}>
                  {c.noteTitle ?? c.title}
                </div>
                {(c.goal ?? c.summary) && (
                  <div className="line-clamp-2 text-xs text-ash-400" data-chat-summary>
                    {c.goal ?? c.summary}
                  </div>
                )}
                {c.tags?.length ? (
                  <div className="mt-1 flex flex-wrap gap-1" data-chat-tags>
                    {c.tags.map((t) => (
                      <span
                        key={t}
                        className="rounded-full border border-forge-700 px-1.5 text-[10px] text-ash-400"
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                ) : null}
                <div className="flex items-center gap-1.5 text-xs text-ash-500">
                  {when(c.updatedAt)}
                  {!filter && <span>· {label(c.mode)}</span>}
                  {c.pluginId && (
                    <span className="truncate" title={`plugin/${c.pluginId}`} data-chat-plugin>
                      · {pluginNames[c.pluginId] ?? c.pluginId}
                    </span>
                  )}
                  {c.temporary && (
                    <span className="flex items-center gap-1 text-ash-500">
                      · <TemporaryIcon /> Temporary
                    </span>
                  )}
                </div>
              </button>
              {!c.temporary && (
                <button
                  onClick={() => onForget(c.id)}
                  title="Delete the notes Custard saved from this chat and never remember it again. Asks first."
                  className="hidden rounded-full px-2 py-1 text-xs text-ash-500 group-hover:block hover:text-molten-200"
                >
                  Forget
                </button>
              )}
              <button
                onClick={() => onDelete(c.id)}
                title="Delete"
                className="mr-2 hidden rounded-full p-1.5 text-ash-500 group-hover:block hover:text-ember-600"
              >
                <CloseIcon />
              </button>
            </div>
          ))}
        </div>
      </aside>
    </div>
  )
}

export default HistoryDrawer
