import { useEffect, useState } from 'react'
import type { PluginStatus, Workspace } from '../../../../shared/plugins'
import { cleanError } from '../settings/ui'

// Plugins mode: the file tools can only touch the chosen plugin's folder. The
// choice is fixed once the conversation starts. (General Code, which worked
// in any folder, was removed; its old chats still show their folder.)

const chip =
  'rounded-full border px-3 py-1 text-xs transition-colors disabled:opacity-40 border-forge-700 text-ash-400 hover:text-ash-100'

const folderName = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p

function describeWorkspace(w: Workspace | undefined): string {
  if (!w) return 'No workspace: answers only, no file access'
  return w.kind === 'internal'
    ? `Plugins · plugin/${w.pluginId}`
    : `General Code (removed) · ${folderName(w.root)} · read only`
}

type Props = {
  // The workspace of the open conversation; it can't be changed.
  fixed: Workspace | undefined | null
  value: Workspace | null
  onChange: (w: Workspace | null) => void
  disabled: boolean
}

function WorkspaceBar({ fixed, value, onChange, disabled }: Props): React.JSX.Element {
  const [plugins, setPlugins] = useState<PluginStatus[]>([])
  const [creating, setCreating] = useState(false)
  const [newId, setNewId] = useState('')
  const [newName, setNewName] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    window.custard.plugins.list().then(setPlugins)
  }, [])

  if (fixed !== null)
    return (
      <div className="mb-2 px-2 text-xs text-ash-500" title="Fixed for this conversation">
        Workspace: {describeWorkspace(fixed)}
      </div>
    )

  const create = async (): Promise<void> => {
    try {
      setError(null)
      const s = await window.custard.plugins.create(newId.trim(), newName.trim())
      setPlugins(await window.custard.plugins.list())
      onChange({ kind: 'internal', pluginId: s.id })
      setCreating(false)
      setNewId('')
      setNewName('')
    } catch (e) {
      setError(cleanError(e))
    }
  }

  return (
    <div className="mb-2 px-1">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-ash-500">Plugin</span>
        <select
          aria-label="Plugin"
          disabled={disabled}
          className={`${chip} appearance-none bg-forge-900`}
          value={value?.kind === 'internal' ? value.pluginId : ''}
          onChange={(e) =>
            onChange(e.target.value ? { kind: 'internal', pluginId: e.target.value } : null)
          }
        >
          <option value="">Choose a plugin…</option>
          {plugins.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} ({p.id})
            </option>
          ))}
        </select>
        <button disabled={disabled} className={chip} onClick={() => setCreating(!creating)}>
          New plugin
        </button>
      </div>
      {creating && (
        <div className="mt-2 flex gap-2">
          <input
            aria-label="Plugin id"
            value={newId}
            onChange={(e) => setNewId(e.target.value.toLowerCase())}
            placeholder="id, e.g. seo-check"
            className="w-40 rounded-lg border border-forge-700 bg-forge-900 px-2 py-1 text-xs outline-none"
          />
          <input
            aria-label="Plugin name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Name"
            className="w-40 rounded-lg border border-forge-700 bg-forge-900 px-2 py-1 text-xs outline-none"
          />
          <button className={chip} disabled={!newId.trim()} onClick={create}>
            Create
          </button>
        </div>
      )}
      {!value && !error && (
        <p className="mt-1 text-xs text-ash-500">
          Without a plugin, the assistant answers without touching files. With one, it can only edit
          that plugin. You review and activate it in Settings → Plugins.
        </p>
      )}
      {error && <p className="mt-1 text-xs text-ember-600">{error}</p>}
    </div>
  )
}

export default WorkspaceBar
