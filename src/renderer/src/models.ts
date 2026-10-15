import { setProfiles } from '../../shared/models'

// The renderer's copy of main's model registry (main/modelRegistry.ts),
// read once before the app draws, so the picker, Settings and every label
// show the same models main will send to. Should the read fail, the copy
// stays the built-in profiles; main checks every model again before
// anything is sent.
export async function loadModels(): Promise<void> {
  try {
    setProfiles(await window.custard.models.profiles())
  } catch (err) {
    console.error('Model list:', err)
  }
}
