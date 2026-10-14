import type { PluginStatus } from '../../../../shared/plugins'
import { CloseIcon } from '../icons'
import { Detail } from './PluginDetail'

// Everything Settings → Plugins used to hold for one plugin, in a panel that
// floats in from the right (from the hub and from the plugin's workspace).

const pill =
  'rounded-full border border-forge-700 bg-forge-850/80 px-3 py-1 text-xs text-ash-300 transition-colors hover:border-molten-500/50 hover:text-molten-200'

type Props = {
  plugin: PluginStatus
  onChange: (s: PluginStatus) => void
  onRefresh: () => void
  onClose: () => void
  // From the hub: enter the plugin's workspace. Left out inside it.
  onEnter?: () => void
}

function ManagePanel({ plugin, onChange, onRefresh, onClose, onEnter }: Props): React.JSX.Element {
  return (
    <div className="fixed inset-0 z-20 flex items-center justify-end p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50" />
      <aside
        role="dialog"
        aria-label={`Manage ${plugin.name}`}
        className="panel-in relative flex max-h-[min(100%,80vh)] w-full max-w-2xl flex-col rounded-2xl border border-forge-700 bg-forge-900/95 shadow-2xl shadow-black/60 backdrop-blur"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center px-6 pt-5 pb-3">
          <div className="text-xs tracking-[0.2em] text-ash-500 uppercase">Plugin</div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="ml-auto rounded-full p-2 text-ash-400 hover:bg-forge-800 hover:text-molten-300"
          >
            <CloseIcon />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
          <Detail key={plugin.id} p={plugin} onChange={onChange} />
        </div>
        <div className="flex gap-2 border-t border-forge-700 px-6 py-3">
          {onEnter && (
            <button
              onClick={onEnter}
              className="molten-fill rounded-full px-4 py-1.5 text-xs font-medium text-forge-950"
            >
              Open its workspace
            </button>
          )}
          <button
            onClick={onRefresh}
            className={pill}
            title="Read plugin/ again, for changes made outside this window"
          >
            Refresh
          </button>
          <button onClick={onClose} className={`${pill} ml-auto`}>
            Done
          </button>
        </div>
      </aside>
    </div>
  )
}

export default ManagePanel
