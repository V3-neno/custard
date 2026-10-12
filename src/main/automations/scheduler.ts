import { randomUUID } from 'crypto'
import type { Automation, RunRecord } from '../../shared/automations'
import { localDay, slotsBetween } from './schedule'
import {
  addRun,
  closeInterrupted,
  loadRuns,
  updateRun,
  updateState,
  type RunsFile
} from './records'

// A slot more than this late (Custard was closed or busy) is not run: catch-up
// is a later step. It is recorded as skipped instead.
export const GRACE_MS = 10 * 60_000

export type RunResult = {
  status: 'completed' | 'failed' | 'stopped'
  reason?: string
  calls: RunRecord['calls']
  changes: RunRecord['changes']
  summary?: string
}

export type SchedulerDeps = {
  dir: string
  now: () => number
  list: () => Automation[]
  // Runs one automation to the end. It never throws; it reports how it ended.
  run: (a: Automation, slot: string | undefined, signal: AbortSignal) => Promise<RunResult>
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
        if (late.length)
          this.skip(
            a,
            late[late.length - 1].label,
            `${late.length === 1 ? 'A scheduled run was' : `${late.length} scheduled runs were`} missed because Custard was closed or busy.`
          )
        for (const s of due) this.enqueue(a.id, s.label, 'scheduled')
      } else updateState(this.d.dir, a.id, { checkedUntil: now })
    }
  }

  // The user's Run now.
  runNow(id: string): boolean {
    if (!this.d.list().some((a) => a.id === id)) return false
    if (this.pending.has(id)) return false
    this.enqueue(id, undefined, 'manual')
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

  private enqueue(id: string, slot: string | undefined, kind: RunRecord['kind']): void {
    if (kind === 'manual') this.pending.add(id)
    this.queue = this.queue
      .then(() => this.runOne(id, slot, kind))
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
    slot: string | undefined,
    kind: RunRecord['kind']
  ): Promise<void> {
    // Looked up again: it may have been paused, changed or deleted while queued.
    const a = this.d.list().find((x) => x.id === id)
    if (!a || this.abort.signal.aborted) return
    const f = loadRuns(this.d.dir, id)
    if (kind === 'scheduled') {
      if (!a.enabled || f.state.paused) return
      if (this.countToday(f, a) >= a.limits.runsPerDay)
        return this.skip(a, slot, `The limit of ${a.limits.runsPerDay} runs a day was reached.`)
    }
    const run: RunRecord = {
      id: randomUUID(),
      automationId: id,
      kind,
      ...(slot ? { slot } : {}),
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
      result = await this.d.run(a, slot, this.abort.signal)
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
