import type { RunRecord } from './automations'
import { EFFORT_LABELS, profileOf, shownLevel, type Effort, type EffortSpec } from './models'

// The effort control in Settings → Automations and the model line in its
// run list. Pure, so the rules are unit tested; the form only renders them.

// The level the form holds for a model and a stored (or previously picked)
// effort. A model with levels shows the stored one as shownLevel does, or
// its `otherwise` level when none is stored (a new automation, an old one
// with no effort, or one coming from a model that takes none). A model that
// takes no effort holds none. A model with no profile keeps what is stored,
// since nothing says what it would show.
export function formEffort(model: string, stored: Effort | undefined): Effort | undefined {
  const profile = profileOf(model)
  if (!profile) return stored
  if (!profile.effort) return undefined
  return shownLevel(profile.effort, stored ?? profile.effort.otherwise)
}

const label = (spec: EffortSpec, e: Effort): string =>
  spec.levels.find((l) => l.value === e)?.label ?? EFFORT_LABELS[e]

export type EffortControl =
  // The model's levels as buttons, one picked. `note` says why the picked
  // one isn't simply what was saved.
  | {
      kind: 'levels'
      levels: { value: Effort; label: string }[]
      picked: Effort
      cost: string
      note?: string
    }
  // A model that takes no effort: its provider's levels, greyed out.
  | { kind: 'none'; levels: { value: Effort; label: string }[]; note: string }
  // A model with no profile: no levels to show; what is stored is kept.
  | { kind: 'no-profile'; note: string }

// What the control shows. `saved` is the effort on the automation as it was
// opened (undefined for a new one or one saved before there was a choice),
// `isNew` whether it is new, `picked` what the form holds now.
export function effortControl(
  model: string,
  saved: Effort | undefined,
  isNew: boolean,
  picked: Effort | undefined,
  providerLevels: EffortSpec | null
): EffortControl {
  const profile = profileOf(model)
  if (!profile)
    return {
      kind: 'no-profile',
      note: `${model} has no profile, so its effort levels can't be shown. ${
        picked ? `The saved effort (${EFFORT_LABELS[picked]}) is kept.` : 'No effort is saved.'
      }`
    }
  const spec = profile.effort
  if (!spec)
    return {
      kind: 'none',
      levels: (providerLevels?.levels ?? []).map((l) => ({ value: l.value, label: l.label })),
      note: `${profile.label} takes no effort level${
        saved ? `. Saving removes the saved one (${EFFORT_LABELS[saved]})` : ''
      }`
    }
  const shown = picked ?? shownLevel(spec, saved ?? spec.otherwise)
  const levels = spec.levels.map((l) => ({ value: l.value, label: l.label }))
  const cost = `Levels above ${label(spec, spec.otherwise)} cost more.`
  let note: string | undefined
  if (!isNew && saved === undefined)
    note = `Not set (the provider's default). Saving sets ${label(spec, shown)}.`
  else if (
    saved !== undefined &&
    !spec.levels.some((l) => l.value === saved) &&
    shown === shownLevel(spec, saved)
  )
    note = `Saved as ${EFFORT_LABELS[saved]}, which ${profile.label} doesn't list, so it sends ${label(spec, shown)}.`
  return { kind: 'levels', levels, picked: shown, cost, ...(note ? { note } : {}) }
}

// The model and effort a run used, for the run list: "Opus 5.5 · High",
// "Haiku 4.5", "Opus 5.5 · effort not set". Null for records from before
// these were kept (and skipped slots), which show as before.
export function runModelText(r: Pick<RunRecord, 'model' | 'effort'>): string | null {
  if (!r.model) return null
  const profile = profileOf(r.model)
  const name = profile?.label ?? r.model
  if (profile && !profile.effort) return name
  if (!r.effort) return `${name} · effort not set`
  const spec = profile?.effort
  return `${name} · ${spec ? label(spec, shownLevel(spec, r.effort)) : EFFORT_LABELS[r.effort]}`
}
