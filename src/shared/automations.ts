// Automations: a skill the user has Custard run on a schedule while it is
// open. The user creates them in Settings; nothing here can be changed by a
// note, a plugin result or a web page.

export type AutomationLimits = {
  // Runs started per local day (scheduled ones; Run now is not counted).
  runsPerDay: number
  // Tool calls in one run, and minutes one run may take.
  toolCalls: number
  minutes: number
  // Failed runs in a row before the automation pauses itself.
  failuresBeforePause: number
  // Missed slots run on opening, at most this many (the newest), oldest
  // first. Older ones are folded into one summary. 0 turns catch-up off.
  catchUpRuns: number
}

export type Automation = {
  id: string
  name: string
  // The skill's folder name under Custard/Skills.
  skill: string
  // A model id from chatModels().
  model: string
  // Local times of day, "HH:MM", ascending.
  times: string[]
  // Days of the month (1-31). Empty means every day. A day a month doesn't
  // have (31 in June) is skipped that month.
  days: number[]
  // IANA time zone. Absent means the computer's.
  timezone?: string
  // Granted folders the run may change, by folder. The mode is whatever the
  // grant says when the run starts; a removed grant removes the access.
  folders: string[]
  // Plugins whose read tools the run may use.
  plugins: string[]
  enabled: boolean
  limits: AutomationLimits
}

export const DEFAULT_LIMITS: AutomationLimits = {
  runsPerDay: 24,
  toolCalls: 30,
  minutes: 5,
  failuresBeforePause: 3,
  catchUpRuns: 3
}
export const LIMIT_BOUNDS: Record<keyof AutomationLimits, [number, number]> = {
  runsPerDay: [1, 96],
  toolCalls: [1, 100],
  minutes: [1, 30],
  failuresBeforePause: [1, 10],
  catchUpRuns: [0, 10]
}
export const MAX_AUTOMATIONS = 50

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/
const ID = /^[a-z0-9-]{1,40}$/

export const validTimezone = (tz: unknown): tz is string => {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

const clamp = (v: unknown, [lo, hi]: [number, number], fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : fallback

export type AutomationCheck = { ok: true; automation: Automation } | { ok: false; problem: string }

// Cleans one automation from settings or the window. Whole entries only: a
// problem is reported, never silently repaired into something else.
export function checkAutomation(raw: unknown): AutomationCheck {
  const r = (raw ?? {}) as Record<string, unknown>
  const bad = (problem: string): AutomationCheck => ({ ok: false, problem })
  if (typeof r.id !== 'string' || !ID.test(r.id)) return bad('Missing id.')
  const name = typeof r.name === 'string' ? r.name.trim().slice(0, 60) : ''
  if (!name) return bad('Give the automation a name.')
  const skill = typeof r.skill === 'string' ? r.skill.trim() : ''
  if (!skill || skill.length > 80 || /[\\/:\0]|^\.|\.\./.test(skill))
    return bad('Pick a skill from the list.')
  if (typeof r.model !== 'string' || !r.model || r.model.length > 80) return bad('Pick a model.')
  const times = [
    ...new Set(
      Array.isArray(r.times) ? r.times.filter((t): t is string => typeof t === 'string') : []
    )
  ].sort()
  if (!times.length || times.length > 48 || times.some((t) => !TIME.test(t)))
    return bad('Give at least one time of day, like 07:30.')
  const daysIn = Array.isArray(r.days) ? r.days : []
  if (daysIn.some((d) => !Number.isInteger(d) || d < 1 || d > 31))
    return bad('Days of the month are 1 to 31.')
  const days = [...new Set(daysIn as number[])].sort((a, b) => a - b)
  if (r.timezone !== undefined && r.timezone !== '' && !validTimezone(r.timezone))
    return bad("That time zone isn't known.")
  const strings = (v: unknown, max: number): string[] =>
    [...new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])].slice(
      0,
      max
    )
  const l = (r.limits ?? {}) as Record<string, unknown>
  return {
    ok: true,
    automation: {
      id: r.id,
      name,
      skill,
      model: r.model,
      times,
      days,
      ...(typeof r.timezone === 'string' && r.timezone ? { timezone: r.timezone } : {}),
      folders: strings(r.folders, 50),
      plugins: strings(r.plugins, 50).filter((p) => /^[a-z][a-z0-9-]{1,30}$/.test(p)),
      enabled: r.enabled === true,
      limits: {
        runsPerDay: clamp(l.runsPerDay, LIMIT_BOUNDS.runsPerDay, DEFAULT_LIMITS.runsPerDay),
        toolCalls: clamp(l.toolCalls, LIMIT_BOUNDS.toolCalls, DEFAULT_LIMITS.toolCalls),
        minutes: clamp(l.minutes, LIMIT_BOUNDS.minutes, DEFAULT_LIMITS.minutes),
        failuresBeforePause: clamp(
          l.failuresBeforePause,
          LIMIT_BOUNDS.failuresBeforePause,
          DEFAULT_LIMITS.failuresBeforePause
        ),
        catchUpRuns: clamp(l.catchUpRuns, LIMIT_BOUNDS.catchUpRuns, DEFAULT_LIMITS.catchUpRuns)
      }
    }
  }
}

