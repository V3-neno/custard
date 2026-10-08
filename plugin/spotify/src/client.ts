import type { PluginContext, PluginResponse } from 'custard-plugin-sdk'

// Host-managed OAuth: tokens never enter the plugin. A rejected 401 may be
// refreshed/retried once by the host, not an uncertain playback command.
export const API = 'https://api.spotify.com/v1'
export class SpotifyApiError extends Error {
  constructor(message: string, readonly status: number, readonly reason?: string) { super(message) }
}
type RequestOptions = {
  query?: Record<string, string | number | undefined>
  body?: unknown
  // Opt-in rate-limit retry for existing reads/idempotent operations only.
  // New playback controls and queue writes deliberately never opt in.
  idempotent?: boolean
}
const MAX_RETRY_WAIT_S = 5
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export function explain(status: number, reason: string | undefined, message: string): string {
  if (reason === 'NO_ACTIVE_DEVICE' || (status === 404 && /device/i.test(message)))
    return 'No active Spotify device. Open Spotify on a device (or choose one) and try again.'
  if (reason === 'PREMIUM_REQUIRED') return 'Spotify only allows this with a Premium account.'
  if (status === 401) return 'Spotify sign-in expired or is missing. Connect Spotify again in Settings → Plugins.'
  if (reason === 'RESTRICTION_VIOLATED' || /restriction violated|restricted device|not supported|disallow/i.test(message))
    return `Spotify reports this action is restricted or unsupported for the device or playback context (${reason || message}). Use the device's own controls; no fallback was performed.`
  if (status === 403 && /scope/i.test(message))
    return 'Spotify authorization lacks a required scope. Reconnect Spotify in Settings → Plugins to grant the configured playback scopes.'
  if (reason === 'QUOTA_EXCEEDED') return "This Spotify app's API quota is used up for now. Try again later."
  if (status === 403)
    return `Spotify refused this request (${reason || message || 'forbidden'}). Playback control needs Spotify Premium, and in development mode your account must be added under User Management in the developer dashboard.`
  if (status === 429) return 'Spotify rate limit reached. Wait before trying again.'
  return `Spotify error ${status}: ${message || reason || 'unknown error'}`
}

export class SpotifyClient {
  constructor(private ctx: Pick<PluginContext, 'fetch'>) {}
  async request<T>(method: 'GET' | 'POST' | 'PUT', path: string, opts: RequestOptions = {}): Promise<T | null> {
    const params = Object.entries(opts.query ?? {})
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&')
    const url = `${API}${path}${params ? `?${params}` : ''}`
    const send = (): Promise<PluginResponse> => this.ctx.fetch(url, {
      method, auth: true,
      headers: opts.body !== undefined ? { 'content-type': 'application/json' } : {},
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
    })
    let res = await send()
    if (res.status === 429 && opts.idempotent) {
      const wait = Number(res.headers.get('retry-after') ?? '1')
      if (Number.isFinite(wait) && wait >= 0 && wait <= MAX_RETRY_WAIT_S) {
        await sleep(wait * 1000)
        res = await send()
      }
    }
    if (res.status === 204) return null
    const text = await res.text()
    let data: unknown = null
    try { data = text ? JSON.parse(text) : null } catch { /* Player endpoints may return non-JSON success. */ }
    if (!res.ok) {
      const err = (data as { error?: { message?: string; reason?: string } } | null)?.error
      const retryAfter = res.headers.get('retry-after')
      const wait = retryAfter === null ? NaN : Number(retryAfter)
      const hint = res.status === 429 && Number.isFinite(wait) && wait >= 0 ? ` Retry-After: ${wait} seconds.` : ''
      throw new SpotifyApiError(explain(res.status, err?.reason, err?.message ?? '') + hint, res.status, err?.reason)
    }
    return data as T
  }
}
