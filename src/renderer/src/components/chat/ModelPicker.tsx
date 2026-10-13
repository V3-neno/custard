import { useEffect, useRef, useState } from 'react'
import {
  chatModels,
  deepseekEffort,
  deepseekEfforts,
  type ChatSettings,
  type ModelAvailability
} from '../../../../shared/chat'
import { modelLabel, REASONS } from './modelText'
import { providerIds, providerNames, type Provider } from '../../../../shared/providers'

// The model picker under the message box: the chat's model as a chip, and a
// panel with a tab per provider, each provider's models (greyed out with the
// reason when they can't be used now) and, for DeepSeek, its three effort
// levels. Picking changes only what the next message is sent to; nothing is
// asked of any provider.

type Props = {
  settings: ChatSettings
  availability: ModelAvailability[] | null
  onPick: (s: ChatSettings) => void
  disabled?: boolean
  // Bumped to open the panel from outside (Pick a different model).
  openSignal?: number
  className: string
}

function ModelPicker({
  settings,
  availability,
  onPick,
  disabled,
  openSignal,
  className
}: Props): React.JSX.Element {
  const current = chatModels.find((m) => m.id === settings.model)
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<Provider>(current?.provider ?? 'claude')
  const box = useRef<HTMLDivElement>(null)
  const firstSignal = useRef(openSignal)
  useEffect(() => {
    if (openSignal === firstSignal.current) return
    setOpen(true)
  }, [openSignal])
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent): void => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    const esc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', esc)
    }
  }, [open])
  const status = (id: string): ModelAvailability | undefined =>
    availability?.find((a) => a.id === id)

  const pick = (id: ChatSettings['model'], provider: Provider): void => {
    onPick({
      model: id,
      effort: provider === 'deepseek' ? deepseekEffort(settings.effort) : settings.effort
    })
    setOpen(false)
  }

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        title="Model"
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        data-model={settings.model}
        onClick={() => {
          setTab(current?.provider ?? 'claude')
          setOpen((o) => !o)
        }}
        className={`${className} disabled:opacity-40`}
      >
        {modelLabel(settings)}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Pick a model"
          className="absolute bottom-full left-0 z-20 mb-2 w-80 rounded-2xl border border-forge-700 bg-forge-850 p-3 shadow-xl"
        >
          <div
            role="tablist"
            className="mb-2 flex gap-1 rounded-full border border-forge-700 p-0.5 text-xs"
          >
            {providerIds.map((p) => (
              <button
                key={p}
                type="button"
                role="tab"
                aria-selected={tab === p}
                onClick={() => setTab(p)}
                className={`flex-1 rounded-full px-2 py-1 ${tab === p ? 'bg-forge-700 text-ash-100' : 'text-ash-400 hover:text-ash-100'}`}
              >
                {providerNames[p]}
              </button>
            ))}
          </div>
          <ul className="space-y-0.5" data-picker-models={tab}>
            {chatModels
              .filter((m) => m.provider === tab)
              .map((m) => {
                const a = status(m.id)
                const off = a?.available === false
                const on = m.id === settings.model
                return (
                  <li key={m.id}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={on}
                      data-pick={m.id}
                      data-available={off ? 'false' : 'true'}
                      disabled={off}
                      onClick={() => pick(m.id, m.provider)}
                      className={`w-full rounded-lg px-2 py-1.5 text-left text-sm ${
                        on ? 'bg-forge-700 text-molten-200' : 'text-ash-200 hover:bg-forge-800'
                      } disabled:cursor-not-allowed disabled:text-ash-500 disabled:hover:bg-transparent`}
                    >
                      {m.label}
                      {off && a?.reason && (
                        <span className="block text-xs text-ash-500">
                          {REASONS[a.reason](providerNames[m.provider])}
                        </span>
                      )}
                    </button>
                  </li>
                )
              })}
          </ul>
          {tab === 'deepseek' && (
            <div className="mt-2 border-t border-forge-700 pt-2" data-deepseek-effort>
              <p className="mb-1 text-xs text-ash-400">
                {current?.provider === 'deepseek'
                  ? `Effort for ${current.label}`
                  : 'Effort: pick a DeepSeek model first'}
              </p>
              <div className="flex gap-1">
                {deepseekEfforts.map((e) => {
                  const on =
                    current?.provider === 'deepseek' && deepseekEffort(settings.effort) === e.effort
                  return (
                    <button
                      key={e.effort}
                      type="button"
                      aria-pressed={on}
                      disabled={current?.provider !== 'deepseek'}
                      onClick={() => onPick({ model: settings.model, effort: e.effort })}
                      className={`flex-1 rounded-full border px-2 py-1 text-xs disabled:opacity-40 ${
                        on
                          ? 'border-molten-500/60 text-molten-200'
                          : 'border-forge-700 text-ash-300 hover:text-molten-200'
                      }`}
                    >
                      {e.label}
                    </button>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default ModelPicker
