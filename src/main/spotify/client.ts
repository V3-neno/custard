// A small Spotify Web API client. Tokens come from outside so this file has no
// Electron dependency and can be tested with a fake fetch.

export const API = 'https://api.spotify.com/v1'

export class SpotifyApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly reason?: string,
    readonly retryAfter?: number
  ) {
    super(message)
  }
}

type Auth = {
  // Returns a valid access token, refreshing it first when it is about to expire.
  token: () => Promise<string>
  // Forces a refresh after the API rejected the current token.
  refresh: () => Promise<string>
}

type RequestOptions = {
  query?: Record<string, string | number | undefined>
  body?: unknown
  // Safe to repeat: reads, or writes where a repeat has the same effect. Only
  // these are retried after a rate limit. Adding to the queue is never retried.
  idempotent?: boolean
}

const MAX_RETRY_WAIT_S = 5

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function explain(status: number, reason: string | undefined, message: string): string {
  // These reasons aren't in the current docs but the player API has long sent them.
  if (reason === 'NO_ACTIVE_DEVICE' || (status === 404 && /device/i.test(message)))
    return 'No active Spotify device. Open Spotify on a device (or choose one) and try again.'
  if (reason === 'PREMIUM_REQUIRED') return 'Spotify only allows this with a Premium account.'
  if (status === 401) return 'Spotify sign-in expired. Connect Spotify again in Settings.'
  if (status === 403)
    return `Spotify refused this request (${reason || message || 'forbidden'}). Playback control needs Spotify Premium, and in development mode your account must be added under User Management in the developer dashboard.`
  if (reason === 'QUOTA_EXCEEDED')
    return "This Spotify app's API quota is used up for now. Try again later."
  if (status === 429) return 'Spotify rate limit reached. Wait a moment before trying again.'
  return `Spotify error ${status}: ${message || reason || 'unknown error'}`
}

export class SpotifyClient {
  constructor(
    private auth: Auth,
    private fetchFn: typeof fetch = fetch
  ) {}

  async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T | null> {
    const url = new URL(API + path)
    for (const [k, v] of Object.entries(opts.query ?? {}))
      if (v !== undefined) url.searchParams.set(k, String(v))

    const send = (token: string): Promise<Response> =>
      this.fetchFn(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {})
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
      })

    let res = await send(await this.auth.token())
    // A rejected token means nothing was done, so one retry with a fresh
    // token is safe for every request.
    if (res.status === 401) res = await send(await this.auth.refresh())
    if (res.status === 429 && opts.idempotent) {
      const wait = Number(res.headers.get('Retry-After') ?? '1')
      if (wait <= MAX_RETRY_WAIT_S) {
        await sleep(wait * 1000)
        res = await send(await this.auth.token())
      }
    }

    if (res.status === 204) return null
    const text = await res.text()
    let data: unknown = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      // Some player endpoints answer 200 with a non-JSON body.
    }
    if (!res.ok) {
      const err = (data as { error?: { message?: string; reason?: string } } | null)?.error
      const message = err?.message ?? ''
      const retryAfter = Number(res.headers.get('Retry-After') ?? '') || undefined
      throw new SpotifyApiError(
        explain(res.status, err?.reason, message),
        res.status,
        err?.reason,
        retryAfter
      )
    }
    return data as T
  }
}
