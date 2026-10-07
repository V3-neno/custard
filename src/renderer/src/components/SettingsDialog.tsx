import { useState } from 'react'

type Props = { hasKey: boolean; onClose: () => void; onChanged: () => void }

function SettingsDialog({ hasKey, onClose, onChanged }: Props): React.JSX.Element {
  const [key, setKey] = useState('')
  const [error, setError] = useState<string | null>(null)

  const save = async (): Promise<void> => {
    try {
      await window.custard.apiKey.set(key)
      setKey('')
      onChanged()
      onClose()
    } catch (e) {
      setError(
        String(e instanceof Error ? e.message : e).replace(
          /^Error invoking remote method '[^']+': (Error: )?/,
          ''
        )
      )
    }
  }

  const clear = async (): Promise<void> => {
    await window.custard.apiKey.clear()
    onChanged()
  }

  return (
    <div
      className="fixed inset-0 z-10 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="w-[440px] rounded-2xl border border-ink-700 bg-ink-800 p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-1 text-base font-semibold">Settings</h2>
        <p className="mb-4 text-sm text-ink-300">
          Your Claude API key is encrypted with Windows secure storage and stays on this computer.
          Get one at console.anthropic.com.
        </p>
        <label className="mb-1 block text-xs text-ink-300">
          API key {hasKey && <span className="text-custard-300">(saved)</span>}
        </label>
        <input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && key.trim() && save()}
          placeholder={hasKey ? 'Paste a new key to replace it' : 'sk-ant-…'}
          className="w-full rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-sm outline-none focus:border-custard-400/60"
          autoFocus
        />
        {error && <p className="mt-2 text-sm text-red-300">{error}</p>}
        <div className="mt-5 flex items-center gap-2">
          {hasKey && (
            <button onClick={clear} className="text-sm text-ink-500 hover:text-red-300">
              Remove key
            </button>
          )}
          <button
            onClick={onClose}
            className="ml-auto rounded-lg px-3 py-1.5 text-sm text-ink-300 hover:text-custard-50"
          >
            Close
          </button>
          <button
            onClick={save}
            disabled={!key.trim()}
            className="rounded-lg bg-custard-400 px-3 py-1.5 text-sm font-medium text-ink-900 hover:bg-custard-300 disabled:opacity-40"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

export default SettingsDialog
