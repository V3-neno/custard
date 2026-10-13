import {
  chatModels,
  deepseekEffort,
  deepseekEfforts,
  type ChatSettings,
  type ModelAvailability
} from '../../../../shared/chat'

// Why a model can't be picked now, as the picker and the chat's notice say it.
export const REASONS: Record<NonNullable<ModelAvailability['reason']>, (p: string) => string> = {
  'no-key': (p) => `No ${p} key. Add one in Settings.`,
  rejected: (p) => `${p} rejected the saved key. Paste a new one in Settings.`,
  removed: () => "Your key can't use this model."
}

// The model chip: "Opus 5.5", or for DeepSeek "DeepSeek Flash · Balanced".
export const modelLabel = (s: ChatSettings): string => {
  const m = chatModels.find((x) => x.id === s.model)
  if (!m) return s.model
  if (m.provider !== 'deepseek') return m.label
  const e = deepseekEfforts.find((x) => x.effort === deepseekEffort(s.effort))
  return `${m.label} · ${e?.label ?? 'Balanced'}`
}
