import { app, ipcMain, safeStorage, shell } from 'electron'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { createServer, type Server } from 'http'
import { join } from 'path'
import { SPOTIFY_REDIRECT_URI, type SpotifyStatus } from '../../shared/spotify'
import { getSpotifyClientId, setSpotifyClientId } from '../store'
import { SpotifyClient } from './client'
import {
  authorizeUrl,
  exchangeCode,
  makeState,
  makeVerifier,
  parseCallback,
  refreshTokens,
  SpotifyAuthError,
  type Tokens
} from './pkce'
import { SeenTracks, type SpotifyDeps } from './tools'

// Tokens are encrypted with the OS keychain and never leave the main process:
// not in the vault, prompts or logs.
const tokenPath = (): string => join(app.getPath('userData'), 'spotify-tokens.bin')

function loadTokens(): Tokens | null {
  if (!existsSync(tokenPath())) return null
  try {
    return JSON.parse(safeStorage.decryptString(readFileSync(tokenPath())))
  } catch {
    return null
  }
}

function saveTokens(t: Tokens): void {
  if (!safeStorage.isEncryptionAvailable())
    throw new Error('Secure storage is not available on this system')
  writeFileSync(tokenPath(), safeStorage.encryptString(JSON.stringify(t)))
}

let user: string | null = null
const seen = new SeenTracks()
let refreshing: Promise<string> | null = null

async function refresh(): Promise<string> {
  // Concurrent callers share one refresh.
  refreshing ??= (async () => {
    const clientId = getSpotifyClientId()
    const tokens = loadTokens()
    if (!clientId || !tokens) throw new SpotifyAuthError('Spotify is not connected.')
    try {
      const next = await refreshTokens(clientId, tokens)
      saveTokens(next)
      return next.accessToken
    } catch (err) {
      // A dead refresh token can't recover; forget it so Settings shows disconnected.
      if (err instanceof SpotifyAuthError && /again/.test(err.message))
        rmSync(tokenPath(), { force: true })
      throw err
    }
  })().finally(() => (refreshing = null))
  return refreshing
}

async function token(): Promise<string> {
  const t = loadTokens()
  if (!t) throw new SpotifyAuthError('Spotify is not connected. Connect it in Settings.')
  return t.expiresAt - Date.now() > 60_000 ? t.accessToken : refresh()
}

const client = new SpotifyClient({ token, refresh }, (input, init) => fetch(input, init))

export const spotifyConnected = (): boolean => !!getSpotifyClientId() && loadTokens() !== null

export const spotifyDeps = (): SpotifyDeps => ({
  client,
  seen,
  openExternal: (url) => shell.openExternal(url)
})

async function status(): Promise<SpotifyStatus> {
  const connected = spotifyConnected()
  if (connected && !user) {
    try {
      const me = await client.request<{ display_name?: string; id: string }>('GET', '/me', {
        idempotent: true
      })
      user = me?.display_name || me?.id || null
    } catch {
      // Status still shows connected; the name is a nicety.
    }
  }
  return { clientId: getSpotifyClientId(), connected, user: connected ? user : null }
}

let pending: { server: Server; cancel: () => void } | null = null

// Opens Spotify's consent page in the browser and waits for the redirect on
// the loopback address. Times out after five minutes.
function connect(): Promise<SpotifyStatus> {
  const clientId = getSpotifyClientId()
  if (!clientId) return Promise.reject(new Error('Add your Spotify Client ID first.'))
  pending?.cancel()
  const verifier = makeVerifier()
  const state = makeState()
  const { port, pathname } = new URL(SPOTIFY_REDIRECT_URI)

  return new Promise((resolve, reject) => {
    const page = (res: import('http').ServerResponse, text: string): void => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(
        `<body style="font-family:system-ui;background:#0a0705;color:#eee2cc;display:grid;place-items:center;height:100vh"><p>${text}</p></body>`
      )
    }
    const finish = (err: Error | null): void => {
      clearTimeout(timer)
      server.close()
      pending = null
      if (err) reject(err)
      else status().then(resolve, reject)
    }
    const server = createServer(async (req, res) => {
      if (!req.url || new URL(req.url, SPOTIFY_REDIRECT_URI).pathname !== pathname) {
        res.writeHead(404).end()
        return
      }
      try {
        const code = parseCallback(req.url, state)
        saveTokens(await exchangeCode(clientId, code, verifier))
        user = null
        page(res, 'Spotify is connected. You can close this tab and return to Custard.')
        finish(null)
      } catch (err) {
        page(res, 'Spotify connection failed. Return to Custard for details.')
        finish(err instanceof Error ? err : new Error(String(err)))
      }
    })
    const timer = setTimeout(
      () => finish(new Error('Spotify sign-in timed out. Try again.')),
      5 * 60_000
    )
    pending = { server, cancel: () => finish(new Error('Sign-in was restarted.')) }
    server.on('error', (err: NodeJS.ErrnoException) =>
      finish(
        new Error(
          err.code === 'EADDRINUSE'
            ? `Port ${port} is in use, so Custard can't receive the Spotify sign-in. Close whatever uses it and try again.`
            : err.message
        )
      )
    )
    server.listen(Number(port), '127.0.0.1', () => {
      shell.openExternal(authorizeUrl(clientId, verifier, state))
    })
  })
}

// Spotify has no token revocation endpoint: disconnecting deletes the tokens
// here; access can be removed fully at spotify.com/account/apps.
function disconnect(): void {
  rmSync(tokenPath(), { force: true })
  user = null
}

export function registerSpotifyHandlers(): void {
  ipcMain.handle('spotify:status', () => status())
  ipcMain.handle('spotify:setClientId', (_, id: string | null) => {
    const clean = id?.trim() || null
    if (clean && !/^[0-9a-f]{32}$/i.test(clean))
      throw new Error('That does not look like a Spotify Client ID (32 letters and digits).')
    if (clean !== getSpotifyClientId()) disconnect()
    setSpotifyClientId(clean)
    return status()
  })
  ipcMain.handle('spotify:connect', () => connect())
  ipcMain.handle('spotify:disconnect', () => {
    disconnect()
    return status()
  })
}
