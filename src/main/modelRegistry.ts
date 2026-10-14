import { allProfiles, builtInProfiles, setProfiles, type ModelProfile } from '../shared/models'

// Main's model registry: the profiles Custard offers while it runs. Built
// once at startup, before any window opens; the renderer gets a copy over IPC
// (models:profiles) and every request, price, limit and capability in main
// reads it through shared/models.ts (profileOf, requireProfile).
//
// Today the list is the built-in profiles. Profiles from the user's models
// file (Workstream A, Phase A4) would be merged in here, by a source passed
// to loadModelRegistry; nothing else needs to change for that.

export type ProfileSource = () => readonly ModelProfile[]

export function loadModelRegistry(...extra: ProfileSource[]): readonly ModelProfile[] {
  setProfiles([...builtInProfiles, ...extra.flatMap((s) => s())])
  return allProfiles()
}

// The list as the renderer receives it.
export const registeredProfiles = (): readonly ModelProfile[] => allProfiles()
