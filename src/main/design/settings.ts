import { defaultDesignSettings, type DesignSettings } from '../../shared/design'

// Design settings as stored: provider and model ids only. Anything else in
// the file (a key, a token, an unknown field) is dropped, so Design settings
// can never hold a secret; credentials stay with AI settings or the plugin.
const ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,99}$/
const idOrNull = (x: unknown): string | null => (typeof x === 'string' && ID.test(x) ? x : null)

export function normalizeDesignSettings(raw: unknown): DesignSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const image = (r.image && typeof r.image === 'object' ? r.image : {}) as Record<string, unknown>
  const video = (r.video && typeof r.video === 'object' ? r.video : {}) as Record<string, unknown>
  return {
    image: {
      provider: idOrNull(image.provider) ?? defaultDesignSettings.image.provider,
      model: idOrNull(image.model) ?? defaultDesignSettings.image.model
    },
    video: { provider: idOrNull(video.provider) ?? defaultDesignSettings.video.provider }
  }
}
