import { useCallback, useEffect, useState } from 'react'
import TopBar from './components/TopBar'
import SettingsDialog from './components/SettingsDialog'
import ChatView from './components/chat/ChatView'
import { modes, type Mode } from '../../shared/chat'

function App(): React.JSX.Element {
  const [mode, setMode] = useState<Mode>('chat')
  const [hasKey, setHasKey] = useState(true)
  const [vaultConnected, setVaultConnected] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)

  const refreshStatus = useCallback(() => {
    window.custard.apiKey.has().then(setHasKey)
    window.custard.vault.get().then((v) => setVaultConnected(v !== null))
  }, [])
  useEffect(() => {
    refreshStatus()
  }, [refreshStatus])

  return (
    <div className="flex h-full flex-col">
      <TopBar
        modeLabel={modes.find((m) => m.id === mode)?.label ?? 'Chat'}
        vaultConnected={vaultConnected}
        onHistory={() => setHistoryOpen(true)}
        onSettings={() => setSettingsOpen(true)}
      />
      {/* Each mode has its own history, so switching mode starts fresh. */}
      <ChatView
        key={mode}
        mode={mode}
        onModeChange={setMode}
        hasKey={hasKey}
        onOpenSettings={() => setSettingsOpen(true)}
        historyOpen={historyOpen}
        onCloseHistory={() => setHistoryOpen(false)}
      />
      {settingsOpen && (
        <SettingsDialog
          hasKey={hasKey}
          onClose={() => {
            setSettingsOpen(false)
            refreshStatus()
          }}
          onChanged={refreshStatus}
        />
      )}
    </div>
  )
}

export default App
