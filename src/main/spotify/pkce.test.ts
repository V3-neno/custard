import { describe, expect, it, vi } from 'vitest'
import { SPOTIFY_REDIRECT_URI } from '../../shared/spotify'
import {
  authorizeUrl,
  challengeFor,
  exchangeCode,
  parseCallback,
  refreshTokens,
  SpotifyAuthError
} from './pkce'

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('PKCE', () => {
  it('derives the S256 challenge (RFC 7636 example)', () => {
    expect(challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
    )
  })

  it('builds an authorize URL with only the needed scopes', () => {
    const url = new URL(authorizeUrl('a'.repeat(32), 'verifier', 'st'))
    expect(url.origin + url.pathname).toBe('https://accounts.spotify.com/authorize')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('redirect_uri')).toBe(SPOTIFY_REDIRECT_URI)
    expect(url.searchParams.get('state')).toBe('st')
    expect(url.searchParams.get('scope')?.split(' ').sort()).toEqual([
      'user-modify-playback-state',
      'user-read-currently-playing',
      'user-read-playback-state'
    ])
  })
})

describe('parseCallback', () => {
  it('returns the code when the state matches', () => {
    expect(parseCallback('/callback?code=abc&state=s1', 's1')).toBe('abc')
  })
  it('rejects a mismatched state', () => {
    expect(() => parseCallback('/callback?code=abc&state=evil', 's1')).toThrow(/did not match/)
  })
  it('explains a declined consent', () => {
    expect(() => parseCallback('/callback?error=access_denied&state=s1', 's1')).toThrow(/declined/)
  })
})

describe('token requests', () => {
  it('exchanges the code with the verifier and no client secret', async () => {
    const fetchFn = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body))
      expect(body.get('grant_type')).toBe('authorization_code')
      expect(body.get('code_verifier')).toBe('ver')
      expect(body.get('client_secret')).toBeNull()
      return json(200, { access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope: 's' })
    })
    const t = await exchangeCode('id', 'code', 'ver', fetchFn as typeof fetch)
    expect(t.accessToken).toBe('at')
    expect(t.refreshToken).toBe('rt')
    expect(t.expiresAt).toBeGreaterThan(Date.now())
  })

  it('keeps the old refresh token when Spotify does not send a new one', async () => {
    const fetchFn = vi.fn(async () => json(200, { access_token: 'at2', expires_in: 3600 }))
    const t = await refreshTokens(
      'id',
      { accessToken: 'at', refreshToken: 'rt', expiresAt: 0, scope: 's' },
      fetchFn as typeof fetch
    )
    expect(t).toMatchObject({ accessToken: 'at2', refreshToken: 'rt', scope: 's' })
  })

  it('asks to reconnect when the refresh token is revoked', async () => {
    const fetchFn = vi.fn(async () => json(400, { error: 'invalid_grant' }))
    await expect(
      refreshTokens(
        'id',
        { accessToken: 'at', refreshToken: 'rt', expiresAt: 0, scope: '' },
        fetchFn as typeof fetch
      )
    ).rejects.toThrow(SpotifyAuthError)
  })
})
