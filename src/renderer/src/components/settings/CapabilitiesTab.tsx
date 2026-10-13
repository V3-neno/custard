import { useCallback, useEffect, useState } from 'react'
import { capabilities, capabilityLabels, type Capability } from '../../../../shared/adapter'
import type { Provider } from '../../../../shared/providers'
import type {
  CapabilityScan,
  InventoryCategory,
  MatrixCell,
  MatrixColumn,
  Recommendation
} from '../../../../shared/capabilityScan'
import { cleanError, secondary } from './ui'

// Settings → Capabilities: what each provider can do, read from Custard's own
// rules (the same ones a chat's request is built from), what Custard can use,
// and which installed plugin could fill a gap. Opening the tab and Refresh
// scan local files only; nothing here asks a provider or a model, and nothing
// here turns a plugin on.

const MARK: Record<MatrixCell['state'], string> = {
  supported: '✓',
  unsupported: '✕',
  unknown: '?'
}

const TONE: Record<MatrixCell['state'], string> = {
  supported: 'bg-patina-800 text-patina-300',
  unsupported: 'bg-ember-700/40 text-ember-600',
  unknown: 'bg-forge-700 text-ash-400'
}

const STATE_WORD: Record<MatrixCell['state'], string> = {
  supported: 'supported',
  unsupported: 'not supported',
  unknown: 'unknown'
}

const CATEGORIES: { id: InventoryCategory; label: string }[] = [
  { id: 'vault', label: 'Vault tools' },
  { id: 'chats', label: 'Earlier-chat tools' },
  { id: 'web', label: 'Web tools' },
  { id: 'plugin', label: 'Plugin tools' },
  { id: 'skill', label: 'Skills' },
  { id: 'feature', label: 'Custard features' }
]

function Cell({
  column,
  cap,
  showNote
}: {
  column: MatrixColumn
  cap: (typeof capabilities)[number]
  showNote: boolean
}): React.JSX.Element {
  const c = column.cells[cap]
  return (
    <td
      className="px-1 py-1 align-top"
      data-cell={`${column.id}:${cap}`}
      data-state={c.state}
      data-evidence={c.evidence}
      title={`${column.label}: ${STATE_WORD[c.state]} (${c.evidence})${c.note ? `. ${c.note}` : ''}`}
    >
      <div className={`flex items-center gap-1 ${showNote ? '' : 'flex-col items-start'}`}>
        <span
          className={`inline-flex h-5 w-5 items-center justify-center rounded-md text-xs ${TONE[c.state]}`}
          aria-label={STATE_WORD[c.state]}
        >
          {MARK[c.state]}
        </span>
        <span
          className={`rounded px-1 text-[10px] uppercase tracking-wide ${
            c.evidence === 'live'
              ? 'border border-molten-500/60 text-molten-300'
              : 'border border-forge-600 text-ash-500'
          }`}
        >
          {c.evidence}
        </span>
      </div>
      {showNote && c.note && (
        <p className="mt-0.5 text-[11px] leading-snug text-ash-500">{c.note}</p>
      )}
    </td>
  )
}

type Props = {
  // Start building: makes a plugin for the gap and opens its workspace.
  onBuild: (provider: Provider, capability: Capability) => Promise<void>
}

