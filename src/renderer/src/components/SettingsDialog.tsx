import { useCallback, useEffect, useState } from 'react'
import { providerNames, type Provider } from '../../../shared/chat'
import { MEMORY_NOTE, type VaultInfo } from '../../../shared/vault'
import type { MemorySettings } from '../../../shared/memory'

import PluginsTab from './settings/PluginsTab'
import DesignTab from './settings/DesignTab'
import { cleanError, primary, secondary } from './settings/ui'

type Props = { onClose: () => void; onChanged: () => void }
type Tab = 'general' | 'design' | 'plugins'

const keyInfo: Record<Provider, { placeholder: string; where: string }> = {
  claude: { placeholder: 'sk-ant-…', where: 'console.anthropic.com' },
  openai: { placeholder: 'sk-…', where: 'platform.openai.com' }
}

function KeySection({
  provider,
  onChanged
}: {
  provider: Provider
  onChanged: () => void
}): React.JSX.Element {
  const [key, setKey] = useState('')
  const [hasKey, setHasKey] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(() => window.custard.apiKey.has(provider).then(setHasKey), [provider])
  useEffect(() => {
    refresh()
  }, [refresh])

  const save = async (): Promise<void> => {
    try {
      await window.custard.apiKey.set(provider, key)
      setKey('')
      setError(null)
      refresh()
      onChanged()
    } catch (e) {
      setError(cleanError(e))
    }
  }

  const clear = async (): Promise<void> => {
    await window.custard.apiKey.clear(provider)
    refresh()
    onChanged()
  }

  return (
    <section className="mb-6">
      <h3 className="mb-1 text-sm font-medium">
        {providerNames[provider]} API key{' '}
        {hasKey && <span className="text-molten-300">· saved</span>}
      </h3>
      <p className="mb-3 text-sm text-ash-300">Get one at {keyInfo[provider].where}.</p>
      <div className="flex gap-2">
        <input
          type="password"
          aria-label={`${providerNames[provider]} API key`}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && key.trim() && save()}
          placeholder={hasKey ? 'Paste a new key to replace it' : keyInfo[provider].placeholder}
          className="flex-1 rounded-lg border border-forge-700 bg-forge-900 px-3 py-2 text-sm outline-none focus:border-molten-500/60"
        />
        <button onClick={save} disabled={!key.trim()} className={primary}>
          Save
        </button>
      </div>
      {error && <p className="mt-2 text-sm text-ember-600">{error}</p>}
      {hasKey && (
        <button onClick={clear} className="mt-2 text-xs text-ash-500 hover:text-ember-600">
          Remove key
        </button>
      )}
    </section>
  )
}

function MemorySection(): React.JSX.Element {
  const [settings, setSettings] = useState<MemorySettings | null>(null)
  useEffect(() => {
    window.custard.memory.getSettings().then(setSettings)
  }, [])
  return (
    <section className="mb-6">
      <h3 className="mb-1 text-sm font-medium">Memory</h3>
      <label className="flex items-start gap-2 text-sm text-ash-300">
        <input
          type="checkbox"
          className="mt-1"
          aria-label="Remember automatically"
          checked={settings?.auto ?? true}
          disabled={settings === null}
          onChange={(e) => {
            const next = { ...settings!, auto: e.target.checked }
            setSettings(next)
            window.custard.memory.setSettings(next)
          }}
        />
        <span>
          Remember automatically. After a chat where something happened (plugin actions, changes,
          tests, failures) or that went on for a while, Custard makes one short summary with your
          provider&apos;s cheapest model and saves it as a new note in Custard/Captures in your
          vault. Small talk and plain questions aren&apos;t saved, and neither are keys, passwords,
          note contents or web pages.
        </span>
      </label>
      <p className="mt-2 text-xs text-ash-400">
        Attached files are different from what you type. Custard remembers only how many files of
        which types a chat had, never their names or contents. Text you type or paste into a message
        is ordinary chat content and can be saved, even if you copied it from a file.
      </p>
      <p className="mt-2 text-xs text-ash-400">
        {settings && !settings.auto
          ? "Off: nothing new is saved, and waiting summaries are cancelled. Notes already in your vault stay until you edit them, and chats from while it was off aren't saved later."
          : "To keep one chat out, start it as a Temporary chat from the top bar; Forget in History deletes a chat's notes. You can also turn it off for a plugin in its settings. Edit or delete anything in your vault; what you delete is not added back."}
      </p>
    </section>
  )
}

function SecuritySection(): React.JSX.Element {
  const [ask, setAsk] = useState<boolean | null>(null)
  useEffect(() => {
    window.custard.security.get().then((s) => setAsk(s.askBeforeWriteTools))
  }, [])
  return (
    <section className="mb-6">
      <h3 className="mb-1 text-sm font-medium">Security</h3>
      <label className="flex items-start gap-2 text-sm text-ash-300">
        <input
          type="checkbox"
          className="mt-1"
          checked={ask ?? true}
          disabled={ask === null}
          onChange={(e) => {
            setAsk(e.target.checked)
            window.custard.security.set({ askBeforeWriteTools: e.target.checked })
          }}
        />
        <span>
          Ask before plugin actions that change things (queueing music, opening apps, sending data).
          This is the default for every plugin action; you can change single actions in Plugins.
        </span>
      </label>
    </section>
  )
}

