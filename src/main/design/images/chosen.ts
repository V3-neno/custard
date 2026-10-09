import type { DesignSettings } from '../../../shared/design'
import { DEFAULT_IMAGE_MODEL, OPENAI_IMAGES_ID } from './models'

// The model to use: the one chosen in Design settings when OpenAI Images is
// the default provider, else OpenAI Images' own default (so it can be
// offered as an alternative). An unsupported id is passed through and makes
// the provider not ready; it never falls back to another model.
export function chosenModel(settings: Pick<DesignSettings, 'image'>): string {
  if (settings.image.provider === OPENAI_IMAGES_ID && settings.image.model)
    return settings.image.model
  return DEFAULT_IMAGE_MODEL
}
