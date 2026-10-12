import type { Automation, RunContext, RunRecord, When } from '../../shared/automations'
import { localParts, slotLabel, slotsBetween, systemTimezone, type Slot } from './schedule'

const DAY = 86_400_000
// A month has at most 31 days, and a day-of-month schedule can skip a month.
const LOOKBACK = 100 * DAY
// Folded slots listed in a run's context; the rest are counted.
export const MAX_LISTED_MISSED = 200

export const whenOf = (instant: number, tz: string): When => ({
  local: slotLabel(localParts(instant, tz)),
  utc: new Date(Math.floor(instant / 60000) * 60000).toISOString().replace(':00.000Z', ':00Z')
})

// The slot before `instant`, if the schedule has one in the last 100 days.
export function previousSlot(a: Automation, instant: number): Slot | null {
  const s = slotsBetween(a, instant - LOOKBACK, instant - 1)
  return s.length ? s[s.length - 1] : null
}

export function lastSuccess(runs: RunRecord[]): RunContext['last_successful_run'] {
  const r = runs.find((x) => x.status === 'completed' && x.endedAt)
  return r ? { slot: r.slot ?? null, finished_at: new Date(r.endedAt!).toISOString() } : null
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
    last_successful_run: lastSuccess(o.runs),
    missed_slots: listed.map((s) => whenOf(s.instant, tz)),
    ...(omitted > 0 ? { missed_slots_omitted: omitted } : {}),
    catch_up: o.catchUp,
    time_zone: tz,
    ...(o.slot?.shifted ? { configured_local_time: o.slot.label } : {})
  }
}