export function normalizeAutomations(value: unknown): Automation[] {
  const seen = new Set<string>()
  const out: Automation[] = []
  for (const raw of (Array.isArray(value) ? value : []).slice(0, MAX_AUTOMATIONS)) {
    const c = checkAutomation(raw)
    if (c.ok && !seen.has(c.automation.id)) {
      seen.add(c.automation.id)
      out.push(c.automation)
    }
  }
  return out
}

// --- records ----------------------------------------------------------------

export type RunStatus = 'running' | 'completed' | 'failed' | 'stopped' | 'skipped'

export type RunRecord = {
  id: string
  automationId: string
  // How it started: the schedule, or the user's Run now.
  kind: 'scheduled' | 'manual'
  // The slot it ran for, as local "YYYY-MM-DDTHH:MM" (scheduled runs).
  slot?: string
  // The same slot as an instant (epoch ms); older records only have the label.
  slotAt?: number
  // The slot was missed and this is its late run.
  catchUp?: boolean
  startedAt: number
  endedAt?: number
  status: RunStatus
  // Why it was skipped, stopped or failed, in plain words; on a completed
  // run, that its last reply was cut off (CUT_OFF_REASON).
  reason?: string
  // What it did, in order: the call label and how it ended.
  calls: { label: string; outcome: string }[]
  // Notes it created or changed.
  changes: { path: string; kind: 'create' | 'append' | 'edit' }[]
  // The end of its last message, capped.
  summary?: string
  // Questions it left for the user (ids).
  questions?: string[]
}

// Automation state kept apart from settings.
export type AutomationState = {
  // Everything up to here has been looked at for slots (epoch ms).
  checkedUntil?: number
  failures: number
  paused?: { reason: string; time: number }
}

export const RECORDS_KEPT = 100

// What Settings shows for one automation.
export type AutomationView = {
  automation: Automation
  state: AutomationState
  running: boolean
  // Newest first.
  runs: RunRecord[]
}

// What a run is told about itself, as JSON, in the names the user confirmed.
// The skill decides what a window means and can record "data unavailable".
// `local` is ISO 8601 with the offset then ("2026-10-25T02:30+01:00"), so a
// repeated hour when clocks go back is two different values; `utc` is the same
// instant.
export type When = { local: string; utc: string }
export type RunContext = {
  scheduled_for: When
  // The slot before this one (null if there is none) and this one.
  window_start: When | null
  window_end: When
  last_successful_run: { slot: string | null; finished_at: string } | null
  // Older slots that were not run at all and are folded into this run.
  missed_slots: When[]
  missed_slots_omitted?: number
  catch_up: boolean
  time_zone: string
  // Set when the time of day this slot was configured for does not exist on
  // that date (the clocks jump over it). The run is at the moment they jump,
  // which is what scheduled_for says; this is the time that was configured,
  // with the offset in force just before the jump.
  configured_local_time?: string
}

// --- questions from unattended runs -----------------------------------------

// A run can't ask anything, so it can leave a question. The next chat shows
// Claude the open ones; Claude asks briefly and applies the answer.
export const QUESTION_LIMITS = {
  question: 300,
  context: 500,
  option: 60,
  options: 4,
  answer: 500,
  // Per run, open in total, and kept in total.
  perRun: 3,
  open: 50,
  kept: 200,
  // Shown to one chat at a time.
  shown: 5
}

export type PendingQuestion = {
  id: string
  automationId: string
  automationName: string
  runId: string
  // The slot of the run that left it.
  slot?: string
  created: number
  question: string
  // Why it is asked, in the run's words.
  context?: string
  // The note the answer is for, if any.
  path?: string
  options?: string[]
  status: 'open' | 'answered' | 'dismissed'
  answer?: string
  closed?: number
}
