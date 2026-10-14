import { randomUUID } from 'crypto'
import type { Automation, RunContext, RunRecord } from '../../shared/automations'
import { buildContext } from './context'
import { localDay, slotsBetween, type Slot } from './schedule'
import {
  addRun,
  closeInterrupted,
  loadRuns,
  updateRun,
  updateState,
  type RunsFile
} from './records'

// A slot more than this late (Custard was closed or busy) is a catch-up: it
// runs late, flagged as such, up to the automation's limit.
export const GRACE_MS = 10 * 60_000

export type RunResult = {
  status: 'completed' | 'failed' | 'stopped'
  reason?: string
  calls: RunRecord['calls']
  changes: RunRecord['changes']
  summary?: string
  questions?: string[]
}

export type SchedulerDeps = {
  dir: string
  now: () => number
  list: () => Automation[]
  // Runs one automation to the end. It never throws; it reports how it ended.
  run: (
    a: Automation,
    slot: string | undefined,
    signal: AbortSignal,
    ctx: RunContext,
    runId: string
  ) => Promise<RunResult>
  // Called when a record changes, so the window can refresh.
  changed?: () => void
}

// Fires automations at their slots while Custard is open. Runs go one at a
// time, in the order their slots fell due.
export class Scheduler {
  private queue: Promise<void> = Promise.resolve()
  private timer: ReturnType<typeof setInterval> | null = null
  private abort = new AbortController()
  private active = new Set<string>()
  // Queued or running, so Run now can't pile up on itself.
  private pending = new Set<string>()

  constructor(private readonly d: SchedulerDeps) {}

  start(tickMs = 20_000): void {
    for (const a of this.d.list()) closeInterrupted(this.d.dir, a.id, this.d.now())
    this.tick()
    this.timer = setInterval(() => this.tick(), tickMs)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.abort.abort()
  }

  running(id: string): boolean {
    return this.active.has(id)
  }

  // Whether any run is going on now.
  busy(): boolean {
    return this.active.size > 0
  }

  // Looks for slots that fell due since the last look.
  tick(): void {
    const now = this.d.now()
    for (const a of this.d.list()) {
      const f = loadRuns(this.d.dir, a.id)
      // Nothing before the first look counts: a new automation starts now.
      const from = f.state.checkedUntil ?? now
      // The window is closed before anything runs, so a slot can only ever be
      // picked up once, even if Custard closes in the middle of its run.
      if (a.enabled && !f.state.paused) {
        const slots = slotsBetween(a, from, now)
        const late = slots.filter((s) => now - s.instant > GRACE_MS)
        const due = slots.filter((s) => now - s.instant <= GRACE_MS)
        updateState(this.d.dir, a.id, { checkedUntil: now })
        // The newest few missed slots run, oldest first. Older ones are not
        // run: they are folded into the first catch-up run's context and
        // noted, never dropped silently.
        const keep = Math.min(late.length, a.limits.catchUpRuns)
        const folded = late.slice(0, late.length - keep)
        const catching = late.slice(late.length - keep)
        if (!keep && late.length)
          this.skip(
            a,
            late[late.length - 1].label,
            `${late.length === 1 ? 'A scheduled run was' : `${late.length} scheduled runs were`} missed because Custard was closed or busy, and catch-up is off for this automation.`
          )
        else if (folded.length)
          this.skip(
            a,
            folded[folded.length - 1].label,
            `${folded.length === 1 ? 'An older scheduled run was' : `${folded.length} older scheduled runs were`} missed and not run. ${folded.length === 1 ? 'It is' : 'They are'} listed in the context of the catch-up run for ${catching[0].label}.`
          )
        catching.forEach((s, i) =>
          this.enqueue(a.id, s, 'scheduled', { catchUp: true, folded: i === 0 ? folded : [] })
        )
        for (const s of due) this.enqueue(a.id, s, 'scheduled', { catchUp: false, folded: [] })
      } else updateState(this.d.dir, a.id, { checkedUntil: now })
    }
  }

