import { chatModels, type ModelAvailability } from '../../../../shared/chat'
import { providerNames } from '../../../../shared/providers'
import { REASONS } from './modelText'

// Above the message box when the chat's model can't be used now: the key is
// gone, the provider rejected it, the last check no longer lists the model,
// or Custard has no profile for it. The chat itself is untouched; picking
// another model carries it on.

type Props = {
  model: string
  status: ModelAvailability
  // No provider has a key saved.
  noKeys: boolean
  // None of this provider's models can be used.
  providerOut: boolean
  onPick: () => void
  onOpenSettings: () => void
}

function ModelNotice({
  model,
  status,
  noKeys,
  providerOut,
  onPick,
  onOpenSettings
}: Props): React.JSX.Element {
  const m = chatModels().find((x) => x.id === model)
  const name = m ? providerNames[m.provider] : 'This provider'
  const why = status.reason ? REASONS[status.reason](name) : ''
  // Without a profile the model has no provider: only picking another helps.
  const noProfile = status.reason === 'no-profile'
  const link = 'text-molten-300 hover:underline'
  return (
    <div
      role="status"
      data-model-notice={status.reason ?? 'unavailable'}
      className="mb-2 rounded-2xl border border-forge-700 bg-forge-900 px-4 py-2.5 text-sm text-ash-300"
    >
      {noKeys && !noProfile ? (
        <>
          No provider has a key yet, so nothing can be sent.{' '}
          <button onClick={onOpenSettings} className={link}>
            Add a key in Settings
          </button>
        </>
      ) : (
        <>
          {m?.label ?? model} can&apos;t be used right now. {why}
          {providerOut &&
            !noProfile &&
            ` None of ${name}'s models can be used; add a key or pick another provider.`}
          <span className="mt-1 flex gap-3">
            <button onClick={onPick} className={link}>
              Pick a different model
            </button>
            <button onClick={onOpenSettings} className={link}>
              Open Settings
            </button>
          </span>
        </>
      )}
    </div>
  )
}

export default ModelNotice
