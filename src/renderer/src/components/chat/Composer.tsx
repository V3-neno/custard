import { useState } from 'react'
import { chatModels, efforts, type ChatSettings, type Effort } from '../../../../shared/chat'

type Props = {
  busy: boolean
  settings: ChatSettings
  onSettings: (s: ChatSettings) => void
  onSend: (text: string) => void
  onStop: () => void
  draft: string
  setDraft: (text: string) => void
}

const selectClass =
  'rounded-md border border-ink-700 bg-ink-800 px-2 py-1 text-xs text-ink-300 outline-none hover:text-custard-50'

function Composer({
  busy,
  settings,
  onSettings,
  onSend,
  onStop,
  draft,
  setDraft
}: Props): React.JSX.Element {
  const [focused, setFocused] = useState(false)
  const model = chatModels.find((m) => m.id === settings.model)
  const submit = (): void => {
    if (!busy && draft.trim()) onSend(draft)
  }

  return (
    <div className="px-6 pb-5">
      <div
        className={`mx-auto max-w-3xl rounded-2xl border bg-ink-800 p-3 transition-colors ${
          focused ? 'border-custard-400/60' : 'border-ink-700'
        }`}
      >
        <textarea
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
          rows={3}
          placeholder="Message Claude…"
          className="w-full resize-none bg-transparent text-sm outline-none placeholder:text-ink-500"
        />
        <div className="flex items-center gap-2">
          <select
            className={selectClass}
            value={settings.model}
            onChange={(e) =>
              onSettings({ ...settings, model: e.target.value as ChatSettings['model'] })
            }
          >
            {chatModels.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          {model?.effort && (
            <select
              className={selectClass}
              value={settings.effort}
              onChange={(e) => onSettings({ ...settings, effort: e.target.value as Effort })}
              title="Effort: how hard Claude thinks"
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
                className="rounded-lg bg-ink-700 px-3 py-1.5 text-sm hover:bg-ink-500"
              >
                Stop
              </button>
            ) : (
              <button
                onClick={submit}
                disabled={!draft.trim()}
                className="rounded-lg bg-custard-400 px-3 py-1.5 text-sm font-medium text-ink-900 hover:bg-custard-300 disabled:opacity-40"
              >
                Send
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export default Composer
