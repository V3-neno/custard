import type { ConversationSummary } from '../../../shared/chat'
import { CloseIcon, PlusIcon } from './icons'

type Props = {
  modeLabel: string
  conversations: ConversationSummary[]
  currentId: string | null
  onOpen: (id: string) => void
  onNew: () => void
  onDelete: (id: string) => void
  onClose: () => void
}

function when(ts: number): string {
  const days = Math.floor((Date.now() - ts) / 86_400_000)
  if (days < 1) return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (days < 7) return new Date(ts).toLocaleDateString([], { weekday: 'short' })
  return new Date(ts).toLocaleDateString([], { day: 'numeric', month: 'short' })
}

function HistoryDrawer(props: Props): React.JSX.Element {
  const { modeLabel, conversations, currentId, onOpen, onNew, onDelete, onClose } = props
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
            <div className="text-lg font-semibold text-molten-200">{modeLabel}</div>
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
          <PlusIcon /> New {modeLabel.toLowerCase()}
        </button>
        <div className="forge-line mx-4 mb-2" />
        <div className="flex-1 overflow-y-auto px-3 pb-4">
          {conversations.length === 0 && (
            <p className="px-2 py-6 text-center text-sm text-ash-500">
              Nothing here yet. Your {modeLabel.toLowerCase()} sessions will show up here.
            </p>
          )}
          {conversations.map((c) => (
            <div
              key={c.id}
              className={`group flex items-center rounded-xl transition-colors ${
                currentId === c.id
                  ? 'bg-forge-800 text-molten-200'
                  : 'text-ash-300 hover:bg-forge-850 hover:text-ash-100'
              }`}
            >
              <button onClick={() => onOpen(c.id)} className="min-w-0 flex-1 px-3 py-2.5 text-left">
                <div className="truncate text-sm">{c.title}</div>
                <div className="text-xs text-ash-500">{when(c.updatedAt)}</div>
              </button>
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
