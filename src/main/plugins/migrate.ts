import { existsSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { readSettingsFile, writeSettingsFile } from '../settingsFile'
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
  const settingsPath = join(userData, 'settings.json')
  const settings = existsSync(settingsPath) ? readSettingsFile(settingsPath) : {}
  const clientId = typeof settings.spotifyClientId === 'string' ? settings.spotifyClientId : null
  if (clientId) {
    const config = store.config('spotify')
    if (!config.clientId) {
      store.setConfig('spotify', { ...config, clientId })
      done.push('Spotify Client ID')
    }
    // Moved (or the plugin already had one): the old key goes, so a Client
    // ID the user later clears in the plugin isn't brought back at the next
    // start.
    const rest = { ...settings }
    delete rest.spotifyClientId
    writeSettingsFile(settingsPath, rest)
  }
  // The old token file is deleted only once its tokens are safely in the
  // plugin's secure storage, or the plugin already has a sign-in of its own.
  // If it can't be read now (secure storage locked) it stays for a later start.
  const tokenFile = join(userData, 'spotify-tokens.bin')
  if (existsSync(tokenFile)) {
    let saved = false
    try {
      if (store.secrets('spotify').__oauth) saved = true
      else {
        const t = JSON.parse(crypto.decrypt(readFileSync(tokenFile)))
        if (typeof t.accessToken === 'string' && typeof t.refreshToken === 'string') {
          store.setSecret('spotify', '__oauth', JSON.stringify(t))
          saved = true
          done.push('Spotify sign-in')
        }
      }
    } catch {
      // Unreadable now (or the plugin's own secrets are): try again next start.
    }
    if (saved) rmSync(tokenFile, { force: true })
  }
  return done
}
