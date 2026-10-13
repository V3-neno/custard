import { useCallback, useEffect, useState } from 'react'
import type { ConversationSummary } from '../../../../shared/chat'
import type { PluginStatus } from '../../../../shared/plugins'
import ChatCards from './ChatCards'
import { cleanError } from '../settings/ui'
import ManagePanel from './ManagePanel'
import { Badge } from './PluginDetail'

// One plugin's workspace: its chats as cards, newest first, and the message
// box below to start a new one. Chats started here can edit only this
// plugin's folder (see main/modes/policy).

type Props = {
  pluginId: string
  onOpen: (chatId: string) => void
  onBack: () => void
}

const pill =
  'rounded-full border border-forge-700 bg-forge-850/80 px-3 py-1 text-xs text-ash-300 transition-colors hover:border-molten-500/50 hover:text-molten-200'

function PluginWorkspace({ pluginId, onOpen, onBack }: Props): React.JSX.Element {
  const [plugin, setPlugin] = useState<PluginStatus | null | undefined>(undefined)
  const [chats, setChats] = useState<ConversationSummary[] | null>(null)
  const [manage, setManage] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    window.custard.plugins
      .list()
      .then((list) => setPlugin(list.find((p) => p.id === pluginId) ?? null))
      .catch((e) => setError(cleanError(e)))
    // Already newest first.
    window.custard.conversations
      .list('code')
      .then((list) => setChats(list.filter((c) => c.pluginId === pluginId)))
      .catch((e) => setError(cleanError(e)))
  }, [pluginId])
  useEffect(() => load(), [load])

  if (plugin === null)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <h1 className="text-2xl font-semibold text-molten-200">plugin/{pluginId} is gone</h1>
        <p className="text-sm text-ash-400">
          It was uninstalled or its folder was removed. Its chats are still in History.
        </p>
        <button onClick={onBack} className={pill}>
          Back to Plugins
        </button>
      </div>
    )

  return (
    <div className="mx-auto w-full max-w-4xl px-6 pt-6 pb-6">
      <div className="mb-5 flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <div className="text-xs tracking-[0.2em] text-ash-500 uppercase">
            Workspace · plugin/{pluginId}
          </div>
          <h1 className="flex items-baseline gap-2 text-2xl font-semibold tracking-tight text-molten-200">
            {plugin?.name ?? pluginId}
            {plugin?.active && (
              <span className="text-xs font-normal text-ash-500">v{plugin.active.version}</span>
            )}
          </h1>
          {plugin && <p className="mt-1 line-clamp-2 text-sm text-ash-400">{plugin.description}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-2 pt-5">
          {plugin && <Badge p={plugin} />}
          {plugin && (
            <button className={pill} onClick={() => setManage(true)}>
              Manage
            </button>
          )}
        </div>
      </div>
      {error && <p className="mb-3 text-xs text-ember-600">{error}</p>}
      <div className="mb-2 flex items-baseline gap-2">
        <h2 className="text-xs tracking-[0.2em] text-ash-500 uppercase">Chats</h2>
        <span className="text-xs text-ash-500">
          Newest first. Describe a change below to start a new one.
        </span>
      </div>
      <ChatCards
        chats={chats}
        empty={`No chats in this workspace yet. What should change in ${plugin?.name ?? pluginId}?`}
        onOpen={onOpen}
      />
      {manage && plugin && (
        <ManagePanel
          plugin={plugin}
          onChange={setPlugin}
          onRefresh={load}
          onClose={() => {
            setManage(false)
            load()
          }}
        />
      )}
    </div>
  )
}

export default PluginWorkspace
