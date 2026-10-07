import { useState } from 'react'
import Sidebar from './components/Sidebar'
import { modes, type Mode } from './modes'

function App(): React.JSX.Element {
  const [mode, setMode] = useState<Mode>('chat')
  const current = modes.find((m) => m.id === mode)!

  return (
    <div className="flex h-full">
      <Sidebar mode={mode} onChange={setMode} />
      <main className="flex flex-1 flex-col">
        <header className="border-b border-ink-700 px-6 py-4">
          <h1 className="text-base font-semibold">{current.label}</h1>
          <p className="text-sm text-ink-300">{current.blurb}</p>
        </header>
        <section className="flex flex-1 items-center justify-center text-ink-500">
          {current.label} mode is coming next.
        </section>
      </main>
    </div>
  )
}

export default App
