import { useCallback, useEffect, useMemo, useState } from 'react'
import { pluginIdFrom, type PluginStatus } from '../../../../shared/plugins'
import { PlusIcon } from '../icons'
import { cleanError } from '../settings/ui'
import ManagePanel from './ManagePanel'
import { Badge } from './PluginDetail'

// Plugins mode's start page: every plugin in plugin/, what each does and its
// state. Pressing a card enters that plugin's workspace (its chats, and new
// chats that can edit it). Manage opens everything Settings → Plugins used to
// hold (review and activate, permissions, configuration, account,
// Chat/Design/Skills use, roll back, uninstall). Add asks for a name, makes
// the plugin and enters its workspace.

type Props = {
  onEnter: (pluginId: string) => void
}

const chip = 'rounded-full border border-forge-700 px-2.5 py-0.5 text-[11px] text-ash-400'
const pill =
  'rounded-full border border-forge-700 bg-forge-850/80 px-3 py-1 text-xs text-ash-300 transition-colors hover:border-molten-500/50 hover:text-molten-200'
const field =
  'w-48 rounded-full border border-forge-700 bg-forge-900 px-3 py-1 text-xs outline-none focus:border-molten-500/60'

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

function PluginsHub({ onEnter }: Props): React.JSX.Element {
  const [plugins, setPlugins] = useState<PluginStatus[] | null>(null)
  const [filter, setFilter] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
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

  // The folder Custard will make, shown while typing (the main process makes
  // the same id, numbered if a folder appeared meanwhile).
  const newId = pluginIdFrom(newName, new Set((plugins ?? []).map((p) => p.id)))

  const create = async (): Promise<void> => {
    try {
      setError(null)
      const s = await window.custard.plugins.create(newName.trim())
      setAdding(false)
      setNewName('')
      onEnter(s.id)
    } catch (e) {
      setError(cleanError(e))
    }
  }

  const close = (): void => {
    setOpen(null)
    void load()
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
        <form
          className="mb-4 flex flex-wrap items-center gap-2 rounded-2xl border border-forge-700 bg-forge-850/60 p-3"
          onSubmit={(e) => {
            e.preventDefault()
            if (newId) void create()
          }}
        >
          <input
            aria-label="New plugin name"
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Name, e.g. SEO Check"
            className={field}
          />
          <button type="submit" className={pill} disabled={!newId}>
            Create and open
          </button>
          <span className="text-xs text-ash-500" data-new-plugin-folder>
            {newId
              ? `Custard makes plugin/${newId} with a working sample to build on. The folder name stays; the name can change later.`
              : newName.trim()
                ? 'Use at least one letter from a to z: Custard makes the folder name from it.'
                : 'Custard makes a folder for it from the name, with a working sample to build on.'}
          </span>
        </form>
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
              className="group relative flex flex-col rounded-2xl border border-forge-700 bg-forge-850/60 p-4 transition-colors hover:border-molten-500/40"
            >
              {/* The whole card enters the workspace; Manage sits above it. */}
              <button
                onClick={() => onEnter(p.id)}
                aria-label={`Open ${p.name}`}
                className="absolute inset-0 rounded-2xl focus:outline-none focus-visible:ring-1 focus-visible:ring-molten-500/60"
              />
              <div className="pointer-events-none flex items-baseline gap-2">
                <span className="truncate font-medium text-ash-100 group-hover:text-molten-200">
                  {p.name}
                </span>
                {p.active && <span className="text-xs text-ash-500">v{p.active.version}</span>}
                <span className="ml-auto shrink-0">
                  <Badge p={p} />
                </span>
              </div>
              <p className="pointer-events-none mt-1 line-clamp-3 text-sm text-ash-400">
                {p.description}
              </p>
              {p.sourceErrors.length > 0 && (
                <p className="pointer-events-none mt-1 text-xs text-ember-600">
                  {p.sourceErrors.length === 1
                    ? '1 problem in the source'
                    : `${p.sourceErrors.length} problems in the source`}
                </p>
              )}
              <div className="pointer-events-none mt-3 flex flex-wrap gap-1.5">
                {chips(p).map((c) => (
                  <span key={c} className={chip}>
                    {c}
                  </span>
                ))}
              </div>
              <div className="pointer-events-none mt-auto flex items-center gap-2 pt-4">
                <button
                  className={`${pill} pointer-events-auto relative`}
                  onClick={() => setOpen(p.id)}
                >
                  Manage
                </button>
                <span className="ml-auto text-xs text-ash-500 group-hover:text-molten-300">
                  Open workspace ›
                </span>
              </div>
            </article>
          ))}
        </div>
      )}
      {current && (
        <ManagePanel
          plugin={current}
          onChange={replace}
          onRefresh={() => void load()}
          onClose={close}
          onEnter={() => {
            setOpen(null)
            onEnter(current.id)
          }}
        />
      )}
    </div>
  )
}

export default PluginsHub
