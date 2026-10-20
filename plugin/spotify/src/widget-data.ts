// Bounded JSON-only widget projection. No config, credentials or remote URLs.
export type Snapshot = {
  schema: 1
  observedAt: number
  state: 'playing' | 'paused' | 'unknown' | 'unavailable'
  title: string
  artists: string[]
  deviceId: string | null
  deviceName: string
  active: boolean
  restricted: boolean
  music: boolean
  trackUri: string | null
  position: number | null
  duration: number | null
  volume?: number | null
  volumeSupported?: boolean
  actions: { next: boolean; pause: boolean; resume: boolean; seek: boolean }
  artwork: { kind: 'fallback'; reason: string }
  // The event log, for the player's indicator: on, off, or on but failing.
  eventLog?: 'on' | 'off' | 'failing'
}
const object = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
const text = (v: unknown, max = 512): string => typeof v === 'string' ? v.slice(0, max) : ''
const ms = (v: unknown): number | null => Number.isSafeInteger(v) && (v as number) >= 0 ? v as number : null
const percent = (v: unknown): number | null => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 100 ? v as number : null
export const ARTWORK_REASON = 'Album artwork unavailable: this runtime has no safe binary image response API.'

export function fromMetadata(raw: unknown): Snapshot {
  const m = object(raw), t = object(m.track), d = object(m.device)
  const a = object(object(m.actions).availability)
  const uri = typeof t.uri === 'string' && /^spotify:track:[A-Za-z0-9]{22}$/.test(t.uri) ? t.uri : null
  return {
    schema: 1,
    observedAt: typeof m.observed_at === 'string' ? Date.parse(m.observed_at) : NaN,
    state: m.state === 'playing' || m.state === 'paused' || m.state === 'unavailable' ? m.state : 'unknown',
    title: text(t.title) || 'No music track reported',
    artists: Array.isArray(t.artists) ? t.artists.slice(0, 16).map((s) => text(s, 160)).filter(Boolean) : [],
    deviceId: typeof d.id === 'string' && d.id.length > 0 && d.id.length <= 100 ? d.id : null,
    deviceName: text(d.name, 160) || 'No active device',
    active: d.is_active === true,
    restricted: d.is_restricted === true,
    music: m.currently_playing_type === 'track' && uri !== null,
    trackUri: uri,
    position: ms(m.position_ms), duration: ms(m.duration_ms),
    volume: percent(d.volume_percent), volumeSupported: d.supports_volume === true,
    actions: { next: a.next_track === true, pause: a.pause_playback === true, resume: a.resume_playback === true, seek: a.seek === true },
    artwork: { kind: 'fallback', reason: ARTWORK_REASON }
  }
}

// Preserve chat output byte-for-byte and reuse its existing snapshot.
export function withWidgetData<T extends { content: string; isError: boolean }>(result: T, eventLog?: Snapshot['eventLog']): T & { data?: Snapshot } {
  if (result.isError) return result
  const line = result.content.split('\n').at(-1) ?? ''
  if (!line.startsWith('playback_metadata: ')) return result
  try {
    const data = { ...fromMetadata(JSON.parse(line.slice('playback_metadata: '.length))), ...(eventLog ? { eventLog } : {}) }
    if (!Number.isFinite(data.observedAt)) return result
    if (JSON.stringify(data).length * 4 > 60000) return result
    return { ...result, data }
  } catch { return result }
}

export function readSnapshot(value: unknown): Snapshot | null {
  const s = object(value), a = object(s.actions)
  if (s.schema !== 1 || typeof s.observedAt !== 'number' || !Number.isFinite(s.observedAt) ||
      !['playing', 'paused', 'unknown', 'unavailable'].includes(String(s.state)) ||
      typeof s.title !== 'string' || !Array.isArray(s.artists) ||
      !s.artists.every((v) => typeof v === 'string') ||
      typeof s.deviceName !== 'string' ||
      !['active', 'restricted', 'music'].every((k) => typeof s[k] === 'boolean') ||
      !['next', 'pause', 'resume', 'seek'].every((k) => typeof a[k] === 'boolean') ||
      (s.position !== null && ms(s.position) === null) || (s.duration !== null && ms(s.duration) === null)) return null
  return {
    schema: 1, observedAt: s.observedAt, state: s.state as Snapshot['state'],
    title: text(s.title), artists: s.artists.slice(0, 16).map((v) => text(v, 160)),
    deviceId: typeof s.deviceId === 'string' && s.deviceId.length > 0 && s.deviceId.length <= 100 ? s.deviceId : null,
    deviceName: text(s.deviceName, 160), active: s.active as boolean, restricted: s.restricted as boolean,
    music: s.music as boolean,
    trackUri: typeof s.trackUri === 'string' && /^spotify:track:[A-Za-z0-9]{22}$/.test(s.trackUri) ? s.trackUri : null,
    position: ms(s.position), duration: ms(s.duration),
    volume: percent(s.volume), volumeSupported: s.volumeSupported === true,
    actions: { next: a.next as boolean, pause: a.pause as boolean, resume: a.resume as boolean, seek: a.seek as boolean },
    artwork: { kind: 'fallback', reason: ARTWORK_REASON },
    ...(s.eventLog === 'on' || s.eventLog === 'off' || s.eventLog === 'failing' ? { eventLog: s.eventLog } : {})
  }
}
