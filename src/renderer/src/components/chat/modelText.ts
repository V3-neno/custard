import {
  chatModels,
  effortChoices,
  shownEffort,
  type ChatSettings,
  type ModelAvailability
} from '../../../../shared/chat'

// Why a model can't be picked now, as the picker and the chat's notice say it.
export const REASONS: Record<NonNullable<ModelAvailability['reason']>, (p: string) => string> = {
  'no-key': (p) => `No ${p} key. Add one in Settings.`,
  rejected: (p) => `${p} rejected the saved key. Paste a new one in Settings.`,
  removed: () => "Your key can't use this model.",
  'no-profile': () => 'Its profile is missing.'
}

// The model chip with its effort: "Opus 5.5 · High", "DeepSeek Flash ·
// Balanced", or just "Haiku 4.5" for a model that takes none.
export const modelLabel = (s: ChatSettings): string => {
  const m = chatModels().find((x) => x.id === s.model)
  if (!m) return s.model
  if (!m.effort) return m.label
  const e = effortChoices(m.provider).find((x) => x.effort === shownEffort(m.provider, s.effort))
  return e ? `${m.label} · ${e.label}` : m.label
}
