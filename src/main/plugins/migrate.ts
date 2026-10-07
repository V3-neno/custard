import { existsSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import type { Crypto, PluginStore } from './store'

// Spotify used to be built in. Its Client ID (settings.json) and tokens
// (spotify-tokens.bin) move into the Spotify plugin's config and secure
// storage, once, without overwriting anything already there. The plugin
// still has to be reviewed and activated before it runs.

export function migrateLegacySpotify(
  userData: string,
  store: PluginStore,
  crypto: Crypto
): string[] {
  const done: string[] = []
  let settings: { spotifyClientId?: unknown } = {}
  try {
    settings = JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8'))
  } catch {
    // No settings yet.
  }
  const clientId = typeof settings.spotifyClientId === 'string' ? settings.spotifyClientId : null
  const config = store.config('spotify')
  if (clientId && !config.clientId) {
    store.setConfig('spotify', { ...config, clientId })
    done.push('Spotify Client ID')
  }
  const tokenFile = join(userData, 'spotify-tokens.bin')
  if (existsSync(tokenFile)) {
    if (!store.secrets('spotify').__oauth)
      try {
        const t = JSON.parse(crypto.decrypt(readFileSync(tokenFile)))
        if (typeof t.accessToken === 'string' && typeof t.refreshToken === 'string') {
          store.setSecret('spotify', '__oauth', JSON.stringify(t))
          done.push('Spotify sign-in')
        }
      } catch {
        // Unreadable tokens: the user connects again.
      }
    rmSync(tokenFile, { force: true })
  }
  return done
}
