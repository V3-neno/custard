import { useCallback, useEffect, useState } from 'react'
import TopBar from './components/TopBar'
import SettingsDialog from './components/SettingsDialog'
import ChatView from './components/chat/ChatView'
import {
  defaultChatSettings,
  modes,
  providerOf,
  type ChatSettings,
  type Mode
} from '../../shared/chat'
import { ProviderContext } from './provider'
import { ToolLabelsContext } from './toolLabels'

function App(): React.JSX.Element {
  const [mode, setMode] = useState<Mode>('chat')
  const [hasKey, setHasKey] = useState(true)
  const [vaultConnected, setVaultConnected] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [settings, setSettings] = useState<ChatSettings>(defaultChatSettings)
  const [labels, setLabels] = useState<Record<string, string>>({})
  // Whether the chat on screen (or the next new one) is temporary. Switching
  // it in a chat that has started opens a new chat of the other kind.
  const [temporary, setTemporary] = useState(false)
  const [newChat, setNewChat] = useState(0)
  const [home, setHome] = useState(0)
  const [busy, setBusy] = useState(false)
  const [outsideText, setOutsideText] = useState(false)
  const provider = providerOf(settings.model)

  useEffect(() => {
    window.custard.settings.get().then(setSettings)
  }, [])

  // The whole palette follows the provider (see main.css).
  useEffect(() => {
    document.documentElement.dataset.provider = provider
  }, [provider])

  const refreshStatus = useCallback(() => {
    window.custard.apiKey.has(provider).then(setHasKey)
    window.custard.vault.get().then((v) => setVaultConnected(v !== null))
    window.custard.plugins.labels().then(setLabels)
  }, [provider])
  useEffect(() => {
    refreshStatus()
  }, [refreshStatus])

  const updateSettings = (s: ChatSettings): void => {
    setSettings(s)
    window.custard.settings.set(s)
  }

  return (
    <ProviderContext.Provider value={provider}>
      <ToolLabelsContext.Provider value={labels}>
        <div className="flex h-full flex-col">
          <TopBar
            modeLabel={modes.find((m) => m.id === mode)?.label ?? 'Chat'}
            vaultConnected={vaultConnected}
            temporary={temporary}
            busy={busy}
            outsideText={outsideText}
            onTemporary={() => {
              setTemporary((t) => !t)
              setNewChat((n) => n + 1)
            }}
            onHistory={() => setHistoryOpen(true)}
            onSettings={() => setSettingsOpen(true)}
          />
          {/* Each mode has its own history; coming back to a mode reopens its chat. */}
          <ChatView
            key={mode}
            mode={mode}
            onModeChange={(m) => {
              // The mode already shown: back to its start page (a new chat).
              if (m === mode) {
                if (!busy) {
                  setNewChat((n) => n + 1)
                  setHome((n) => n + 1)
                }
              } else setMode(m)
            }}
            hasKey={hasKey}
            settings={settings}
            onSettings={updateSettings}
            onOpenSettings={() => setSettingsOpen(true)}
            historyOpen={historyOpen}
            onCloseHistory={() => setHistoryOpen(false)}
            temporary={temporary}
            onTemporary={setTemporary}
            newChat={newChat}
            home={home}
            onBusy={setBusy}
            onOutsideText={setOutsideText}
          />
          {settingsOpen && (
            <SettingsDialog
              onClose={() => {
                setSettingsOpen(false)
                refreshStatus()
              }}
              onChanged={refreshStatus}
            />
          )}
        </div>
      </ToolLabelsContext.Provider>
    </ProviderContext.Provider>
  )
}

export default App
