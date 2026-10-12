import Orb from './Orb'
import { HistoryIcon, SettingsIcon, TemporaryIcon, VaultIcon } from './icons'

type Props = {
  modeLabel: string
  vaultConnected: boolean
  temporary: boolean
  busy: boolean
  outsideText: boolean
  onTemporary: () => void
  onHistory: () => void
  onSettings: () => void
}

const iconButton =
  'flex h-9 w-9 items-center justify-center rounded-full text-lg text-ash-400 transition-colors hover:bg-forge-800 hover:text-molten-300'

function TopBar(props: Props): React.JSX.Element {
  const {
    modeLabel,
    vaultConnected,
    temporary,
    busy,
    outsideText,
    onTemporary,
    onHistory,
    onSettings
  } = props
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
        {outsideText && (
          <span
            className="mr-1 flex items-center gap-1.5 rounded-full border border-molten-500/50 px-2.5 py-1 text-xs text-molten-200"
            title="This chat has web or plugin text in it, so changes to notes ask for approval first, even in allowed folders."
          >
            Outside text
          </span>
        )}
        {vaultConnected && (
          <button
            role="switch"
            aria-checked={temporary}
            aria-label="Temporary chat"
            onClick={onTemporary}
            disabled={busy}
            title={
              temporary
                ? "Temporary chat: Custard won't remember anything from it. Click to start a normal chat."
                : "Start a temporary chat that Custard won't remember."
            }
            className={`mr-1 flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors disabled:opacity-40 ${
              temporary
                ? 'border-molten-500/60 bg-forge-850 text-molten-200 shadow-[0_0_10px_rgb(var(--glow)/0.25)]'
                : 'border-forge-700 text-ash-400 hover:border-molten-500/50 hover:text-molten-200'
            }`}
          >
            <TemporaryIcon className={temporary ? 'text-molten-300' : 'text-ash-500'} />
            Temporary
          </button>
        )}
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
