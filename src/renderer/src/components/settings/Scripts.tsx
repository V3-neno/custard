import { useEffect, useState } from 'react'
import {
  SCRIPT_RISK,
  type InterpreterChoice,
  type ScriptRuntime,
  type ScriptsView
} from '../../../../shared/scripts'
import { cleanError, secondary } from './ui'

// Settings → Scripts: the one switch (off by default), which Python and
// Node.js run scripts, and Stop. Scripts themselves are made and approved
// in Plugins mode.

const RUNTIMES: { id: ScriptRuntime; label: string }[] = [
  { id: 'python', label: 'Python' },
  { id: 'node', label: 'Node.js' }
]

export default function Scripts(): React.JSX.Element | null {
  const [view, setView] = useState<ScriptsView | null>(null)
  const [found, setFound] = useState<Partial<Record<ScriptRuntime, InterpreterChoice[]>>>({})
  const [busy, setBusy] = useState<ScriptRuntime | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    void window.custard.scripts.get().then(setView)
  }, [])
  if (!view) return null
  const s = view.settings

  const act = async (f: () => Promise<ScriptsView>): Promise<void> => {
    setError(null)
    try {
      setView(await f())
    } catch (e) {
      setError(cleanError(e))
    }
  }
  const find = async (runtime: ScriptRuntime): Promise<void> => {
    setError(null)
    setBusy(runtime)
    try {
      const list = await window.custard.scripts.find(runtime)
      setFound((f) => ({ ...f, [runtime]: list }))
    } catch (e) {
      setError(cleanError(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="mb-6" data-scripts>
      <h3 className="mb-1 text-sm font-medium">
        Scripts {s.enabled && <span className="text-molten-300">· on</span>}
      </h3>
      <p className="mb-3 text-sm text-ash-300">
        Python and JavaScript scripts you approve can be offered to the assistant as tools in Chat.
        It asks you before every run.
      </p>
      <p
        className="mb-3 rounded-lg border border-molten-500/40 bg-forge-900 p-3 text-xs text-molten-200"
        data-scripts-risk
      >
        {SCRIPT_RISK}
      </p>
      <label className="mb-3 flex items-start gap-2 text-sm text-ash-300">
        <input
          type="checkbox"
          className="mt-1"
          aria-label="Let the assistant run scripts"
          checked={s.enabled}
          onChange={(e) => void act(() => window.custard.scripts.setEnabled(e.target.checked))}
        />
        <span>
          Let the assistant run scripts. Turning this off stops any running script and offers none.
        </span>
      </label>

      <div className="space-y-2 rounded-lg border border-forge-700 bg-forge-900 p-3">
        {RUNTIMES.map(({ id, label }) => {
          const c = s[id]
          const list = found[id]
          return (
            <div key={id} data-interpreter={id}>
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-ash-300">{label}</p>
                  <p className="truncate text-xs text-ash-500" title={c?.path}>
                    {c ? `${c.version.join('.')} · ${c.path}` : 'Not set'}
                  </p>
                </div>
                <button
                  className={secondary}
                  disabled={busy === id}
                  onClick={() => void find(id)}
                  aria-label={`Find ${label}`}
                >
                  {busy === id ? 'Finding…' : 'Find'}
                </button>
                <button
                  className={secondary}
                  onClick={() => void act(() => window.custard.scripts.browse(id))}
                  aria-label={`Browse for ${label}`}
                >
                  Browse
                </button>
                {c && (
                  <button
                    className="text-xs text-ash-500 hover:text-ember-600"
                    onClick={() => void act(() => window.custard.scripts.clear(id))}
                    aria-label={`Clear ${label}`}
                  >
                    Clear
                  </button>
                )}
              </div>
              {list && (
                <ul className="mt-1 space-y-1">
                  {list.length === 0 && (
                    <li className="text-xs text-ash-500">
                      None found. Install {label} or use Browse.
                    </li>
                  )}
                  {list.map((f) => (
                    <li key={f.path} className="flex items-center gap-2 text-xs text-ash-400">
                      <span className="min-w-0 flex-1 truncate" title={f.path}>
                        {f.version.join('.')} · {f.path}
                      </span>
                      {c?.path === f.path ? (
                        <span className="text-molten-300">In use</span>
                      ) : (
                        <button
                          className="text-molten-300 hover:text-molten-200"
                          onClick={() =>
                            void act(async () => {
                              const v = await window.custard.scripts.use(id, f.path)
                              setFound((x) => ({ ...x, [id]: undefined }))
                              return v
                            })
                          }
                        >
                          Use
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )
        })}
        <p className="text-xs text-ash-500">
          Custard never installs or downloads an interpreter. Scripts that need packages get their
          own folder for them.
        </p>
      </div>

      {view.running.length > 0 && (
        <div className="mt-3 flex items-center gap-2 text-sm text-ash-300" data-scripts-running>
          <span className="flex-1">Running: {view.running.join(', ')}</span>
          <button
            className={secondary}
            onClick={() => void act(() => window.custard.scripts.stop())}
          >
            Stop all
          </button>
        </div>
      )}

      {view.scripts.length > 0 && (
        <ul className="mt-3 space-y-1" data-scripts-list>
          {view.scripts.map((x) => (
            <li key={x.id} className="text-xs text-ash-400">
              <span className="text-ash-300">{x.name}</span>
              {' · '}
              {x.approved ? `approved ${x.approved}` : 'not approved'}
              {x.approved && (x.enabled && x.useInChat ? ' · in Chat' : ' · not in Chat')}
              {x.problem && <span className="block text-ember-600">{x.problem}</span>}
            </li>
          ))}
        </ul>
      )}
      {error && <p className="mt-2 text-sm text-ember-600">{error}</p>}
    </section>
  )
}