  // The user's Run now.
  runNow(id: string): boolean {
    if (!this.d.list().some((a) => a.id === id)) return false
    if (this.pending.has(id)) return false
    this.enqueue(id, undefined, 'manual', { catchUp: false, folded: [] })
    return true
  }

  private skip(a: Automation, slot: string | undefined, reason: string): void {
    const t = this.d.now()
    addRun(this.d.dir, a.id, {
      id: randomUUID(),
      automationId: a.id,
      kind: 'scheduled',
      ...(slot ? { slot } : {}),
      startedAt: t,
      endedAt: t,
      status: 'skipped',
      reason,
      calls: [],
      changes: []
    })
    this.d.changed?.()
  }

  private enqueue(
    id: string,
    slot: Slot | undefined,
    kind: RunRecord['kind'],
    how: { catchUp: boolean; folded: Slot[] }
  ): void {
    if (kind === 'manual') this.pending.add(id)
    this.queue = this.queue
      .then(() => this.runOne(id, slot, kind, how))
      .catch(() => {})
      .finally(() => this.pending.delete(id))
  }

  private countToday(f: RunsFile, a: Automation): number {
    const today = localDay(this.d.now(), a.timezone)
    return f.runs.filter(
      (r) =>
        r.kind === 'scheduled' &&
        r.status !== 'skipped' &&
        localDay(r.startedAt, a.timezone) === today
    ).length
  }

  private async runOne(
    id: string,
    slot: Slot | undefined,
    kind: RunRecord['kind'],
    how: { catchUp: boolean; folded: Slot[] }
  ): Promise<void> {
    // Looked up again: it may have been paused, changed or deleted while queued.
    const a = this.d.list().find((x) => x.id === id)
    if (!a || this.abort.signal.aborted) return
    const f = loadRuns(this.d.dir, id)
    if (kind === 'scheduled') {
      if (!a.enabled || f.state.paused) return
      if (this.countToday(f, a) >= a.limits.runsPerDay)
        return this.skip(
          a,
          slot?.label,
          `The limit of ${a.limits.runsPerDay} runs a day was reached.`
        )
    }
    const run: RunRecord = {
      id: randomUUID(),
      automationId: id,
      kind,
      ...(slot ? { slot: slot.label, slotAt: slot.instant } : {}),
      ...(how.catchUp ? { catchUp: true } : {}),
      startedAt: this.d.now(),
      status: 'running',
      calls: [],
      changes: []
    }
    addRun(this.d.dir, id, run)
    this.active.add(id)
    this.d.changed?.()
    let result: RunResult
    try {
      const ctx = buildContext(a, {
        slot,
        now: this.d.now(),
        catchUp: how.catchUp,
        folded: how.folded,
        // Before this run was added, so it can't be its own last success.
        runs: f.runs
      })
      result = await this.d.run(a, slot?.label, this.abort.signal, ctx, run.id)
    } catch (err) {
      result = {
        status: 'failed',
        reason: err instanceof Error ? err.message : String(err),
        calls: [],
        changes: []
      }
    }
    this.active.delete(id)
    updateRun(this.d.dir, id, run.id, { ...result, endedAt: this.d.now() })
    const state = loadRuns(this.d.dir, id).state
    if (result.status === 'completed') updateState(this.d.dir, id, { failures: 0 })
    else if (result.status === 'failed' && kind === 'scheduled') {
      const failures = state.failures + 1
      updateState(this.d.dir, id, {
        failures,
        ...(failures >= a.limits.failuresBeforePause
          ? {
              paused: {
                reason: `Paused after ${failures} failed runs in a row. Last: ${result.reason ?? 'unknown'}`,
                time: this.d.now()
              }
            }
          : {})
      })
    }
    this.d.changed?.()
  }

  // Resumes a paused automation; the failures start over.
  resume(id: string): void {
    updateState(this.d.dir, id, { paused: undefined, failures: 0, checkedUntil: this.d.now() })
  }

  pause(id: string, reason = 'Paused by you.'): void {
    updateState(this.d.dir, id, { paused: { reason, time: this.d.now() } })
  }

  // Waits for queued runs (tests).
  async idle(): Promise<void> {
    await this.queue
  }
}
