import { BACKGROUND_LIMITS } from '../../shared/plugins'
import type { BackgroundSyncStat } from './host'

// Background sync (docs/plugins/API.md): Custard calls a plugin's
// `background` tool by itself, on the manifest's schedule, while Custard runs.
// No model is involved and the result goes nowhere: what the tool keeps, it
// keeps through ctx.events or ctx.storage. The plugin still runs only inside
// a call, and this is the only thing that starts one without a person or a
// model.
//
// Limits: one call at a time across all plugins; at most
// BACKGROUND_LIMITS.perDay calls a day per plugin; after a failure the wait
// doubles (up to 6 hours) until a call works again.

export const MAX_BACKOFF_MS = 6 * 3_600_000
// After turning on or starting Custard, the first call waits this long.
export const FIRST_DELAY_MS = 60_000

export type SyncPlugin = { id: string; name: string; everyMinutes: number }
export type SyncResult = { ok: boolean; error?: string }

export type SyncDeps = {
  now: () => number
  // The plugins whose sync is on now.
  plugins: () => SyncPlugin[]
  call: (id: string, signal: AbortSignal) => Promise<SyncResult>
  stat: (id: string, s: BackgroundSyncStat) => void
  // A call failed after one that worked (or the first ever): tell the user.
  failed?: (p: SyncPlugin) => void
  day: (t: number) => string
}

type State = { next: number; failures: number }

export class BackgroundSync {
  private state = new Map<string, State>()
  // Calls today per plugin; kept when sync is turned off and on again, so
  // that can't get around the daily limit.
  private counts = new Map<string, { day: string; n: number }>()
  private busy = false
  private timer: ReturnType<typeof setInterval> | null = null
  private abort = new AbortController()

  constructor(private readonly d: SyncDeps) {}

  start(tickMs = 30_000): void {
    this.timer = setInterval(() => void this.tick(), tickMs)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.abort.abort()
  }

  // Looks for a plugin that is due and calls it. Returns when that call ends.
  async tick(): Promise<void> {
    if (this.busy || this.abort.signal.aborted) return
    const now = this.d.now()
    const on = this.d.plugins()
    // Turned off: forget it, so turning it on again starts fresh.
    for (const id of [...this.state.keys()]) if (!on.some((p) => p.id === id)) this.state.delete(id)
    for (const p of on) {
      let s = this.state.get(p.id)
      if (!s) {
        s = { next: now + FIRST_DELAY_MS, failures: 0 }
        this.state.set(p.id, s)
      }
      if (now < s.next || this.today(p.id, now) >= BACKGROUND_LIMITS.perDay) continue
      await this.run(p, s)
      // One call per look, so a slow plugin can't hold up the others for
      // long and nothing runs back to back.
      return
    }
  }

  private today(id: string, now: number): number {
    const c = this.counts.get(id)
    return c && c.day === this.d.day(now) ? c.n : 0
  }

  private async run(p: SyncPlugin, s: State): Promise<void> {
    this.busy = true
    const every = Math.max(BACKGROUND_LIMITS.minMinutes, p.everyMinutes) * 60_000
    let r: SyncResult
    try {
      r = await this.d.call(p.id, this.abort.signal)
    } catch (err) {
      r = { ok: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      this.busy = false
    }
    const now = this.d.now()
    const today = this.today(p.id, now) + 1
    this.counts.set(p.id, { day: this.d.day(now), n: today })
    if (r.ok) {
      s.failures = 0
      s.next = now + every
    } else {
      s.failures++
      s.next = now + Math.min(MAX_BACKOFF_MS, every * 2 ** s.failures)
      if (s.failures === 1) this.d.failed?.(p)
    }
    this.d.stat(p.id, {
      last: now,
      ok: r.ok,
      error: r.ok ? null : (r.error ?? 'It failed.').slice(0, 300),
      today
    })
  }
}
