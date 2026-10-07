import { modes, type Mode } from '../modes'

type Props = { mode: Mode; onChange: (mode: Mode) => void }

function Sidebar({ mode, onChange }: Props): React.JSX.Element {
  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-ink-700 bg-ink-800 p-3">
      <div className="mb-6 flex items-center gap-2 px-2 pt-2">
        <span className="text-2xl">🍮</span>
        <span className="text-lg font-semibold tracking-tight text-custard-300">Custard</span>
      </div>
      <nav className="flex flex-col gap-1">
        {modes.map((m) => (
          <button
            key={m.id}
            onClick={() => onChange(m.id)}
            className={`flex items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors ${
              mode === m.id
                ? 'bg-custard-400 font-medium text-ink-900'
                : 'text-ink-300 hover:bg-ink-700 hover:text-custard-50'
            }`}
          >
            <span>{m.icon}</span>
            {m.label}
          </button>
        ))}
      </nav>
      <div className="mt-auto px-2 text-xs text-ink-500">Running on {window.custard.platform}</div>
    </aside>
  )
}

export default Sidebar
