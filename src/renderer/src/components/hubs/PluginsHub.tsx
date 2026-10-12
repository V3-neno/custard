import { useCallback, useEffect, useMemo, useState } from 'react'
import type { PluginStatus } from '../../../../shared/plugins'
import { CloseIcon, PlusIcon } from '../icons'
import { cleanError } from '../settings/ui'
import { Badge, Detail } from './PluginDetail'

// Plugins mode's start page: every plugin in plugin/, what each does and its
// state. Manage opens everything Settings → Plugins used to hold (review and
// activate, permissions, configuration, account, Chat/Design/Skills use,
// roll back, uninstall). Improve and Add pick the plugin for the next chat
// and put a request in the message box.

type Props = {
  // Picks the plugin for the next chat and puts a request in the box (not sent).
  onStart: (pluginId: string, text: string) => void
}

const chip = 'rounded-full border border-forge-700 px-2.5 py-0.5 text-[11px] text-ash-400'
const pill =
  'rounded-full border border-forge-700 bg-forge-850/80 px-3 py-1 text-xs text-ash-300 transition-colors hover:border-molten-500/50 hover:text-molten-200'
const field =
  'w-40 rounded-full border border-forge-700 bg-forge-900 px-3 py-1 text-xs outline-none focus:border-molten-500/60'

function chips(p: PluginStatus): string[] {
  const out: string[] = []
  const writes = p.tools.filter((t) => t.effect === 'write').length
  if (p.tools.length)
    out.push(
      `${p.tools.length} ${p.tools.length === 1 ? 'tool' : 'tools'}${writes ? ` · ${writes} change things` : ''}`
    )
  if (p.widgets?.length)
    out.push(p.widgets.length === 1 ? '1 widget' : `${p.widgets.length} widgets`)
  if (p.auth) out.push(p.auth.connected ? 'Account connected' : 'Account not connected')
  if (p.active)
    out.push(
      p.chatDesign === 'on'
        ? 'In Chat, Design and Skills'
        : p.chatDesign === 'changed'
          ? 'Chat use needs a new yes'
          : 'Plugins mode only'
    )
  if (p.sourceChanged && !p.sourceErrors.length)
    out.push(p.active ? 'Update ready to review' : 'Ready to review')
  return out
}

function SecurityToggle(): React.JSX.Element {
  const [ask, setAsk] = useState<boolean | null>(null)
  useEffect(() => {
    window.custard.security.get().then((s) => setAsk(s.askBeforeWriteTools))
  }, [])
  return (
    <label className="flex items-start gap-2 text-xs text-ash-400">
      <input
        type="checkbox"
        className="mt-0.5"
        checked={ask ?? true}
        disabled={ask === null}
        onChange={(e) => {
          setAsk(e.target.checked)
          window.custard.security.set({ askBeforeWriteTools: e.target.checked })
        }}
      />
      <span>
        Ask before plugin actions that change things (queueing music, opening apps, sending data).
        This is the default for every plugin action; Manage changes single actions.
      </span>
    </label>
  )
}

