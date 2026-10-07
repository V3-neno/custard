import { useEffect, useRef, useState } from 'react'
import {
  chatModels,
  efforts,
  providerNames,
  type ChatSettings,
  type Effort,
  type Provider
} from '../../../../shared/chat'
import { ArrowUpIcon, StopIcon } from '../icons'

type Props = {
  busy: boolean
  placeholder: string
  settings: ChatSettings
  onSettings: (s: ChatSettings) => void
  onSend: (text: string) => void
  onStop: () => void
  draft: string
  setDraft: (text: string) => void
}

const chip =
  'cursor-pointer appearance-none rounded-full border border-forge-700 bg-forge-900 px-3 py-1 text-xs text-ash-400 outline-none transition-colors hover:border-forge-600 hover:text-ash-100'

function Composer(props: Props): React.JSX.Element {
  const { busy, placeholder, settings, onSettings, onSend, onStop, draft, setDraft } = props
  const [focused, setFocused] = useState(false)
  const input = useRef<HTMLTextAreaElement>(null)
  const model = chatModels.find((m) => m.id === settings.model)
  const submit = (): void => {
    if (!busy && draft.trim()) onSend(draft)
  }

  // Grow with the text, up to a limit.
  useEffect(() => {
    const el = input.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`
  }, [draft])

  return (
    <div
      className={`rounded-3xl border bg-forge-850/90 p-3 backdrop-blur transition-all ${
        focused
          ? 'border-molten-500/50 shadow-[0_0_40px_rgb(var(--glow-deep)/0.12)]'
          : 'border-forge-700 shadow-[0_10px_40px_rgb(0_0_0/0.4)]'
      }`}
    >
      <textarea
        ref={input}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            submit()
          }
        }}
        rows={1}
        autoFocus
        placeholder={placeholder}
        className="block max-h-60 min-h-[44px] w-full resize-none bg-transparent px-2 pt-1.5 text-[15px] text-ash-100 outline-none placeholder:text-ash-500"
      />
      <div className="mt-2 flex items-center gap-2">
        <select
          className={chip}
          title="Model"
          value={settings.model}
          onChange={(e) =>
            onSettings({ ...settings, model: e.target.value as ChatSettings['model'] })
          }
        >
          {(['claude', 'openai'] as Provider[]).map((p) => (
            <optgroup key={p} label={providerNames[p]}>
              {chatModels
                .filter((m) => m.provider === p)
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
        {model?.effort && (
          <select
            className={chip}
            value={settings.effort}
            onChange={(e) => onSettings({ ...settings, effort: e.target.value as Effort })}
            title="Effort: how hard the model thinks"
          >
            {efforts.map((e) => (
              <option key={e} value={e}>
                {e} effort
              </option>
            ))}
          </select>
        )}
        <div className="ml-auto">
          {busy ? (
            <button
              onClick={onStop}
              title="Stop"
              className="flex h-9 w-9 items-center justify-center rounded-full border border-forge-600 text-ash-300 hover:border-ember-600 hover:text-molten-200"
            >
              <StopIcon />
            </button>
          ) : (
            <button
              onClick={submit}
              disabled={!draft.trim()}
              title="Send"
              className="molten-fill flex h-9 w-9 items-center justify-center rounded-full text-lg text-forge-950 transition-opacity disabled:opacity-30"
            >
              <ArrowUpIcon />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

export default Composer
