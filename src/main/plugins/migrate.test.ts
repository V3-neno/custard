import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { migrateLegacySpotify } from './migrate'
import { PluginStore } from './store'

const crypto = {
  available: () => true,
  encrypt: (s: string) => Buffer.from(`enc:${s}`),
  decrypt: (b: Buffer) => b.toString().replace(/^enc:/, '')
}

function setup(): { dir: string; store: PluginStore } {
  const dir = mkdtempSync(join(tmpdir(), 'custard-mig-'))
  return { dir, store: new PluginStore(join(dir, 'plugins'), crypto) }
}

const tokens = { accessToken: 'a', refreshToken: 'r', expiresAt: 1, scope: 's' }

describe('Spotify settings migration', () => {
  it('moves the client id and tokens into the plugin and keeps other settings', () => {
    const { dir, store } = setup()
    const settings = {
      chat: { model: 'gpt-6-luna', effort: 'high' },
      vaultPath: '/v',
      spotifyClientId: 'c'.repeat(32)
    }
    writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings))
    writeFileSync(join(dir, 'spotify-tokens.bin'), crypto.encrypt(JSON.stringify(tokens)))
    expect(migrateLegacySpotify(dir, store, crypto)).toEqual([
      'Spotify Client ID',
      'Spotify sign-in'
    ])
    expect(store.config('spotify')).toEqual({ clientId: 'c'.repeat(32) })
    expect(JSON.parse(store.secrets('spotify').__oauth)).toEqual(tokens)
    expect(existsSync(join(dir, 'spotify-tokens.bin'))).toBe(false)
    expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))).toEqual(settings)
    // The plugin still needs review and activation.
    expect(store.state('spotify').enabled).toBe(false)
  })

  it('never overwrites what the plugin already has', () => {
    const { dir, store } = setup()
    store.setConfig('spotify', { clientId: 'new' })
    store.setSecret('spotify', '__oauth', 'existing')
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ spotifyClientId: 'old' }))
    writeFileSync(join(dir, 'spotify-tokens.bin'), crypto.encrypt(JSON.stringify(tokens)))
    expect(migrateLegacySpotify(dir, store, crypto)).toEqual([])
    expect(store.config('spotify').clientId).toBe('new')
    expect(store.secrets('spotify').__oauth).toBe('existing')
  })

  it('does nothing on a fresh install', () => {
    const { dir, store } = setup()
    expect(migrateLegacySpotify(dir, store, crypto)).toEqual([])
    expect(store.ids()).toEqual([])
  })
})
