import { useCallback, useEffect, useState } from 'react'
import Sidebar from './components/Sidebar'
import SettingsDialog from './components/SettingsDialog'
import ChatView from './components/chat/ChatView'
import { modes, type Mode } from './modes'

function App(): React.JSX.Element {
  const [mode, setMode] = useState<Mode>('chat')
  const [hasKey, setHasKey] = useState(true)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const current = modes.find((m) => m.id === mode)!

  const checkKey = useCallback(() => window.custard.apiKey.has().then(setHasKey), [])
  useEffect(() => {
    checkKey()
  }, [checkKey])

  return (
    <div className="flex h-full">
      <Sidebar mode={mode} onChange={setMode} onOpenSettings={() => setSettingsOpen(true)} />
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="border-b border-ink-700 px-6 py-4">
          <h1 className="text-base font-semibold">{current.label}</h1>
          <p className="text-sm text-ink-300">{current.blurb}</p>
        </header>
        {mode === 'chat' ? (
          <ChatView hasKey={hasKey} onOpenSettings={() => setSettingsOpen(true)} />
        ) : (
          <section className="flex flex-1 items-center justify-center text-ink-500">
            {current.label} mode is coming next.
          </section>
        )}
      </main>
      {settingsOpen && (
        <SettingsDialog
          hasKey={hasKey}
          onClose={() => setSettingsOpen(false)}
          onChanged={checkKey}
        />
      )}
    </div>
  )
}

export default App
