import { createHash, randomBytes } from 'crypto'
import { createServer, type Server, type ServerResponse } from 'http'
import type { OAuthSpec } from '../../shared/plugins'
import { safeFetch, type Transport } from './net'

// OAuth 2.0 Authorization Code with PKCE (RFC 7636), run by the host for any
// plugin whose manifest declares `auth`. Tokens stay in the main process and
// OS-encrypted storage; plugin code only ever asks the host to attach them.

export type Tokens = { accessToken: string; refreshToken: string; expiresAt: number; scope: string }

export class AuthError extends Error {
  constructor(
    message: string,
    // The stored tokens are dead and should be deleted.
    readonly revoked = false
  ) {
    super(message)
  }
}

const base64url = (b: Buffer): string =>
  b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

export const makeVerifier = (): string => base64url(randomBytes(64))
export const makeState = (): string => base64url(randomBytes(16))
export const challengeFor = (verifier: string): string =>
  base64url(createHash('sha256').update(verifier).digest())

export const redirectUri = (spec: OAuthSpec): string =>
  `http://127.0.0.1:${spec.redirectPort}${spec.redirectPath}`

export function authorizeUrl(
  spec: OAuthSpec,
  clientId: string,
  verifier: string,
  state: string
): string {
  const url = new URL(spec.authorizeUrl)
  const params = {
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri(spec),
    code_challenge_method: 'S256',
    code_challenge: challengeFor(verifier),
    scope: spec.scopes.join(' '),
    state
  }
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return url.toString()
}

// A wrong state means the redirect didn't come from this sign-in attempt.
export function parseCallback(url: string, expectedState: string): string {
  const u = new URL(url, 'http://127.0.0.1')
  const error = u.searchParams.get('error')
  if (error === 'access_denied') throw new AuthError('You declined access.')
  if (error) throw new AuthError(`Sign-in failed: ${error.slice(0, 100)}`)
  if (u.searchParams.get('state') !== expectedState)
    throw new AuthError('The sign-in response did not match this request. Try connecting again.')
  const code = u.searchParams.get('code')
  if (!code) throw new AuthError('No authorization code was returned.')
  return code
}

type TokenOptions = { allowedHosts: string[]; transport?: Transport }

async function tokenRequest(
  spec: OAuthSpec,
  body: Record<string, string>,
  o: TokenOptions,
  previous?: Tokens
): Promise<Tokens> {
  const res = await safeFetch(spec.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(body).toString(),
    allowedHosts: o.allowedHosts,
    signal: AbortSignal.timeout(20_000),
    // The body holds the code verifier or refresh token: never redirected.
    redirectHosts: [],
    transport: o.transport
  })
  let data: Record<string, unknown> = {}
  try {
    data = JSON.parse(res.body)
  } catch {
    // Reported below.
  }
  if (res.status < 200 || res.status >= 300 || typeof data.access_token !== 'string') {
    if (data.error === 'invalid_grant')
      throw new AuthError('Account access expired or was removed. Connect again in Settings.', true)
    if (data.error === 'invalid_client')
      throw new AuthError('The Client ID was rejected. Check it in the plugin settings.')
    throw new AuthError(
      `Sign-in failed (${res.status}): ${String(data.error_description ?? data.error ?? 'unknown error').slice(0, 200)}`
    )
  }
  return {
    accessToken: data.access_token,
    // A refresh may or may not return a new refresh token; keep the old one if not.
    refreshToken:
      typeof data.refresh_token === 'string' ? data.refresh_token : (previous?.refreshToken ?? ''),
    expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
    scope: typeof data.scope === 'string' ? data.scope : (previous?.scope ?? '')
  }
}

export const exchangeCode = (
  spec: OAuthSpec,
  clientId: string,
  code: string,
  verifier: string,
  o: TokenOptions
): Promise<Tokens> =>
  tokenRequest(
    spec,
    {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(spec),
      client_id: clientId,
      code_verifier: verifier
    },
    o
  )

export function refreshTokens(
  spec: OAuthSpec,
  clientId: string,
  tokens: Tokens,
  o: TokenOptions
): Promise<Tokens> {
  if (!tokens.refreshToken)
    return Promise.reject(new AuthError('The session expired. Connect again in Settings.', true))
  return tokenRequest(
    spec,
    { grant_type: 'refresh_token', refresh_token: tokens.refreshToken, client_id: clientId },
    o,
    tokens
  )
}

// Opens the consent page and waits for the redirect on the loopback address,
// for up to five minutes. One sign-in at a time per port.
const pending = new Map<number, () => void>()

export function signIn(
  spec: OAuthSpec,
  clientId: string,
  openBrowser: (url: string) => Promise<void>,
  o: TokenOptions
): Promise<Tokens> {
  pending.get(spec.redirectPort)?.()
  const verifier = makeVerifier()
  const state = makeState()
  return new Promise((resolve, reject) => {
    const page = (res: ServerResponse, text: string): void => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(
        `<body style="font-family:system-ui;background:#0a0705;color:#eee2cc;display:grid;place-items:center;height:100vh"><p>${text}</p></body>`
      )
    }
    const finish = (err: Error | null, tokens?: Tokens): void => {
      clearTimeout(timer)
      server.close()
      pending.delete(spec.redirectPort)
      if (err) reject(err)
      else resolve(tokens!)
    }
    const server: Server = createServer(async (req, res) => {
      if (!req.url || new URL(req.url, 'http://127.0.0.1').pathname !== spec.redirectPath) {
        res.writeHead(404).end()
        return
      }
      try {
        const code = parseCallback(req.url, state)
        const tokens = await exchangeCode(spec, clientId, code, verifier, o)
        page(res, 'Connected. You can close this tab and return to Custard.')
        finish(null, tokens)
      } catch (err) {
        page(res, 'Connection failed. Return to Custard for details.')
        finish(err instanceof Error ? err : new Error(String(err)))
      }
    })
    const timer = setTimeout(
      () => finish(new AuthError('Sign-in timed out. Try again.')),
      5 * 60_000
    )
    pending.set(spec.redirectPort, () => finish(new AuthError('Sign-in was restarted.')))
    server.on('error', (err: NodeJS.ErrnoException) =>
      finish(
        new AuthError(
          err.code === 'EADDRINUSE'
            ? `Port ${spec.redirectPort} is in use, so Custard can't receive the sign-in. Close whatever uses it and try again.`
            : err.message
        )
      )
    )
    server.listen(spec.redirectPort, '127.0.0.1', () => {
      openBrowser(authorizeUrl(spec, clientId, verifier, state)).catch((e) => finish(e))
    })
  })
}
