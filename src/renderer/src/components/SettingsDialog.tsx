import { useCallback, useEffect, useState } from 'react'
import { providerNames, type Provider } from '../../../shared/chat'
import { SPOTIFY_REDIRECT_URI, type SpotifyStatus } from '../../../shared/spotify'
import { MEMORY_NOTE, type VaultInfo } from '../../../shared/vault'

type Props = { onClose: () => void; onChanged: () => void }

const cleanError = (e: unknown): string =>
  String(e instanceof Error ? e.message : e).replace(
    /^Error invoking remote method '[^']+': (Error: )?/,
    ''
  )

const button = 'rounded-lg px-3 py-1.5 text-sm font-medium disabled:opacity-40'
const primary = `${button} molten-fill text-forge-950`
const secondary = `${button} border border-forge-700 text-ash-300 hover:text-molten-200`

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

function SpotifySection(): React.JSX.Element {
  const [status, setStatus] = useState<SpotifyStatus | null>(null)
  const [clientId, setClientId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    window.custard.spotify.status().then((s) => {
      setStatus(s)
      setClientId(s.clientId ?? '')
    })
  }, [])

  const run = async (action: () => Promise<SpotifyStatus>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      setStatus(await action())
    } catch (e) {
      setError(cleanError(e))
    } finally {
      setBusy(false)
    }
  }

  const savedId = status?.clientId ?? ''
  return (
    <section className="mb-6">
      <h3 className="mb-1 text-sm font-medium">
        Spotify{' '}
        {status?.connected && (
          <span className="text-molten-300">
            · connected{status.user ? ` as ${status.user}` : ''}
          </span>
        )}
      </h3>
      <p className="mb-3 text-sm text-ash-300">
        Lets the model search Spotify, see what is playing and add songs to your queue. Create an
        app at developer.spotify.com, add{' '}
        <code className="text-molten-200 select-all">{SPOTIFY_REDIRECT_URI}</code> as its Redirect
        URI, and paste its Client ID here. Needs Spotify Premium.
      </p>
      <div className="flex gap-2">
        <input
          aria-label="Spotify Client ID"
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          placeholder="Client ID"
          className="flex-1 rounded-lg border border-forge-700 bg-forge-900 px-3 py-2 font-mono text-xs outline-none focus:border-molten-500/60"
        />
        {clientId.trim() !== savedId ? (
          <button
            onClick={() => run(() => window.custard.spotify.setClientId(clientId))}
            disabled={busy}
            className={primary}
          >
            Save
          </button>
        ) : status?.connected ? (
          <button
            onClick={() => run(() => window.custard.spotify.disconnect())}
            disabled={busy}
            className={secondary}
          >
            Disconnect
          </button>
        ) : (
          <button
            onClick={() => run(() => window.custard.spotify.connect())}
            disabled={busy || !savedId}
            className={primary}
          >
            {busy ? 'Waiting for Spotify…' : 'Connect'}
          </button>
        )}
      </div>
      {busy && (
        <p className="mt-2 text-xs text-ash-500">
          Approve access in the browser window that opened, then come back here.
        </p>
      )}
      {error && <p className="mt-2 text-sm text-ember-600">{error}</p>}
    </section>
  )
}

function SettingsDialog({ onClose, onChanged }: Props): React.JSX.Element {
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
        className="max-h-[90vh] w-[480px] overflow-y-auto rounded-3xl border border-forge-700 bg-forge-850 p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-5 text-base font-semibold">Settings</h2>

        <p className="mb-5 -mt-3 text-sm text-ash-400">
          Keys are encrypted with Windows secure storage and stay on this computer. Pick a model
          from either provider under the message box.
        </p>
        <KeySection provider="claude" onChanged={onChanged} />
        <KeySection provider="openai" onChanged={onChanged} />
        <SpotifySection />

        <section>
          <h3 className="mb-1 text-sm font-medium">
            Obsidian vault {vault && <span className="text-molten-300">· connected</span>}
          </h3>
          <p className="mb-3 text-sm text-ash-300">
            The brain behind Custard. The model can search and read your notes, create new ones and
            add to existing ones, but never overwrites or deletes anything. It keeps a memory of you
            in <code className="text-molten-200">{MEMORY_NOTE}</code>.
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
                  This folder has no .obsidian folder, so it may not be an Obsidian vault. It still
                  works as a notes folder.
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
                <button onClick={clearVault} className="text-xs text-ash-500 hover:text-ember-600">
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
