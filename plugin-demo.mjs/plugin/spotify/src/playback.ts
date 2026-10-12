import { SpotifyApiError, type SpotifyClient } from './client'

export type PlaybackDevice = {
  id?: string | null
  name?: string
  type?: string
  is_active?: boolean
  is_restricted?: boolean
  volume_percent?: number | null
  supports_volume?: boolean
}
export type PlaybackItem = {
  uri?: string
  name?: string
  artists?: { name: string }[]
  album?: { name?: string; images?: { url?: string }[] }
  external_urls?: { spotify?: string }
  duration_ms?: number | null
}
export type Player = {
  device?: PlaybackDevice | null
  is_playing?: boolean
  progress_ms?: number | null
  timestamp?: number
  shuffle_state?: boolean
  repeat_state?: string
  currently_playing_type?: string
  item?: PlaybackItem | null
  // Spotify responses use disallows; the reference also describes flat action flags.
  actions?: { disallows?: Record<string, boolean>; [key: string]: unknown }
}

export const actionKeys = {
  next_track: 'skipping_next',
  previous_track: 'skipping_prev',
  pause_playback: 'pausing',
  resume_playback: 'resuming',
  seek: 'seeking'
} as const
export type PlaybackCommand = keyof typeof actionKeys | 'adjust_volume'
type Result = { content: string; isError: boolean }
type Deps = { client: SpotifyClient; signal?: AbortSignal }
const commands = [...Object.keys(actionKeys), 'adjust_volume'] as PlaybackCommand[]
const fail = (content: string): Result => ({ content, isError: true })
const validMs = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0
const volume = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 100

export function disallows(p: Player | null): Record<string, boolean> | null {
  const source = p?.actions?.disallows ?? p?.actions
  if (!source || typeof source !== 'object') return null
  return Object.fromEntries(Object.entries(source).filter(([, value]) => typeof value === 'boolean')) as Record<string, boolean>
}

export type PlaybackMetadata = {
  schema_version: 1
  observed_at: string
  spotify_timestamp_ms: number | null
  playback_available: boolean
  currently_playing_type: string | null
  is_playing: boolean | null
  state: 'playing' | 'paused' | 'unavailable' | 'unknown'
  position_ms: number | null
  duration_ms: number | null
  track: {
    title: string | null
    artists: string[]
    album: string | null
    cover_artwork_url: string | null
    uri: string | null
    url: string | null
  } | null
  device: {
    id: string | null
    name: string | null
    type: string | null
    is_active: boolean | null
    is_restricted: boolean | null
    volume_percent: number | null
    supports_volume: boolean | null
  } | null
  actions: {
    disallows: Record<string, boolean> | null
    availability: Record<PlaybackCommand, boolean | null>
  }
}

// An observation, not a continuously advancing clock or a promise that a write succeeds.
export function playbackMetadata(p: Player | null, observedAt = new Date().toISOString()): PlaybackMetadata {
  const d = p?.device
  const item = p?.item
  const track = item?.uri?.startsWith('spotify:track:') ? item : null
  const flags = disallows(p)
  const availability = Object.fromEntries(commands.map((name) => {
    let available: boolean | null = null
    if (!d || d.is_active === false || d.is_restricted === true) available = false
    else if (name === 'adjust_volume') available = typeof d.supports_volume === 'boolean' ? d.supports_volume : null
    else if (flags) available = flags[actionKeys[name]] !== true
    return [name, available]
  })) as Record<PlaybackCommand, boolean | null>
  return {
    schema_version: 1,
    observed_at: observedAt,
    spotify_timestamp_ms: validMs(p?.timestamp) ? p.timestamp : null,
    playback_available: p !== null,
    currently_playing_type: p?.currently_playing_type ?? (track ? 'track' : null),
    is_playing: typeof p?.is_playing === 'boolean' ? p.is_playing : null,
    state: !p ? 'unavailable' : typeof p.is_playing !== 'boolean' ? 'unknown' : p.is_playing ? 'playing' : 'paused',
    position_ms: validMs(p?.progress_ms) ? p.progress_ms : null,
    duration_ms: validMs(item?.duration_ms) ? item.duration_ms : null,
    track: track ? {
      title: track.name ?? null,
      artists: (track.artists ?? []).map((artist) => artist.name),
      album: track.album?.name ?? null,
      cover_artwork_url: track.album?.images?.find((image) => !!image.url)?.url ?? null,
      uri: track.uri ?? null,
      url: track.external_urls?.spotify ?? null
    } : null,
    device: d ? {
      id: d.id ?? null, name: d.name ?? null, type: d.type ?? null,
      is_active: typeof d.is_active === 'boolean' ? d.is_active : null,
      is_restricted: typeof d.is_restricted === 'boolean' ? d.is_restricted : null,
      volume_percent: volume(d.volume_percent) ? d.volume_percent : null,
      supports_volume: typeof d.supports_volume === 'boolean' ? d.supports_volume : null
    } : null,
    actions: { disallows: flags, availability }
  }
}

