// Which scheduled slots fall in a window, in a time zone, with DST handled by
// keeping local times: 07:30 stays 07:30 across a change of the clocks.
//
// - A local time that does not exist (the clocks jump forward over it) runs
//   once, at the moment the jump ends (02:30 on a day the clocks go 02:00 to
//   03:00 runs at 03:00). If another time of the schedule is at that moment
//   (03:00 itself), the two are one run, not two; the slot that really exists
//   keeps the run.
// - A local time that happens twice (the clocks go back) runs the first time.
// - A day of the month a month does not have is skipped that month.

import type { Automation } from '../../shared/automations'

type Local = { y: number; m: number; d: number; h: number; mi: number }

const formatters = new Map<string, Intl.DateTimeFormat>()
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric'
    })
    formatters.set(tz, f)
  }
  return f
}

export const systemTimezone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone

export function localParts(instant: number, tz: string): Local {
  const get: Record<string, number> = {}
  for (const p of formatter(tz).formatToParts(new Date(instant)))
    if (p.type !== 'literal') get[p.type] = Number(p.value)
  return { y: get.year, m: get.month, d: get.day, h: get.hour, mi: get.minute }
}

// The zone's offset from UTC at an instant, in ms (positive east of UTC).
export function offsetAt(instant: number, tz: string): number {
  const l = localParts(instant, tz)
  return Date.UTC(l.y, l.m - 1, l.d, l.h, l.mi) - Math.floor(instant / 60000) * 60000
}

const DAY = 86_400_000

// The instant at which the wall clock in `tz` reads y-m-d h:mi. When it never
// does (the clocks jump over it), `exists` is false and the instant is the
// moment the jump ends, the first one the wall clock is past it.
export function zonedMoment(l: Local, tz: string): { instant: number; exists: boolean } {
  const wall = Date.UTC(l.y, l.m - 1, l.d, l.h, l.mi)
  const before = wall - offsetAt(wall - DAY, tz)
  const after = wall - offsetAt(wall + DAY, tz)
  const reads = (t: number): boolean => {
    const p = localParts(t, tz)
    return p.y === l.y && p.m === l.m && p.d === l.d && p.h === l.h && p.mi === l.mi
  }
  const real = [before, after].filter(reads)
  if (real.length) return { instant: Math.min(...real), exists: true }
  // The wall time doesn't exist. `after` is still on the old offset and
  // `before` already on the new one; find the minute the offset changes.
  let lo = Math.min(before, after)
  let hi = Math.max(before, after)
  const old = offsetAt(lo, tz)
  while (hi - lo > 60_000) {
    const mid = lo + Math.floor((hi - lo) / 2 / 60_000) * 60_000
    if (mid === lo) break
    if (offsetAt(mid, tz) === old) lo = mid
    else hi = mid
  }
  return { instant: hi, exists: false }
}

export const zonedInstant = (l: Local, tz: string): number => zonedMoment(l, tz).instant

const pad = (n: number): string => String(n).padStart(2, '0')
export const slotLabel = (l: Local): string =>
  `${l.y}-${pad(l.m)}-${pad(l.d)}T${pad(l.h)}:${pad(l.mi)}`

// An offset as ISO 8601 writes it: +02:00, -03:30, +00:00 for UTC.
export function isoOffset(ms: number): string {
  const min = Math.round(ms / 60000)
  const a = Math.abs(min)
  return `${min < 0 ? '-' : '+'}${pad(Math.floor(a / 60))}:${pad(a % 60)}`
}

// The wall time at an instant with the zone's offset then ("2026-10-25T02:30+01:00"),
// so the repeated hour when clocks go back reads as two different moments.
export const isoLocal = (instant: number, tz: string): string =>
  `${slotLabel(localParts(instant, tz))}${isoOffset(offsetAt(instant, tz))}`

// `shifted`: the time of day does not exist on that date, so the slot runs when
// the clocks jump (its label is still the time that was configured).
export type Slot = { label: string; instant: number; shifted?: true }

type Schedule = Pick<Automation, 'times' | 'days' | 'timezone'>

// Slots with from < instant <= to, oldest first.
export function slotsBetween(a: Schedule, from: number, to: number): Slot[] {
  if (to <= from) return []
  const tz = a.timezone || systemTimezone()
  const out: Slot[] = []
  const first = localParts(from, tz)
  const last = localParts(to, tz)
  // A day either side covers a zone whose date differs from UTC's.
  let day = Date.UTC(first.y, first.m - 1, first.d) - DAY
  const end = Date.UTC(last.y, last.m - 1, last.d) + DAY
  for (; day <= end; day += DAY) {
    const dt = new Date(day)
    const y = dt.getUTCFullYear()
    const m = dt.getUTCMonth() + 1
    const d = dt.getUTCDate()
    if (a.days.length && !a.days.includes(d)) continue
    for (const t of a.times) {
      const [h, mi] = t.split(':').map(Number)
      const { instant, exists } = zonedMoment({ y, m, d, h, mi }, tz)
      if (instant > from && instant <= to)
        out.push({
          label: `${y}-${pad(m)}-${pad(d)}T${t}`,
          instant,
          ...(exists ? {} : { shifted: true })
        })
    }
  }
  out.sort((x, y) => x.instant - y.instant || (x.shifted ? 1 : 0) - (y.shifted ? 1 : 0))
  // Two slots at one moment are one run: the one that really exists, else the
  // first of the shifted ones.
  return out.filter((slot, i) => i === 0 || slot.instant !== out[i - 1].instant)
}

// YYYY-MM-DD of an instant in the automation's zone, for the per-day limit.
export function localDay(instant: number, tz?: string): string {
  const l = localParts(instant, tz || systemTimezone())
  return `${l.y}-${pad(l.m)}-${pad(l.d)}`
}
