import { useEffect, useState } from 'react'
import type { PluginStatus, Workspace } from '../../../../shared/plugins'
import { cleanError } from '../settings/ui'

// Code mode is split in two. Plugins: the file tools can only touch one
// plugin's folder. General Code: a project folder you pick. The choice is
// fixed once the conversation starts.

const chip =
  'rounded-full border px-3 py-1 text-xs transition-colors disabled:opacity-40 border-forge-700 text-ash-400 hover:text-ash-100'
const chipOn =
  'rounded-full border px-3 py-1 text-xs border-molten-500/60 bg-forge-800 text-molten-200'

const folderName = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p

function describeWorkspace(w: Workspace | undefined): string {
  if (!w) return 'No workspace: answers only, no file access'
  return w.kind === 'internal'
    ? `Plugins · plugin/${w.pluginId}`
    : `General Code · ${folderName(w.root)}${w.coreAccess ? ' · core access allowed' : ''}`
}

type Props = {
  // The workspace of the open conversation; it can't be changed.
  fixed: Workspace | undefined | null
  value: Workspace | null
  onChange: (w: Workspace | null) => void
  disabled: boolean
}

function WorkspaceBar({ fixed, value, onChange, disabled }: Props): React.JSX.Element {
  const [kind, setKind] = useState<'general' | 'internal'>(value?.kind ?? 'general')
  const [plugins, setPlugins] = useState<PluginStatus[]>([])
  const [creating, setCreating] = useState(false)
  const [newId, setNewId] = useState('')
  const [newName, setNewName] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (kind === 'internal') window.custard.plugins.list().then(setPlugins)
  }, [kind])

  if (fixed !== null)
    return (
      <div className="mb-2 px-2 text-xs text-ash-500" title="Fixed for this conversation">
        Workspace: {describeWorkspace(fixed)}
      </div>
    )

  const pick = async (): Promise<void> => {
    try {
      setError(null)
      const w = await window.custard.workspace.pickGeneral()
      if (w) onChange(w)
    } catch (e) {
      setError(cleanError(e))
    }
  }
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
        <span className="text-xs text-ash-500">Workspace</span>
        <button
          disabled={disabled}
          className={kind === 'general' ? chipOn : chip}
          onClick={() => {
            setKind('general')
            onChange(null)
          }}
        >
          General Code
        </button>
        <button
          disabled={disabled}
          className={kind === 'internal' ? chipOn : chip}
          onClick={() => {
            setKind('internal')
            onChange(null)
          }}
        >
          Plugins
        </button>
        <span className="text-forge-600">|</span>
        {kind === 'general' ? (
          <button
            disabled={disabled}
            className={chip}
            onClick={pick}
            title={value?.kind === 'general' ? value.root : ''}
          >
            {value?.kind === 'general'
              ? describeWorkspace(value).replace('General Code · ', '')
              : 'Choose a project folder…'}
          </button>
        ) : (
          <>
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
          </>
        )}
      </div>
      {kind === 'internal' && creating && (
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
          {kind === 'general'
            ? 'Without a folder, Code mode answers without touching files.'
            : 'The assistant can only edit the chosen plugin. You review and activate it in Settings → Plugins.'}
        </p>
      )}
      {error && <p className="mt-1 text-xs text-ember-600">{error}</p>}
    </div>
  )
}

export default WorkspaceBar
