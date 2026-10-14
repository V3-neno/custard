import { useCallback, useEffect, useState } from 'react'
import type {
  CapabilityReport,
  DesignOperation,
  DesignSettings,
  ProviderListing
} from '../../../../shared/design'
import { cleanError } from './ui'
import Select from '../ui/Select'

// Design settings: which provider makes images (and with which model), and
// which plugin makes video by default. Only ids are saved here; keys stay in
// General (AI keys) or with the plugin. Nothing switches provider on its own:
// if the chosen one isn't ready, Design says so instead.

const OPS: { op: DesignOperation; label: string }[] = [
  { op: 'design.html', label: 'HTML pages' },
  { op: 'image.generate', label: 'Generate images' },
  { op: 'image.edit', label: 'Edit images' },
  { op: 'image.variation', label: 'Image variations' },
  { op: 'video.text-to-video', label: 'Video from text' },
  { op: 'video.image-to-video', label: 'Video from an image' }
]

const STATE: Record<ProviderListing['state'], string> = {
  ready: 'ready',
  disabled: 'turned off',
  'not-activated': 'not activated',
  'needs-config': 'needs setup'
}

function Status({ r }: { r: CapabilityReport[DesignOperation] }): React.JSX.Element {
  const a = r.availability
  if (a.status === 'supported') return <span className="text-molten-300">available</span>
  if (a.status === 'quality-uncertain')
    return (
      <span className="text-molten-300" title={a.uncertainty}>
        available · {a.uncertainty}
      </span>
    )
  return (
    <span className="text-ash-500">
      {a.reason}
      {a.fix ? ` ${a.fix.text}` : ''}
    </span>
  )
}

function DesignTab(): React.JSX.Element {
  const [settings, setSettings] = useState<DesignSettings | null>(null)
  const [providers, setProviders] = useState<ProviderListing[] | null>(null)
  const [report, setReport] = useState<CapabilityReport | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [s, p, r] = await Promise.all([
        window.custard.design.settings.get(),
        window.custard.design.providers(),
        window.custard.design.capabilities()
      ])
      setSettings(s)
      setProviders(p)
      setReport(r)
    } catch (e) {
      setError(cleanError(e))
    }
  }, [])
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
  }, [load])

  const save = async (next: DesignSettings): Promise<void> => {
    setSettings(next)
    try {
      await window.custard.design.settings.set(next)
      setError(null)
      setReport(await window.custard.design.capabilities())
    } catch (e) {
      setError(cleanError(e))
    }
  }

  if (!settings || !providers) return <p className="text-sm text-ash-500">{error ?? 'Loading…'}</p>

  const imageProviders = providers.filter((p) => p.operations.some((o) => o.startsWith('image.')))
  const videoProviders = providers.filter((p) => p.operations.some((o) => o.startsWith('video.')))
  const image = imageProviders.find((p) => p.id === settings.image.provider)
  const models = image?.models ?? []
  const model = models.find((m) => m.id === settings.image.model) ?? models[0]
  const video = videoProviders.find((p) => p.id === settings.video.provider)

  return (
    <>
      <section className="mb-6">
        <h3 className="mb-1 text-sm font-medium">Images</h3>
        <p className="mb-3 text-sm text-ash-300">
          Design makes images only with the provider chosen here, never with the chat model, and
          never switches to another provider on its own. Each image is asked for first, showing the
          provider and any files sent.
        </p>
        <label className="mb-1 block text-xs text-ash-400" htmlFor="design-image-provider">
          Image provider
        </label>
        <Select
          id="design-image-provider"
          className="w-full"
          value={settings.image.provider ?? ''}
          onChange={(e) =>
            save({
              ...settings,
              image: { provider: e.target.value || null, model: null }
            })
          }
        >
          <option value="">None</option>
          {imageProviders.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} · {STATE[p.state]}
            </option>
          ))}
        </Select>
        {settings.image.provider && !image && (
          <p className="mt-2 text-xs text-ember-600">
            The chosen provider isn&apos;t installed any more. Choose another.
          </p>
        )}
        {image?.needs && <p className="mt-2 text-xs text-molten-300">{image.needs}</p>}
        {models.length > 0 && (
          <>
            <label className="mb-1 mt-3 block text-xs text-ash-400" htmlFor="design-image-model">
              Model
            </label>
            <Select
              id="design-image-model"
              className="w-full"
              value={model?.id ?? ''}
              onChange={(e) =>
                save({ ...settings, image: { ...settings.image, model: e.target.value } })
              }
            >
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </Select>
            {model?.note && <p className="mt-1 text-xs text-ash-500">{model.note}</p>}
          </>
        )}
        {image?.source.kind === 'image-provider' && image.source.provider === 'openai' && (
          <p className="mt-2 text-xs text-ash-500">
            Uses the OpenAI API key from General. OpenAI may ask you to verify your organization
            before its image models work, and bills per token; the approval card shows the rates
            OpenAI publishes, not an estimate.
          </p>
        )}
      </section>

      <section className="mb-6">
        <h3 className="mb-1 text-sm font-medium">Video</h3>
        <p className="mb-3 text-sm text-ash-300">
          Custard has no video generator of its own. Video comes from a plugin that offers it.
        </p>
        <label className="mb-1 block text-xs text-ash-400" htmlFor="design-video-provider">
          Default video provider
        </label>
        <Select
          id="design-video-provider"
          className="w-full"
          value={settings.video.provider ?? ''}
          onChange={(e) => save({ ...settings, video: { provider: e.target.value || null } })}
        >
          <option value="">
            {videoProviders.length === 1 ? 'The one plugin that offers it' : 'None chosen'}
          </option>
          {videoProviders.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} · {STATE[p.state]}
            </option>
          ))}
        </Select>
        {!videoProviders.length && (
          <p className="mt-2 text-xs text-ash-500">No enabled plugin offers video.</p>
        )}
        {video?.needs && <p className="mt-2 text-xs text-molten-300">{video.needs}</p>}
      </section>

      {report && (
        <section>
          <h3 className="mb-2 text-sm font-medium">What Design can do now</h3>
          <ul className="space-y-1 text-xs">
            {OPS.map(({ op, label }) => (
              <li key={op} className="flex gap-2">
                <span className="w-32 shrink-0 text-ash-300">{label}</span>
                <Status r={report[op]} />
              </li>
            ))}
          </ul>
        </section>
      )}
      {error && <p className="mt-3 text-sm text-ember-600">{error}</p>}
    </>
  )
}

export default DesignTab
