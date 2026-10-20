import { useCallback, useEffect, useState } from 'react'
import type { VaultEditEntry } from '../../../../shared/vault'
import {
  cleanFolderInput,
  folderKey,
  GRANT_MODES,
  isEventLogPlace,
  type GrantMode,
  type VaultGrant
} from '../../../../shared/vaultGrants'
import { cleanError, danger, input, secondary } from './ui'

const DEFAULT_MODE: GrantMode = 'append'

// One level out of three that nest, as the row of pill buttons the automation
// effort picker uses, with what the picked level allows written under it.
function LevelPicker({
  value,
  onPick,
  label
}: {
  value: GrantMode
  onPick: (mode: GrantMode) => void
  label: string
}): React.JSX.Element {
  return (
    <div>
      <div role="group" aria-label={label} className="flex gap-1">
        {GRANT_MODES.map((m) => {
          const on = m.id === value
          return (
            <button
              key={m.id}
              type="button"
              aria-pressed={on}
              data-mode={m.id}
              onClick={() => !on && onPick(m.id)}
              className={`focus-ring flex-1 rounded-full border px-1.5 py-1 text-xs ${
                on
                  ? 'border-molten-500/60 text-molten-200'
                  : 'border-forge-700 text-ash-300 hover:text-molten-200'
              }`}
            >
              {m.label}
            </button>
          )
        })}
      </div>
      <p className="mt-1 text-xs text-ash-500" data-mode-help>
        {GRANT_MODES.find((m) => m.id === value)?.help}
      </p>
    </div>
  )
}

// Folders Claude may change without asking about each edit, and a list of
// what it changed, with Undo. Nothing is allowed until the user adds a folder.
export default function EditableFolders(): React.JSX.Element {
  const [grants, setGrants] = useState<VaultGrant[]>([])
  const [edits, setEdits] = useState<VaultEditEntry[]>([])
  const [folder, setFolder] = useState('')
  const [mode, setMode] = useState<GrantMode>(DEFAULT_MODE)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  // Plugins writing an event log, which these grants don't cover (shown so
  // every place written without asking is listed here).
  const [logs, setLogs] = useState<{ name: string; folder: string }[]>([])

  const refresh = useCallback(() => {
    window.custard.vault.getGrants().then(setGrants)
    window.custard.vault.edits().then(setEdits)
    window.custard.plugins
      .list()
      .then((list) =>
        setLogs(
          list.flatMap((p) =>
            p.events?.on
              ? [{ name: p.name, folder: p.events.folder ?? `Custard/Plugins/${p.name}/Events` }]
              : []
          )
        )
      )
      .catch(() => setLogs([]))
  }, [])
  useEffect(refresh, [refresh])
  // An automation's run adds to the list.
  useEffect(() => window.custard.automations.onChanged(refresh), [refresh])

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
    const f = cleanFolderInput(folder)
    if (!f) return
    if (isEventLogPlace(f)) {
      setError(
        "A plugin's event log can't be allowed: only Custard adds to it, so it stays a record of what really happened. Turn a log on or off in the plugin's Manage panel."
      )
      setMode(DEFAULT_MODE)
      return
    }
    // Compared the way the saved list keeps one entry per folder.
    const key = folderKey(f)
    setError(null)
    try {
      const others = grants.filter((g) => folderKey(g.folder) !== key)
      const saved = await window.custard.vault.setGrants([...others, { folder: f, mode }])
      setGrants(saved)
      // A folder the app refuses (hidden, "..", a drive) is dropped on save.
      if (saved.some((g) => folderKey(g.folder) === key)) setFolder('')
      else
        setError(
          "That folder can't be allowed. Use a folder inside the vault, like Projects/Notes."
        )
    } catch (e) {
      setError(cleanError(e))
    }
    // Accepted or refused, the next folder starts from the default level, so
    // a wider level picked for one folder isn't carried to another.
    setMode(DEFAULT_MODE)
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
        be changed. The levels nest: Add to end includes New notes, and Edit text includes both.
      </p>
      <p className="mb-3 text-xs text-ash-500" data-protected-help>
        Always protected, even inside an allowed folder: Custard/Memory.md, Custard/Skills,
        Custard/Captures, Custard/Chats, and each plugin&apos;s Activity folder and Overview.md
        under Custard/Plugins. Skills, Captures, Chats or an Activity folder can be allowed only by
        adding that exact folder. Memory.md and Overview.md are notes, so no folder can allow them.
        A plugin&apos;s Events folder can&apos;t be allowed at all.
      </p>
      {grants.length > 0 && (
        <ul className="mb-3 space-y-1.5" aria-label="Editable folders">
          {grants.map((g) => (
            <li
              key={g.folder}
              data-folder={g.folder}
              className="rounded-lg border border-forge-700 bg-forge-900 px-3 py-1.5 text-sm"
            >
              <div className="mb-1.5 flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate">{g.folder}/</span>
                <button
                  aria-label={`Remove ${g.folder}`}
                  onClick={() => void save(grants.filter((x) => x.folder !== g.folder))}
                  className="text-xs text-ash-500 hover:text-ember-600"
                >
                  Remove
                </button>
              </div>
              <LevelPicker
                label={`What Claude may do in ${g.folder}`}
                value={g.mode}
                onPick={(m) =>
                  void save(grants.map((x) => (x.folder === g.folder ? { ...x, mode: m } : x)))
                }
              />
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
        <button onClick={() => void add()} disabled={!folder.trim()} className={secondary}>
          Allow
        </button>
      </div>
      <div className="mt-2">
        <LevelPicker label="What Claude may do there" value={mode} onPick={setMode} />
      </div>
      {error && <p className="mt-2 text-sm text-ember-600">{error}</p>}

      {logs.length > 0 && (
        <ul className="mt-3 space-y-1 text-xs text-ash-400" aria-label="Plugin event logs">
          {logs.map((l) => (
            <li key={l.folder} className="flex items-center gap-1.5">
              <span
                aria-hidden
                className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-molten-400"
              />
              <span>
                {l.name} adds to its event log in {l.folder}/ (add only; Claude can&apos;t change
                it). Turn it off in the plugin&apos;s Manage panel.
              </span>
            </li>
          ))}
        </ul>
      )}

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
                    {e.source.startsWith('automation') && (
                      <span className="text-xs text-ash-500"> (automation)</span>
                    )}
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
