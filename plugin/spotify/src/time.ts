// Time helpers: every timestamp keeps its UTC value; a local rendering is added
// only when the runtime can compute it reliably. No offset is ever guessed.
export const DEFAULT_TIME_ZONE = 'Europe/Stockholm'

export type ZoneInfo = { zone: string | null; note: string | null }

function zoneWorks(zone: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); return true } catch { return false }
}

// Configured zone, else the default; invalid input falls back with a note;
// no Intl support at all means UTC only.
export function resolveZone(configured: unknown): ZoneInfo {
  const wanted = typeof configured === 'string' && configured.trim() ? configured.trim() : DEFAULT_TIME_ZONE
  if (zoneWorks(wanted)) return { zone: wanted, note: null }
  if (wanted !== DEFAULT_TIME_ZONE && zoneWorks(DEFAULT_TIME_ZONE))
    return { zone: DEFAULT_TIME_ZONE, note: `Configured time zone "${wanted.slice(0, 60)}" is not valid; using ${DEFAULT_TIME_ZONE}.` }
  return { zone: null, note: 'Local time is unavailable in this runtime (no time-zone support); UTC only.' }
}

export const utcIso = (ms: number): string => new Date(ms).toISOString()

// ISO 8601 with an explicit Z or offset. A timestamp without one is refused,
// because Date.parse would silently read it in the runtime's own zone.
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/
export function parseInstant(value: unknown): number | null {
  if (typeof value !== 'string' || value.length > 40 || !INSTANT.test(value)) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

// "2026-10-09T18:35:00+02:00" for the given instant, or null if unavailable.
export function toLocalIso(ms: number, zone: string | null): string | null {
  if (!zone || !Number.isFinite(ms)) return null
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).formatToParts(new Date(ms))
    const get = (type: string): string | undefined => parts.find((p) => p.type === type)?.value
    const [y, mo, d, h, mi, s] = ['year', 'month', 'day', 'hour', 'minute', 'second'].map(get)
    if (!y || !mo || !d || !h || !mi || !s) return null
    const wallAsUtc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s))
    const offsetMinutes = Math.round((wallAsUtc - Math.floor(ms / 1000) * 1000) / 60000)
    const sign = offsetMinutes < 0 ? '-' : '+'
    const abs = Math.abs(offsetMinutes)
    const pad = (n: number): string => String(n).padStart(2, '0')
    return `${y}-${mo}-${d}T${h}:${mi}:${s}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  } catch { return null }
}

// Observation clock shared by the read tools. A non-finite `now` falls back to
// the current time rather than throwing (toISOString throws on NaN).
export function observationClock(configured: unknown, now: number = Date.now()): {
  zone: string | null
  fields: { observed_at_utc: string; observed_at_local: string | null; time_zone: string | null; time_zone_note?: string }
} {
  const at = Number.isFinite(now) ? now : Date.now()
  const z = resolveZone(configured)
  return {
    zone: z.zone,
    fields: {
      observed_at_utc: utcIso(at),
      observed_at_local: toLocalIso(at, z.zone),
      time_zone: z.zone,
      ...(z.note ? { time_zone_note: z.note } : {})
    }
  }
}
