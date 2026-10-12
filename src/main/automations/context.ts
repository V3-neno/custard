import type { Automation, RunContext, RunRecord, When } from '../../shared/automations'
import {
  isoLocal,
  isoOffset,
  offsetAt,
  slotsBetween,
  systemTimezone,
  type Slot,
  zonedMoment
} from './schedule'

const DAY = 86_400_000
// A month has at most 31 days, and a day-of-month schedule can skip a month.
const LOOKBACK = 100 * DAY
// Folded slots listed in a run's context; the rest are counted.
export const MAX_LISTED_MISSED = 200

export const whenOf = (instant: number, tz: string): When => ({
  local: isoLocal(instant, tz),
  utc: new Date(Math.floor(instant / 60000) * 60000).toISOString().replace(':00.000Z', ':00Z')
})

// The slot before `instant`, if the schedule has one in the last 100 days.
export function previousSlot(a: Automation, instant: number): Slot | null {
  const s = slotsBetween(a, instant - LOOKBACK, instant - 1)
  return s.length ? s[s.length - 1] : null
}

// A record keeps the slot's instant; an older one only has its label, which is
// read in the zone (the first of a repeated hour).
function slotWithOffset(r: RunRecord, tz: string): string | null {
  if (r.slotAt !== undefined) return isoLocal(r.slotAt, tz)
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(r.slot ?? '')
  if (!m) return r.slot ?? null
  const [y, mo, d, h, mi] = m.slice(1).map(Number)
  return isoLocal(zonedMoment({ y, m: mo, d, h, mi }, tz).instant, tz)
}

export function lastSuccess(runs: RunRecord[], tz: string): RunContext['last_successful_run'] {
  const r = runs.find((x) => x.status === 'completed' && x.endedAt)
  return r ? { slot: slotWithOffset(r, tz), finished_at: new Date(r.endedAt!).toISOString() } : null
}

export function buildContext(
  a: Automation,
  o: {
    // The slot this run is for; absent for Run now.
    slot?: Slot
    now: number
    catchUp: boolean
    folded: Slot[]
    runs: RunRecord[]
  }
): RunContext {
  const tz = a.timezone || systemTimezone()
  const at = o.slot?.instant ?? o.now
  const prev = previousSlot(a, at)
  const listed = o.folded.slice(-MAX_LISTED_MISSED)
  const omitted = o.folded.length - listed.length
  return {
    scheduled_for: whenOf(at, tz),
    window_start: prev ? whenOf(prev.instant, tz) : null,
    window_end: whenOf(at, tz),
    last_successful_run: lastSuccess(o.runs, tz),
    missed_slots: listed.map((s) => whenOf(s.instant, tz)),
    ...(omitted > 0 ? { missed_slots_omitted: omitted } : {}),
    catch_up: o.catchUp,
    time_zone: tz,
    // A time that does not exist has no offset of its own; it is given the
    // one in force just before the jump, which is how the user read it.
    ...(o.slot?.shifted
      ? {
          configured_local_time: `${o.slot.label}${isoOffset(offsetAt(o.slot.instant - 60000, tz))}`
        }
      : {})
  }
}
