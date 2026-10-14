import { useCallback, useEffect, useState } from 'react'
import TopBar from './components/TopBar'
import SettingsDialog from './components/SettingsDialog'
import ChatView from './components/chat/ChatView'
import { queuePluginWorkspace } from './components/chat/workspaceEntry'
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
  const [vaultConnected, setVaultConnected] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  // The default model, from Settings → General; each chat keeps its own.
  const [settings, setSettings] = useState<ChatSettings>(defaultChatSettings)
  // The model of the chat on screen, which the colours follow.
  const [shown, setShown] = useState<ChatSettings['model']>(defaultChatSettings.model)
  const [statusTick, setStatusTick] = useState(0)
  const [labels, setLabels] = useState<Record<string, string>>({})
  // Whether the chat on screen (or the next new one) is temporary. Switching
  // it in a chat that has started opens a new chat of the other kind.
  const [temporary, setTemporary] = useState(false)
  const [newChat, setNewChat] = useState(0)
  const [home, setHome] = useState(0)
  const [entry, setEntry] = useState(0)
  const [busy, setBusy] = useState(false)
  const [outsideText, setOutsideText] = useState(false)
  const provider = providerOf(shown)

  useEffect(() => {
    window.custard.settings.get().then(setSettings)
  }, [])

  // The whole palette follows the provider (see main.css).
  useEffect(() => {
    document.documentElement.dataset.provider = provider
  }, [provider])

  const loadStatus = useCallback(() => {
    window.custard.vault.get().then((v) => setVaultConnected(v !== null))
    window.custard.plugins.labels().then(setLabels)
  }, [])
  useEffect(() => {
    loadStatus()
  }, [loadStatus])
  // After Settings: the default model and which models the keys reach may
  // have changed.
  const refreshStatus = (): void => {
    setStatusTick((n) => n + 1)
    window.custard.settings.get().then(setSettings)
    loadStatus()
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
            key={mode === 'code' ? `code-${entry}` : mode}
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
            settings={settings}
            onShownModel={setShown}
            statusTick={statusTick}
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
              onBuild={async (provider, capability) => {
                // A chat answering in Plugins mode keeps its place.
                if (busy && mode === 'code')
                  throw new Error('Wait for the Plugins chat to finish answering first.')
                const r = await window.custard.capabilities.startPlugin(provider, capability)
                queuePluginWorkspace({ pluginId: r.pluginId, request: r.request })
                setSettingsOpen(false)
                refreshStatus()
                // A fresh Plugins view, which opens the queued workspace.
                setEntry((n) => n + 1)
                setMode('code')
              }}
            />
          )}
        </div>
      </ToolLabelsContext.Provider>
    </ProviderContext.Provider>
  )
}

export default App
