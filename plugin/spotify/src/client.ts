import type { PluginContext, PluginResponse } from 'custard-plugin-sdk'

// A small Spotify Web API client on the plugin context. The host adds the
// access token (auth: true) and refreshes it once after a 401, so this code
// never sees a token.

export const API = 'https://api.spotify.com/v1'

export class SpotifyApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly reason?: string
  ) {
    super(message)
  }
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

export function explain(status: number, reason: string | undefined, message: string): string {
  // These reasons aren't in the current docs but the player API has long sent them.
  if (reason === 'NO_ACTIVE_DEVICE' || (status === 404 && /device/i.test(message)))
    return 'No active Spotify device. Open Spotify on a device (or choose one) and try again.'
  if (reason === 'PREMIUM_REQUIRED') return 'Spotify only allows this with a Premium account.'
  if (status === 401)
    return 'Spotify sign-in expired or is missing. Connect Spotify again in Settings → Plugins.'
  if (status === 403)
    return `Spotify refused this request (${reason || message || 'forbidden'}). Playback control needs Spotify Premium, and in development mode your account must be added under User Management in the developer dashboard.`
  if (reason === 'QUOTA_EXCEEDED')
    return "This Spotify app's API quota is used up for now. Try again later."
  if (status === 429) return 'Spotify rate limit reached. Wait a moment before trying again.'
  return `Spotify error ${status}: ${message || reason || 'unknown error'}`
}

export class SpotifyClient {
  constructor(private ctx: Pick<PluginContext, 'fetch'>) {}

  async request<T>(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    opts: RequestOptions = {}
  ): Promise<T | null> {
    const params = Object.entries(opts.query ?? {})
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&')
    const url = `${API}${path}${params ? `?${params}` : ''}`
    const send = (): Promise<PluginResponse> =>
      this.ctx.fetch(url, {
        method,
        auth: true,
        headers: opts.body !== undefined ? { 'content-type': 'application/json' } : {},
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
      })

    let res = await send()
    if (res.status === 429 && opts.idempotent) {
      const wait = Number(res.headers.get('retry-after') ?? '1')
      if (wait <= MAX_RETRY_WAIT_S) {
        await sleep(wait * 1000)
        res = await send()
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
      throw new SpotifyApiError(
        explain(res.status, err?.reason, err?.message ?? ''),
        res.status,
        err?.reason
      )
    }
    return data as T
  }
}