function CapabilitiesTab({ onBuild }: Props): React.JSX.Element {
  const [scan, setScan] = useState<CapabilityScan | null>(null)
  const [building, setBuilding] = useState<string | null>(null)
  const [buildError, setBuildError] = useState<{ id: string; error: string } | null>(null)
  const build = async (r: Recommendation): Promise<void> => {
    const id = `${r.provider}:${r.capability}`
    setBuilding(id)
    setBuildError(null)
    try {
      await onBuild(r.provider, r.capability)
    } catch (e) {
      setBuildError({ id, error: cleanError(e) })
    } finally {
      setBuilding(null)
    }
  }
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<'provider' | 'model'>('provider')

  const load = useCallback(async () => {
    setBusy(true)
    try {
      setScan(await window.custard.capabilities.scan())
      setError(null)
    } catch (e) {
      setError(cleanError(e))
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
  }, [load])

  const columns = scan ? (view === 'provider' ? scan.providers : scan.models) : []

  return (
    <div data-capabilities>
      <p className="mb-3 -mt-1 text-sm text-ash-400">
        What each provider can do in Custard, from Custard&apos;s own rules: the same ones that
        decide what a chat sends. <span className="text-ash-300">docs</span> means from the
        provider&apos;s documentation and those rules; <span className="text-molten-300">live</span>{' '}
        means seen working in a real test. Nothing here asks a provider or a model.
      </p>

      <div className="mb-3 flex items-center gap-2">
        <div className="flex gap-1 rounded-full border border-forge-700 p-0.5 text-xs">
          {(['provider', 'model'] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              aria-pressed={view === v}
              className={`rounded-full px-2.5 py-0.5 ${view === v ? 'bg-forge-700 text-ash-100' : 'text-ash-400 hover:text-ash-100'}`}
            >
              {v === 'provider' ? 'By provider' : 'By model'}
            </button>
          ))}
        </div>
        <button onClick={load} disabled={busy} className={`${secondary} ml-auto`}>
          {busy ? 'Scanning…' : 'Refresh'}
        </button>
      </div>
      {scan && (
        <p className="mb-2 text-xs text-ash-500" data-scanned>
          Scanned {new Date(scan.scannedAt).toLocaleString()} from this computer&apos;s rules,
          plugins and vault.
        </p>
      )}
      {error && <p className="mb-2 text-sm text-ember-600">{error}</p>}

      {scan && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-matrix={view}>
            <thead>
              <tr className="text-left text-xs text-ash-400">
                <th className="py-1 pr-2 font-medium">Capability</th>
                {columns.map((c) => (
                  <th
                    key={c.id}
                    className={`px-1 py-1 font-medium ${c.kind === 'discovered' ? 'text-ash-500' : ''}`}
                    title={
                      c.kind === 'discovered' ? 'Listed by the provider; not yet supported' : ''
                    }
                  >
                    {c.label}
                    {c.kind === 'discovered' && (
                      <span className="block text-[10px]">not yet supported</span>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {capabilities.map((cap) => (
                <tr key={cap} className="border-t border-forge-700/60" data-row={cap}>
                  <td className="py-1 pr-2 align-top text-ash-300">{capabilityLabels[cap]}</td>
                  {columns.map((c) => (
                    <Cell key={c.id} column={c} cap={cap} showNote={view === 'provider'} />
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 flex flex-wrap gap-3 text-xs text-ash-500">
            <span>
              <span className="text-patina-300">✓</span> supported
            </span>
            <span>
              <span className="text-ember-600">✕</span> not supported
            </span>
            <span>? unknown (a model Custard has no rules for yet)</span>
          </p>
        </div>
      )}

      {scan && (
        <section className="mt-5">
          <h3 className="mb-1 text-sm font-medium">Gaps and plugins</h3>
          <p className="mb-2 text-xs text-ash-500">
            Recommendations only. Custard never turns a plugin on by itself. Start building makes a
            new plugin in Plugins mode, with a first message about the gap for you to check and
            send.
          </p>
          <ul className="space-y-1.5 text-sm">
            {scan.recommendations.map((r) => (
              <li
                key={`${r.provider}:${r.capability}`}
                data-recommendation={`${r.provider}:${r.capability}`}
                className={r.plugin ? 'text-molten-200' : 'text-ash-300'}
              >
                {r.text}
                {r.affects.length > 0 && (
                  <span className="block text-xs text-ash-500">
                    Affects: {r.affects.join(', ')}
                  </span>
                )}
                {!r.plugin && (
                  <button
                    onClick={() => build(r)}
                    disabled={building !== null}
                    title={`Make a new plugin for this gap and open it in Plugins mode`}
                    className="mt-1 block rounded-full border border-forge-700 px-2.5 py-0.5 text-xs text-ash-300 hover:text-molten-200 disabled:opacity-40"
                  >
                    {building === `${r.provider}:${r.capability}` ? 'Starting…' : 'Start building'}
                  </button>
                )}
                {buildError?.id === `${r.provider}:${r.capability}` && (
                  <span className="block text-xs text-ember-600">{buildError.error}</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {scan && (
        <details className="mt-5" data-inventory>
          <summary className="cursor-pointer text-sm font-medium">
            What Custard can use ({scan.inventory.length})
          </summary>
          {CATEGORIES.map(({ id, label }) => {
            const items = scan.inventory.filter((i) => i.category === id)
            if (!items.length) return null
            return (
              <div key={id} className="mt-2" data-inventory-category={id}>
                <h4 className="text-xs text-ash-400">
                  {label} ({items.length})
                </h4>
                <ul className="text-xs text-ash-300">
                  {items.map((i) => (
                    <li key={i.id} data-item={i.id}>
                      {i.tool ? <code className="text-molten-200">{i.tool}</code> : i.name}
                      <span className="text-ash-500">
                        {' '}
                        · {i.provider}
                        {i.state && i.state !== 'enabled' ? ` (${i.state.replace('-', ' ')})` : ''}
                        {i.uses?.length ? ` · uses ${i.uses.join(', ')}` : ''}
                        {i.category === 'feature'
                          ? ` · needs ${i.needs.map((n) => capabilityLabels[n]).join(', ')}`
                          : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )
          })}
        </details>
      )}
    </div>
  )
}

export default CapabilitiesTab
