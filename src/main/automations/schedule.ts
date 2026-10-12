// Which scheduled slots fall in a window, in a time zone, with DST handled by
// keeping local times: 07:30 stays 07:30 across a change of the clocks.
//
// - A local time that does not exist (the clocks jump forward over it) runs
//   at the same moment the jump ends, i.e. shifted by the gap.
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
function offsetAt(instant: number, tz: string): number {
  const l = localParts(instant, tz)
  return Date.UTC(l.y, l.m - 1, l.d, l.h, l.mi) - Math.floor(instant / 60000) * 60000
}

const DAY = 86_400_000

// The instant at which the wall clock in `tz` reads y-m-d h:mi.
export function zonedInstant(l: Local, tz: string): number {
  const wall = Date.UTC(l.y, l.m - 1, l.d, l.h, l.mi)
  const before = wall - offsetAt(wall - DAY, tz)
  const after = wall - offsetAt(wall + DAY, tz)
  const reads = (t: number): boolean => {
    const p = localParts(t, tz)
    return p.y === l.y && p.m === l.m && p.d === l.d && p.h === l.h && p.mi === l.mi
  }
  const real = [before, after].filter(reads)
  if (real.length) return Math.min(...real)
  // The wall time doesn't exist: the moment the clocks jumped.
  return before
}

const pad = (n: number): string => String(n).padStart(2, '0')
export const slotLabel = (l: Local): string =>
  `${l.y}-${pad(l.m)}-${pad(l.d)}T${pad(l.h)}:${pad(l.mi)}`

export type Slot = { label: string; instant: number }

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
      const instant = zonedInstant({ y, m, d, h, mi }, tz)
      if (instant > from && instant <= to)
        out.push({ label: `${y}-${pad(m)}-${pad(d)}T${t}`, instant })
    }
  }
  return out.sort((x, y) => x.instant - y.instant)
}

// YYYY-MM-DD of an instant in the automation's zone, for the per-day limit.
export function localDay(instant: number, tz?: string): string {
  const l = localParts(instant, tz || systemTimezone())
  return `${l.y}-${pad(l.m)}-${pad(l.d)}`
}
