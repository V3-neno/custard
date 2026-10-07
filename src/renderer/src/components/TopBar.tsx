import Orb from './Orb'
import { HistoryIcon, SettingsIcon, VaultIcon } from './icons'

type Props = {
  modeLabel: string
  vaultConnected: boolean
  onHistory: () => void
  onSettings: () => void
}

const iconButton =
  'flex h-9 w-9 items-center justify-center rounded-full text-lg text-ash-400 transition-colors hover:bg-forge-800 hover:text-molten-300'

function TopBar({ modeLabel, vaultConnected, onHistory, onSettings }: Props): React.JSX.Element {
  return (
    <header className="relative flex h-14 shrink-0 items-center gap-2 px-4">
      <button onClick={onHistory} className={iconButton} title={`${modeLabel} history`}>
        <HistoryIcon />
      </button>
      <div className="flex items-center gap-2.5 pl-1">
        <Orb size={20} state="breathing" paused />
        <span className="text-[15px] font-semibold tracking-[0.18em] text-molten-200 uppercase">
          Custard
        </span>
      </div>
      <div className="ml-auto flex items-center gap-1">
        {vaultConnected && (
          <span
            className="mr-1 flex items-center gap-1.5 rounded-full border border-forge-700 px-2.5 py-1 text-xs text-ash-400"
            title="Obsidian vault connected"
          >
            <VaultIcon className="text-molten-400" />
            Brain
          </span>
        )}
        <button onClick={onSettings} className={iconButton} title="Settings">
          <SettingsIcon />
        </button>
      </div>
      <div className="forge-line absolute inset-x-0 bottom-0" />
    </header>
  )
}

export default TopBar
