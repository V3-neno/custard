import { useCallback, useEffect, useState } from 'react'
import type { VaultEditEntry } from '../../../../shared/vault'
import { GRANT_MODES, type GrantMode, type VaultGrant } from '../../../../shared/vaultGrants'
import { cleanError, danger, input, secondary } from './ui'

// Folders Claude may change without asking about each edit, and a list of
// what it changed, with Undo. Nothing is allowed until the user adds a folder.
export default function EditableFolders(): React.JSX.Element {
  const [grants, setGrants] = useState<VaultGrant[]>([])
  const [edits, setEdits] = useState<VaultEditEntry[]>([])
  const [folder, setFolder] = useState('')
  const [mode, setMode] = useState<GrantMode>('append')
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const refresh = useCallback(() => {
    window.custard.vault.getGrants().then(setGrants)
    window.custard.vault.edits().then(setEdits)
  }, [])
  useEffect(refresh, [refresh])

  const save = async (next: VaultGrant[]): Promise<boolean> => {
    setError(null)
    try {
      const saved = await window.custard.vault.setGrants(next)
      setGrants(saved)
      return true
    } catch (e) {
      setError(cleanError(e))
      return false
    }
  }

  const add = async (): Promise<void> => {
    const f = folder
      .split(/[\\/]+/)
      .filter(Boolean)
      .join('/')
    if (!f) return
    const key = f.toLowerCase()
    setError(null)
    try {
      const others = grants.filter((g) => g.folder.toLowerCase() !== key)
      const saved = await window.custard.vault.setGrants([...others, { folder: f, mode }])
      setGrants(saved)
      // A folder the app refuses (hidden, "..", a drive) is dropped on save.
      if (saved.some((g) => g.folder.toLowerCase() === key)) setFolder('')
      else
        setError(
          "That folder can't be allowed. Use a folder inside the vault, like Projects/Notes."
        )
    } catch (e) {
      setError(cleanError(e))
    }
  }

  const undo = async (id: string): Promise<void> => {
    setNote(null)
    const r = await window.custard.vault.undoEdit(id)
    setNote(r.message)
    refresh()
  }

  return (
    <section className="mt-5">
      <h3 className="mb-1 text-sm font-medium">Editable folders</h3>
      <p className="mb-3 text-sm text-ash-300">
        Folders where Claude can change notes without asking each time. Nothing is allowed until you
        add a folder. Elsewhere, a new note still needs your approval and existing notes can&apos;t
        be changed. Custard&apos;s memory, skills, captures and plugin activity notes stay protected
        unless you add that exact folder.
      </p>
      {grants.length > 0 && (
        <ul className="mb-3 space-y-1.5" aria-label="Editable folders">
          {grants.map((g) => (
            <li
              key={g.folder}
              className="flex items-center gap-2 rounded-lg border border-forge-700 bg-forge-900 px-3 py-1.5 text-sm"
            >
              <span className="min-w-0 flex-1 truncate">{g.folder}/</span>
              <span className="text-xs text-molten-300">
                {GRANT_MODES.find((m) => m.id === g.mode)?.label}
              </span>
              <button
                aria-label={`Remove ${g.folder}`}
                onClick={() => void save(grants.filter((x) => x.folder !== g.folder))}
                className="text-xs text-ash-500 hover:text-ember-600"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <input
          aria-label="Folder to allow"
          value={folder}
          onChange={(e) => setFolder(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void add()}
          placeholder="Folder in the vault, like Projects/Notes"
          className={input}
        />
        <select
          aria-label="What Claude may do there"
          value={mode}
          onChange={(e) => setMode(e.target.value as GrantMode)}
          title={GRANT_MODES.find((m) => m.id === mode)?.help}
          className="rounded-lg border border-forge-700 bg-forge-900 px-2 text-sm outline-none"
        >
          {GRANT_MODES.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
        <button onClick={() => void add()} disabled={!folder.trim()} className={secondary}>
          Allow
        </button>
      </div>
      {error && <p className="mt-2 text-sm text-ember-600">{error}</p>}

      {edits.length > 0 && (
        <>
          <h3 className="mt-5 mb-1 text-sm font-medium">Recent changes</h3>
          <ul className="space-y-1.5" aria-label="Recent changes">
            {edits.slice(0, 10).map((e) => (
              <li
                key={e.id}
                className="rounded-lg border border-forge-700 bg-forge-900 px-3 py-1.5"
              >
                <div className="flex items-center gap-2 text-sm">
                  <span className="min-w-0 flex-1 truncate">
                    {e.kind === 'create' ? 'Created' : e.kind === 'append' ? 'Added to' : 'Edited'}{' '}
                    {e.path}
                  </span>
                  <span className="text-xs text-ash-500">
                    {new Date(e.time).toLocaleString(undefined, {
                      month: 'short',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit'
                    })}
                  </span>
                  {e.undone ? (
                    <span className="text-xs text-ash-500">Undone</span>
                  ) : (
                    e.undoable && (
                      <button
                        aria-label={`Undo change to ${e.path}`}
                        onClick={() => void undo(e.id)}
                        className={`${danger} !px-2 !py-0.5 text-xs`}
                      >
                        Undo
                      </button>
                    )
                  )}
                </div>
                {e.change && (e.change.removed || e.change.added) && (
                  <details className="mt-1 text-xs text-ash-400">
                    <summary className="cursor-pointer">What changed</summary>
                    <pre className="mt-1 max-h-40 overflow-auto font-mono break-words whitespace-pre-wrap">
                      {e.change.removed && (
                        <span className="text-ember-600">− {e.change.removed}</span>
                      )}
                      {e.change.removed && e.change.added ? '\n' : ''}
                      {e.change.added && (
                        <span className="text-molten-200">+ {e.change.added}</span>
                      )}
                      {e.change.truncated ? '\n…' : ''}
                    </pre>
                  </details>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {note && <p className="mt-2 text-sm text-ash-300">{note}</p>}
    </section>
  )
}