function PluginsHub({ onStart }: Props): React.JSX.Element {
  const [plugins, setPlugins] = useState<PluginStatus[] | null>(null)
  const [filter, setFilter] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [newId, setNewId] = useState('')
  const [newName, setNewName] = useState('')
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(
    () =>
      window.custard.plugins
        .list()
        .then(setPlugins)
        .catch((e) => setError(cleanError(e))),
    []
  )
  useEffect(() => {
    void load()
  }, [load])

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!plugins || !q) return plugins ?? []
    return plugins.filter((p) =>
      [p.name, p.id, p.description].some((x) => x.toLowerCase().includes(q))
    )
  }, [plugins, filter])

  const replace = (s: PluginStatus): void =>
    setPlugins((list) => (list ?? []).map((x) => (x.id === s.id ? s : x)))

  const create = async (): Promise<void> => {
    try {
      setError(null)
      const s = await window.custard.plugins.create(newId.trim(), newName.trim())
      setAdding(false)
      setNewId('')
      setNewName('')
      onStart(s.id, `Build the new ${s.name} plugin: `)
    } catch (e) {
      setError(cleanError(e))
    }
  }

  const improve = (p: PluginStatus): void => {
    setOpen(null)
    onStart(p.id, `Improve the ${p.name} plugin (plugin/${p.id}). `)
  }
  const current = plugins?.find((p) => p.id === open)

  return (
    <div className="mx-auto w-full max-w-4xl px-6 pt-8 pb-6">
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <div>
          <div className="text-xs tracking-[0.2em] text-ash-500 uppercase">Plugins</div>
          <h1 className="text-2xl font-semibold tracking-tight text-molten-200">
            What Custard can reach
          </h1>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <input
            aria-label="Find a plugin"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Find a plugin…"
            className={`${field} w-44`}
          />
          <button
            onClick={() => setAdding(!adding)}
            className="molten-fill flex items-center gap-1.5 rounded-full px-3.5 py-1 text-xs font-medium text-forge-950"
          >
            <PlusIcon className="h-3.5 w-3.5" /> Add a plugin
          </button>
        </div>
      </div>
      {adding && (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-2xl border border-forge-700 bg-forge-850/60 p-3">
          <input
            aria-label="New plugin id"
            value={newId}
            onChange={(e) => setNewId(e.target.value.toLowerCase())}
            placeholder="id, e.g. seo-check"
            className={field}
          />
          <input
            aria-label="New plugin name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Name"
            className={field}
          />
          <button className={pill} disabled={!newId.trim()} onClick={create}>
            Create and start
          </button>
          <span className="text-xs text-ash-500">
            Custard writes plugin/{newId.trim() || '<id>'} with a working sample to build on.
          </span>
        </div>
      )}
      <div className="mb-5">
        <SecurityToggle />
      </div>
      {error && <p className="mb-3 text-xs text-ember-600">{error}</p>}
      {plugins === null ? null : plugins.length === 0 ? (
        <p className="py-10 text-center text-sm text-ash-500">No plugins yet. Add one.</p>
      ) : shown.length === 0 ? (
        <p className="py-10 text-center text-sm text-ash-500">No plugin matches that.</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {shown.map((p) => (
            <article
              key={p.id}
              aria-label={`Plugin ${p.name}`}
              className="flex flex-col rounded-2xl border border-forge-700 bg-forge-850/60 p-4 transition-colors hover:border-molten-500/40"
            >
              <div className="flex items-baseline gap-2">
                <button
                  onClick={() => setOpen(p.id)}
                  className="truncate text-left font-medium text-ash-100 hover:text-molten-200"
                >
                  {p.name}
                </button>
                {p.active && <span className="text-xs text-ash-500">v{p.active.version}</span>}
                <span className="ml-auto shrink-0">
                  <Badge p={p} />
                </span>
              </div>
              <p className="mt-1 line-clamp-3 text-sm text-ash-400">{p.description}</p>
              {p.sourceErrors.length > 0 && (
                <p className="mt-1 text-xs text-ember-600">
                  {p.sourceErrors.length === 1
                    ? '1 problem in the source'
                    : `${p.sourceErrors.length} problems in the source`}
                </p>
              )}
              <div className="mt-3 flex flex-wrap gap-1.5">
                {chips(p).map((c) => (
                  <span key={c} className={chip}>
                    {c}
                  </span>
                ))}
              </div>
              <div className="mt-auto flex gap-2 pt-4">
                <button className={pill} onClick={() => setOpen(p.id)}>
                  Manage
                </button>
                <button className={pill} onClick={() => improve(p)}>
                  Improve
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
      {current && (
        <div
          className="fixed inset-0 z-20 flex justify-end"
          onClick={() => {
            setOpen(null)
            void load()
          }}
        >
          <div className="absolute inset-0 bg-black/50" />
          <aside
            role="dialog"
            aria-label={`Manage ${current.name}`}
            className="relative flex h-full w-full max-w-2xl flex-col border-l border-forge-700 bg-forge-900/95 backdrop-blur"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center px-6 pt-5 pb-3">
              <div className="text-xs tracking-[0.2em] text-ash-500 uppercase">Plugin</div>
              <button
                onClick={() => {
                  setOpen(null)
                  void load()
                }}
                aria-label="Close"
                className="ml-auto rounded-full p-2 text-ash-400 hover:bg-forge-800 hover:text-molten-300"
              >
                <CloseIcon />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-6 pb-6">
              <Detail key={current.id} p={current} onChange={replace} />
            </div>
            <div className="flex gap-2 border-t border-forge-700 px-6 py-3">
              <button
                onClick={() => improve(current)}
                className="molten-fill rounded-full px-4 py-1.5 text-xs font-medium text-forge-950"
              >
                Improve this plugin
              </button>
              <button
                onClick={() => void load()}
                className={pill}
                title="Read plugin/ again, for changes made outside this window"
              >
                Refresh
              </button>
              <button
                onClick={() => {
                  setOpen(null)
                  void load()
                }}
                className={`${pill} ml-auto`}
              >
                Done
              </button>
            </div>
          </aside>
        </div>
      )}
    </div>
  )
}

export default PluginsHub