function validation(name: PlaybackCommand, input: Record<string, unknown>): string | null {
  if (input.device_id !== undefined && (typeof input.device_id !== 'string' || !input.device_id.trim() || input.device_id.length > 100))
    return 'device_id must be a non-empty Spotify device ID of at most 100 characters.'
  if (name === 'seek' && !validMs(input.position_ms)) return 'position_ms must be a non-negative safe integer in milliseconds.'
  if (name === 'adjust_volume') {
    if (input.direction !== 'raise' && input.direction !== 'lower') return 'direction must be raise or lower.'
    if (input.amount_percent !== undefined && (!Number.isInteger(input.amount_percent) || (input.amount_percent as number) < 1 || (input.amount_percent as number) > 100))
      return 'amount_percent must be an integer from 1 to 100 (percentage points).'
  }
  return null
}

const paths: Record<PlaybackCommand, string> = {
  next_track: 'next', previous_track: 'previous', pause_playback: 'pause',
  resume_playback: 'play', seek: 'seek', adjust_volume: 'volume'
}

export async function playbackCommand(deps: Deps, name: PlaybackCommand, input: Record<string, unknown>): Promise<Result> {
  const invalid = validation(name, input)
  if (invalid) return fail(`Not run: ${invalid}`)
  if (deps.signal?.aborted) return fail('Not run: playback command cancelled before sending.')
  let p: Player | null
  try {
    // One preflight read, no retry or polling. Never implicitly activate a device.
    p = await deps.client.request<Player>('GET', '/me/player')
  } catch (err) {
    return fail(`Not run: ${err instanceof SpotifyApiError ? err.message : 'Could not read Spotify playback.'} No playback command was sent.`)
  }
  const d = p?.device
  if (!d?.id || d.is_active !== true)
    return fail('Not run: No active Spotify device with a controllable ID. Open or choose a device explicitly; this tool will not start or transfer playback as a fallback.')
  if (input.device_id !== undefined && input.device_id !== d.id)
    return fail('Not run: That device is not the current active playback device. List devices or explicitly request a transfer first; no transfer was performed.')
  if (d.is_restricted) return fail('Not run: This Spotify device is restricted and cannot be controlled through the Web API.')
  if (name !== 'adjust_volume' && disallows(p)?.[actionKeys[name]] === true)
    return fail(`Not run: Spotify currently disallows ${name}. The action may be unsupported for this device or playback context.`)
  const query: Record<string, string | number | undefined> = { device_id: d.id }
  if (name === 'seek') {
    // Spotify seeks beyond duration by advancing to the next song. Prevent that.
    if (!p?.item?.uri?.startsWith('spotify:track:') || !validMs(p.item.duration_ms) || p.item.duration_ms <= 0)
      return fail('Not run: Seeking requires a current music track with a known positive duration; no seek was sent.')
    if ((input.position_ms as number) >= p.item.duration_ms)
      return fail('Not run: position_ms must be less than the current track duration. Seeking to or beyond the end could skip to another track.')
    query.position_ms = input.position_ms as number
  }
  if (name === 'resume_playback' && !p?.item)
    return fail('Not run: No existing playback item was reported to resume. No context or queue was supplied or replaced.')
  if (name === 'adjust_volume') {
    if (d.supports_volume === false) return fail('Not run: This device does not support Spotify Web API volume control. Adjust volume on the device instead.')
    if (!volume(d.volume_percent)) return fail('Not run: Spotify did not report a usable current volume. A relative volume change cannot be calculated safely.')
    const delta = (input.amount_percent as number | undefined) ?? 5
    query.volume_percent = Math.max(0, Math.min(100, d.volume_percent + (input.direction === 'raise' ? delta : -delta)))
    if (query.volume_percent === d.volume_percent)
      return { content: `No change needed: Spotify reports volume already at ${d.volume_percent}%. No volume command was sent.`, isError: false }
  }
  if (deps.signal?.aborted) return fail('Not run: playback command cancelled before sending.')
  try {
    // Deliberately no body on resume: no uris, context_uri, offset or position_ms.
    // No plugin retries, even for otherwise idempotent commands. The host may
    // refresh and retry a rejected 401; it does not replay uncertain writes.
    await deps.client.request(name === 'next_track' || name === 'previous_track' ? 'POST' : 'PUT', `/me/player/${paths[name]}`, { query })
  } catch (err) {
    if (err instanceof SpotifyApiError && err.status < 500)
      return fail(`Spotify rejected ${name}: ${err.message} No automatic retry or fallback was performed.`)
    return fail(`Outcome unknown: ${name} was sent but ${err instanceof SpotifyApiError ? 'Spotify returned a server error' : 'the response was not received reliably'}. It may have taken effect. Check spotify__now_playing or ask the user before retrying; never blindly repeat next/previous. No automatic retry was performed.`)
  }
  const detail = name === 'adjust_volume' ? ` to ${query.volume_percent}%` : name === 'seek' ? ` to ${query.position_ms} ms` : ''
  return {
    content: `Spotify accepted ${name}${detail} on ${d.name ?? d.id}. Playback has not been verified. Use a separate spotify__now_playing observation to check; do not repeat the command just because state has not updated.`,
    isError: false
  }
}
