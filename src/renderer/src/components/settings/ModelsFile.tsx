import { useEffect, useState } from 'react'
import { setProfiles, type ModelsFileReport } from '../../../../shared/models'
import { providerNames } from '../../../../shared/providers'
import { cleanError } from './ui'

// Settings → Models file: models.json in Custard's data folder, which can add
// models for Claude, OpenAI and DeepSeek or change built-in ones (see
// main/modelsFile.ts). Custard reads it at startup and on Reload, never in
// the background. Lists what loaded and what didn't, with the reason.

const efforts = 'low, medium, high, xhigh, max'

function ModelsFile({ onReloaded }: { onReloaded: () => void }): React.JSX.Element {
  const [report, setReport] = useState<ModelsFileReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reloaded, setReloaded] = useState(false)
  useEffect(() => {
    window.custard.models.file().then(setReport)
  }, [])
  const reload = async (): Promise<void> => {
    setError(null)
    setReloaded(false)
    try {
      const r = await window.custard.models.reload()
      if (!r.ok) return setError(r.error)
      setProfiles(r.profiles)
      setReport(r.report)
      setReloaded(true)
      onReloaded()
    } catch (e) {
      setError(cleanError(e))
    }
  }
  if (!report) return <section className="mb-6" />
  const status =
    report.status === 'missing'
      ? 'No models file yet. Custard offers its built-in models.'
      : report.status === 'empty'
        ? 'The file is empty. Custard offers its built-in models.'
        : report.status === 'error'
          ? `The file can't be used, so none of its models are loaded: ${report.error} The built-in models are unaffected.`
          : `${report.loaded.length} loaded, ${report.rejected.length} not loaded.`
  return (
    <section className="mb-6" data-models-file={report.status}>
      <h3 className="mb-1 text-sm font-medium">Models file</h3>
      <p className="mb-3 text-sm text-ash-300">
        Add models for Claude, OpenAI or DeepSeek, or change a built-in one, in models.json. They
        use that provider&apos;s key and address; the file can&apos;t add a provider, an address or
        a key. Effort levels use only Custard&apos;s own names ({efforts}). Custard reads the file
        when it starts and when you press Reload.
      </p>
      <div
        className="truncate rounded-lg border border-forge-700 bg-forge-900 px-3 py-2 text-sm"
        data-models-file-path
        title={report.path}
      >
        {report.path}
      </div>
      <div className="mt-2 flex items-start gap-3 text-xs" aria-live="polite">
        <p
          className={`flex-1 ${report.status === 'error' ? 'text-ember-600' : 'text-ash-400'}`}
          data-models-file-status
        >
          {status}
          {reloaded && ' Reloaded.'}
        </p>
        <button
          onClick={reload}
          className="shrink-0 whitespace-nowrap text-ash-400 hover:text-molten-200"
          title="Read models.json again"
        >
          Reload
        </button>
      </div>
      {error && <p className="mt-2 text-sm text-ember-600">{error}</p>}
      {report.loaded.length > 0 && (
        <div className="mt-2 text-xs text-ash-400" data-models-loaded>
          <p className="text-ash-300">Loaded</p>
          <ul className="mt-0.5">
            {report.loaded.map((m) => (
              <li key={m.id} data-model-entry={m.id} data-origin={m.origin}>
                <span className="text-ash-200">{m.label}</span> · {providerNames[m.provider]} ·{' '}
                {m.origin === 'customised' ? (
                  <span className="text-molten-300">customised</span>
                ) : (
                  'added'
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {report.rejected.length > 0 && (
        <div className="mt-2 text-xs text-ash-400" data-models-rejected>
          <p className="text-ash-300">Not loaded</p>
          <ul className="mt-0.5 space-y-0.5">
            {report.rejected.map((r) => (
              <li key={r.index} data-rejected-entry={r.id ?? `#${r.index + 1}`}>
                <span className="text-ash-200">{r.id ?? `Entry ${r.index + 1}`}</span> ·{' '}
                <span className="text-ember-600">{r.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {report.status === 'missing' && (
        <p className="mt-2 text-xs text-ash-500">
          Example:{' '}
          {
            '{ "version": 1, "models": [ { "id": "…", "provider": "deepseek", "label": "…", "limits": { "window": 1000000, "maxOutput": 384000 } } ] }'
          }
        </p>
      )}
    </section>
  )
}

export default ModelsFile
