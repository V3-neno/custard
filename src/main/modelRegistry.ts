import { allProfiles, builtInProfiles, setProfiles, type ModelProfile } from '../shared/models'

// Main's model registry: the profiles Custard offers while it runs. Built at
// startup, before any window opens, and again on Reload in Settings; the
// renderer gets a copy over IPC (models:profiles) and every request, price,
// limit and capability in main reads it through shared/models.ts
// (profileOf, requireProfile).
//
// The list is the built-in profiles plus each source's profiles (the user's
// models file, main/modelsFile.ts). A source's profile with a built-in id
// takes that built-in's place; any other is added after the built-ins.

export type ProfileSource = () => readonly ModelProfile[]

export function loadModelRegistry(...sources: ProfileSource[]): readonly ModelProfile[] {
  const extra = sources.flatMap((s) => s())
  const byId = new Map(extra.map((m) => [m.id, m]))
  const builtIn = builtInProfiles as readonly ModelProfile[]
  setProfiles([
    ...builtIn.map((m) => byId.get(m.id) ?? m),
    ...extra.filter((m) => !builtIn.some((b) => b.id === m.id))
  ])
  return allProfiles()
}

// The list as the renderer receives it.
export const registeredProfiles = (): readonly ModelProfile[] => allProfiles()
