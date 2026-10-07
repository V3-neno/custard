import { useEffect, useState } from 'react'
import { MEMORY_NOTE, type VaultInfo } from '../../../shared/vault'

type Props = { hasKey: boolean; onClose: () => void; onChanged: () => void }

const cleanError = (e: unknown): string =>
  String(e instanceof Error ? e.message : e).replace(
    /^Error invoking remote method '[^']+': (Error: )?/,
    ''
  )

function SettingsDialog({ hasKey, onClose, onChanged }: Props): React.JSX.Element {
  const [key, setKey] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [vault, setVault] = useState<VaultInfo>(null)

  useEffect(() => {
    window.custard.vault.get().then(setVault)
  }, [])

  const saveKey = async (): Promise<void> => {
    try {
      await window.custard.apiKey.set(key)
      setKey('')
      setError(null)
      onChanged()
    } catch (e) {
      setError(cleanError(e))
    }
  }

  const clearKey = async (): Promise<void> => {
    await window.custard.apiKey.clear()
    onChanged()
  }

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
  const clearVault = async (): Promise<void> => {
    await window.custard.vault.clear()
    setVault(null)
  }

  const button = 'rounded-lg px-3 py-1.5 text-sm font-medium disabled:opacity-40'
  const primary = `${button} bg-custard-400 text-ink-900 hover:bg-custard-300`
  const secondary = `${button} border border-ink-700 text-ink-300 hover:text-custard-50`

  return (
    <div
      className="fixed inset-0 z-10 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="w-[480px] rounded-2xl border border-ink-700 bg-ink-800 p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-5 text-base font-semibold">Settings</h2>

        <section className="mb-6">
          <h3 className="mb-1 text-sm font-medium">
            Claude API key {hasKey && <span className="text-custard-300">· saved</span>}
          </h3>
          <p className="mb-3 text-sm text-ink-300">
            Encrypted with Windows secure storage and kept on this computer. Get one at
            console.anthropic.com.
          </p>
          <div className="flex gap-2">
            <input
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && key.trim() && saveKey()}
              placeholder={hasKey ? 'Paste a new key to replace it' : 'sk-ant-…'}
              className="flex-1 rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-sm outline-none focus:border-custard-400/60"
              autoFocus={!hasKey}
            />
            <button onClick={saveKey} disabled={!key.trim()} className={primary}>
              Save
            </button>
          </div>
          {error && <p className="mt-2 text-sm text-red-300">{error}</p>}
          {hasKey && (
            <button onClick={clearKey} className="mt-2 text-xs text-ink-500 hover:text-red-300">
              Remove key
            </button>
          )}
        </section>

        <section>
          <h3 className="mb-1 text-sm font-medium">
            Obsidian vault {vault && <span className="text-custard-300">· connected</span>}
          </h3>
          <p className="mb-3 text-sm text-ink-300">
            The brain behind Custard. Claude can search and read your notes, create new ones and add
            to existing ones, but never overwrites or deletes anything. It keeps its memory of you
            in <code className="text-custard-100">{MEMORY_NOTE}</code>.
          </p>
          {vault ? (
            <>
              <div className="truncate rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-sm">
                {vault.path}
              </div>
              <p className="mt-2 text-xs text-ink-500">
                {vault.skills.length
                  ? `Skills: ${vault.skills.join(', ')}`
                  : 'No skills yet. Add them in Custard/Skills.'}
              </p>
              {!vault.isObsidian && (
                <p className="mt-2 text-xs text-custard-300">
                  This folder has no .obsidian folder, so it may not be an Obsidian vault. It still
                  works as a notes folder.
                </p>
              )}
              <div className="mt-3 flex gap-2">
                <button onClick={pickVault} className={secondary}>
                  Change folder
                </button>
                <button onClick={clearVault} className="text-xs text-ink-500 hover:text-red-300">
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
          {vaultError && <p className="mt-2 text-sm text-red-300">{vaultError}</p>}
        </section>

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
