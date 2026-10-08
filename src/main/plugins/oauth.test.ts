import { describe, expect, it } from 'vitest'
import type { OAuthSpec } from '../../shared/plugins'
import type { NetRequest, NetResponse } from './net'
import {
  AuthError,
  authorizeUrl,
  challengeFor,
  exchangeCode,
  parseCallback,
  redirectUri,
  refreshTokens
} from './oauth'

const spec: OAuthSpec = {
  type: 'oauth-pkce',
  authorizeUrl: 'https://accounts.spotify.com/authorize',
  tokenUrl: 'https://accounts.spotify.com/api/token',
  redirectPort: 43821,
  redirectPath: '/callback',
  scopes: ['user-read-playback-state', 'user-modify-playback-state'],
  clientIdConfigKey: 'clientId',
  apiHosts: ['api.spotify.com']
}
const allowedHosts = ['accounts.spotify.com', 'api.spotify.com']
const json = (status: number, body: unknown): NetResponse => ({
  status,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body)
})

describe('PKCE', () => {
  it('derives the S256 challenge (RFC 7636 appendix B)', () => {
    expect(challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
    )
  })

  it('builds the authorize URL from the manifest', () => {
    const url = new URL(authorizeUrl(spec, 'a'.repeat(32), 'verifier', 'st'))
    expect(url.origin + url.pathname).toBe('https://accounts.spotify.com/authorize')
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:43821/callback')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('scope')).toBe(
      'user-read-playback-state user-modify-playback-state'
    )
    expect(url.searchParams.get('client_secret')).toBeNull()
    expect(redirectUri(spec)).toBe('http://127.0.0.1:43821/callback')
  })

  it('checks the state and explains a declined consent', () => {
    expect(parseCallback('/callback?code=abc&state=s1', 's1')).toBe('abc')
    expect(() => parseCallback('/callback?code=abc&state=evil', 's1')).toThrow(/did not match/)
    expect(() => parseCallback('/callback?error=access_denied&state=s1', 's1')).toThrow(/declined/)
  })
})

describe('token requests', () => {
  it('exchanges the code with the verifier and no client secret, through the safe transport', async () => {
    const seen: NetRequest[] = []
    const transport = async (r: NetRequest): Promise<NetResponse> => {
      seen.push(r)
      return json(200, { access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope: 's' })
    }
    const t = await exchangeCode(spec, 'id', 'code', 'ver', { allowedHosts, transport })
    const body = new URLSearchParams(seen[0].body)
    expect(body.get('code_verifier')).toBe('ver')
    expect(body.get('client_secret')).toBeNull()
    expect(seen[0].url.toString()).toBe(spec.tokenUrl)
    expect(t).toMatchObject({ accessToken: 'at', refreshToken: 'rt' })
  })

  it('keeps the old refresh token when none is returned', async () => {
    const transport = async (): Promise<NetResponse> =>
      json(200, { access_token: 'at2', expires_in: 3600 })
    const t = await refreshTokens(
      spec,
      'id',
      { accessToken: 'at', refreshToken: 'rt', expiresAt: 0, scope: 's' },
      { allowedHosts, transport }
    )
    expect(t).toMatchObject({ accessToken: 'at2', refreshToken: 'rt', scope: 's' })
  })

  it('marks a revoked refresh token so it is deleted', async () => {
    const transport = async (): Promise<NetResponse> => json(400, { error: 'invalid_grant' })
    const err = await refreshTokens(
      spec,
      'id',
      { accessToken: 'at', refreshToken: 'rt', expiresAt: 0, scope: '' },
      { allowedHosts, transport }
    ).catch((e) => e)
    expect(err).toBeInstanceOf(AuthError)
    expect(err.revoked).toBe(true)
  })

  it('refuses a token endpoint the plugin may not reach', async () => {
    const transport = async (): Promise<NetResponse> => json(200, {})
    await expect(
      exchangeCode(spec, 'id', 'c', 'v', { allowedHosts: ['api.spotify.com'], transport })
    ).rejects.toThrow(/no permission/)
  })
})
