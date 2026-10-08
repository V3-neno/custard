import { modes, type Mode } from '../../../shared/chat'

type Props = { mode: Mode; disabled: boolean; onChange: (mode: Mode) => void }

function ModeBubbles({ mode, disabled, onChange }: Props): React.JSX.Element {
  return (
    <div className="mb-3 flex justify-center gap-2">
      {modes.map((m) => {
        const active = m.id === mode
        return (
          <button
            key={m.id}
            onClick={() => onChange(m.id)}
            disabled={disabled && !active}
            title={m.hint}
            className={`rounded-full px-4 py-1.5 text-sm font-medium transition-all disabled:opacity-40 ${
              active
                ? 'molten-fill text-forge-950 shadow-[0_0_24px_rgb(var(--glow)/0.35)]'
                : 'border border-forge-700 bg-forge-850/80 text-ash-300 backdrop-blur hover:border-molten-500/50 hover:text-molten-200'
            }`}
          >
            {m.label}
          </button>
        )
      })}
    </div>
  )
}

export default ModeBubbles
