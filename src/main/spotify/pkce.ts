import { createHash, randomBytes } from 'crypto'
import { SPOTIFY_REDIRECT_URI, SPOTIFY_SCOPES } from '../../shared/spotify'

// Authorization Code with PKCE: the desktop app holds no client secret.
// https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow

export const AUTHORIZE_URL = 'https://accounts.spotify.com/authorize'
export const TOKEN_URL = 'https://accounts.spotify.com/api/token'

export type Tokens = {
  accessToken: string
  refreshToken: string
  expiresAt: number
  scope: string
}

const base64url = (b: Buffer): string =>
  b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

export const makeVerifier = (): string => base64url(randomBytes(64))
export const makeState = (): string => base64url(randomBytes(16))
export const challengeFor = (verifier: string): string =>
  base64url(createHash('sha256').update(verifier).digest())

export function authorizeUrl(clientId: string, verifier: string, state: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: SPOTIFY_REDIRECT_URI,
    code_challenge_method: 'S256',
    code_challenge: challengeFor(verifier),
    scope: SPOTIFY_SCOPES.join(' '),
    state
  })
  return `${AUTHORIZE_URL}?${params}`
}

export class SpotifyAuthError extends Error {}

// Reads the redirect Spotify sends back to the loopback server. A wrong state
// means the request didn't come from this sign-in attempt.
export function parseCallback(url: string, expectedState: string): string {
  const u = new URL(url, SPOTIFY_REDIRECT_URI)
  const error = u.searchParams.get('error')
  if (error === 'access_denied') throw new SpotifyAuthError('You declined access in Spotify.')
  if (error) throw new SpotifyAuthError(`Spotify sign-in failed: ${error}`)
  if (u.searchParams.get('state') !== expectedState)
    throw new SpotifyAuthError('Sign-in response did not match this request. Try connecting again.')
  const code = u.searchParams.get('code')
  if (!code) throw new SpotifyAuthError('Spotify did not return an authorization code.')
  return code
}

type TokenResponse = {
  access_token: string
  refresh_token?: string
  expires_in: number
  scope?: string
}

async function tokenRequest(
  body: Record<string, string>,
  fetchFn: typeof fetch,
  previous?: Tokens
): Promise<Tokens> {
  const res = await fetchFn(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body)
  })
  const data = (await res.json().catch(() => ({}))) as Partial<TokenResponse> & {
    error?: string
    error_description?: string
  }
  if (!res.ok || !data.access_token) {
    if (data.error === 'invalid_grant')
      throw new SpotifyAuthError('Spotify access expired or was removed. Connect Spotify again.')
    if (data.error === 'invalid_client')
      throw new SpotifyAuthError('Spotify rejected the Client ID. Check it in Settings.')
    throw new SpotifyAuthError(
      `Spotify sign-in failed (${res.status}): ${data.error_description ?? data.error ?? 'unknown error'}`
    )
  }
  return {
    accessToken: data.access_token,
    // A refresh may or may not return a new refresh token; keep the old one if not.
    refreshToken: data.refresh_token ?? previous?.refreshToken ?? '',
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
    scope: data.scope ?? previous?.scope ?? ''
  }
}

export const exchangeCode = (
  clientId: string,
  code: string,
  verifier: string,
  fetchFn: typeof fetch = fetch
): Promise<Tokens> =>
  tokenRequest(
    {
      grant_type: 'authorization_code',
      code,
      redirect_uri: SPOTIFY_REDIRECT_URI,
      client_id: clientId,
      code_verifier: verifier
    },
    fetchFn
  )

export function refreshTokens(
  clientId: string,
  tokens: Tokens,
  fetchFn: typeof fetch = fetch
): Promise<Tokens> {
  if (!tokens.refreshToken)
    return Promise.reject(new SpotifyAuthError('Spotify session expired. Connect Spotify again.'))
  return tokenRequest(
    { grant_type: 'refresh_token', refresh_token: tokens.refreshToken, client_id: clientId },
    fetchFn,
    tokens
  )
}