function SettingsDialog({ onClose, onChanged }: Props): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('general')
  const [vault, setVault] = useState<VaultInfo>(null)

  useEffect(() => {
    window.custard.vault.get().then(setVault)
  }, [])

  const [vaultError, setVaultError] = useState<string | null>(null)
  const pickVault = async (): Promise<void> => setVault(await window.custard.vault.pick())
  const createStarter = async (): Promise<void> => {
    try {
      setVaultError(null)
      setVault(await window.custard.vault.createStarter())
    } catch (e) {
      setVaultError(cleanError(e))
    }
  }
  const [added, setAdded] = useState<string | null>(null)
  const addSkills = async (): Promise<void> => {
    try {
      const r = await window.custard.vault.addStarterSkills()
      setVault(r.vault)
      setAdded(
        r.added.length
          ? `Added ${r.added.join(', ')}`
          : 'Your vault already has every starter skill.'
      )
    } catch (e) {
      setVaultError(cleanError(e))
    }
  }
  const clearVault = async (): Promise<void> => {
    await window.custard.vault.clear()
    setVault(null)
  }

  return (
    <div
      className="fixed inset-0 z-10 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className={`max-h-[90vh] overflow-y-auto rounded-3xl border border-forge-700 bg-forge-850 p-6 ${tab === 'plugins' ? 'w-[820px]' : 'w-[480px]'}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-5 flex items-center gap-4">
          <h2 className="text-base font-semibold">Settings</h2>
          <div
            className="flex gap-1 rounded-full border border-forge-700 p-0.5 text-sm"
            role="tablist"
          >
            {(['general', 'design', 'plugins'] as Tab[]).map((t) => (
              <button
                key={t}
                role="tab"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
                className={`rounded-full px-3 py-1 ${tab === t ? 'bg-forge-700 text-ash-100' : 'text-ash-400 hover:text-ash-100'}`}
              >
                {t === 'general' ? 'General' : t === 'design' ? 'Design' : 'Plugins'}
              </button>
            ))}
          </div>
        </div>

        {tab === 'plugins' ? (
          <PluginsTab />
        ) : tab === 'design' ? (
          <DesignTab />
        ) : (
          <>
            <p className="mb-5 -mt-1 text-sm text-ash-400">
              Keys are encrypted with Windows secure storage and stay on this computer. Pick a model
              from either provider under the message box.
            </p>
            <KeySection provider="claude" onChanged={onChanged} />
            <KeySection provider="openai" onChanged={onChanged} />

            <section>
              <h3 className="mb-1 text-sm font-medium">
                Obsidian vault {vault && <span className="text-molten-300">· connected</span>}
              </h3>
              <p className="mb-3 text-sm text-ash-300">
                The brain behind Custard. The model can search and read your notes, create new ones
                and add to existing ones, but never overwrites or deletes anything. It keeps a
                memory of you in <code className="text-molten-200">{MEMORY_NOTE}</code>.
              </p>
              {vault ? (
                <>
                  <div className="truncate rounded-lg border border-forge-700 bg-forge-900 px-3 py-2 text-sm">
                    {vault.path}
                  </div>
                  <p className="mt-2 text-xs text-ash-500">
                    {vault.skills.length
                      ? `Skills: ${vault.skills.join(', ')}`
                      : 'No skills yet. Add them in Custard/Skills.'}
                  </p>
                  {!vault.isObsidian && (
                    <p className="mt-2 text-xs text-molten-300">
                      This folder has no .obsidian folder, so it may not be an Obsidian vault. It
                      still works as a notes folder.
                    </p>
                  )}
                  <div className="mt-3 flex gap-2">
                    <button onClick={pickVault} className={secondary}>
                      Change folder
                    </button>
                    <button
                      onClick={addSkills}
                      className={secondary}
                      title="Copies starter skills you don't have yet. Nothing is overwritten."
                    >
                      Add missing starter skills
                    </button>
                    <button
                      onClick={clearVault}
                      className="text-xs text-ash-500 hover:text-ember-600"
                    >
                      Disconnect
                    </button>
                  </div>
                </>
              ) : (
                <div className="flex gap-2">
                  <button onClick={createStarter} className={primary}>
                    Create starter vault
                  </button>
                  <button onClick={pickVault} className={secondary}>
                    Use an existing vault
                  </button>
                </div>
              )}
              {added && <p className="mt-2 text-xs text-ash-400">{added}</p>}
              {vaultError && <p className="mt-2 text-sm text-ember-600">{vaultError}</p>}
            </section>
            <div className="mt-6">
              <MemorySection />
              <SecuritySection />
            </div>
          </>
        )}

        <div className="mt-6 flex justify-end">
          <button onClick={onClose} className={secondary}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}

export default SettingsDialog
