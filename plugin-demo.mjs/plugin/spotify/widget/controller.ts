import type { WidgetCallResult, WidgetContext } from 'custard-plugin-sdk/widget'
import { readSnapshot, type Snapshot } from '../src/widget-data'

export const STALE_MS = 45000
export const HEIGHT = { compact: 240, expanded: 330 } as const
export type Action = 'next_track' | 'pause_playback' | 'resume_playback' | 'seek' | 'adjust_volume'
export const BACK_REASON = 'Back unavailable: reliable history of the song actually just heard is not implemented.'
export const SEEK_WARNING = 'Seek targets the current track after approval, not a guaranteed track identity. A track change during approval may change its target.'

export function outcome(r: WidgetCallResult): WidgetCallResult['status'] {
  if (r.status === 'unknown' || /^Outcome unknown:/i.test(r.content)) return 'unknown'
  if (r.status === 'not-run' || /^Not run:/i.test(r.content)) return 'not-run'
  return r.status
}

// Routine successes are silent. Never render raw provider/tool text in the player.
export function actionNotice(message: string): string {
  if (/^Pending/.test(message)) return 'Waiting for approval…'
  if (/^Outcome unknown/.test(message)) return 'Result unknown — check Spotify before trying again.'
  if (/^Not run/.test(message)) return 'Action not run.'
  if (/^Failed/.test(message)) return 'Action failed. Check Spotify or your connection.'
  return ''
}

export class PlayerController {
  snapshot: Snapshot | null = null
  reading = false
  pending = false
  visible = false
  disposed = false
  readIssue = ''
  actionMessage = ''
  private generation = 0
  private calls: number[] = []
  private blockedUntil = 0
  constructor(readonly ctx: WidgetContext, private changed: () => void, readonly now = () => Date.now()) {}

  stale(): boolean {
    return !this.snapshot || !!this.readIssue || this.now() - this.snapshot.observedAt > STALE_MS
  }
  position(): number | null {
    const s = this.snapshot
    if (!s || s.position === null) return null
    const elapsed = this.visible && s.state === 'playing' && !this.stale() ? Math.max(0, this.now() - s.observedAt) : 0
    return Math.min(s.duration ?? Number.MAX_SAFE_INTEGER, s.position + elapsed)
  }
  private capacity(reserve = 1): boolean {
    this.calls = this.calls.filter((t) => this.now() - t < 60000)
    return this.now() >= this.blockedUntil && this.calls.length + reserve <= 24
  }
  private cooldown(content: string): void {
    if (/rate.?limit|quota|Retry-After/i.test(content)) {
      const seconds = Number(/Retry-After:\s*(\d+(?:\.\d+)?)/i.exec(content)?.[1] ?? 60)
      this.blockedUntil = Math.max(this.blockedUntil, this.now() + Math.max(60, seconds) * 1000)
    }
  }
  can(action: Action): boolean {
    const s = this.snapshot
    if (!this.visible || !this.ctx.visible || this.disposed || this.pending || this.reading || this.stale() ||
        !s || !s.active || !s.deviceId || s.restricted || !this.capacity(2)) return false
    if (action === 'adjust_volume') return s.volumeSupported === true && s.volume !== null && s.volume !== undefined
    if (!s.music || !s.trackUri || (s.state !== 'playing' && s.state !== 'paused')) return false
    if (action === 'seek') return s.actions.seek && s.duration !== null && s.duration > 0 && s.position !== null
    if (action === 'pause_playback') return s.actions.pause && s.state === 'playing'
    if (action === 'resume_playback') return s.actions.resume && s.state === 'paused'
    return s.actions.next
  }
  stateLabel(): string {
    const s = this.snapshot
    if (this.pending) return 'Pending — awaiting approval or Spotify response'
    if (this.reading) return s ? 'Refreshing playback…' : 'Loading playback…'
    if (this.readIssue) return `${s ? 'Stale snapshot — ' : 'Unavailable — '}${this.readIssue}`
    if (!s) return this.visible ? 'Playback unavailable' : 'Waiting until visible'
    if (this.stale()) return 'Stale snapshot — controls disabled until refreshed'
    if (s.restricted) return 'Restricted device — use its own controls'
    if (!s.active || s.state === 'unavailable') return 'Playback unavailable — no active device'
    if (!s.music) return 'Unsupported content — music controls disabled'
    if (s.state === 'unknown') return 'Playback state unknown — controls disabled'
    if (!this.capacity()) return 'Rate limited — waiting for a foreground refresh'
    return s.state === 'playing' ? 'Playing · estimated progress between snapshots' : 'Paused'
  }
  // Only actionable concise notices appear in the UI; stateLabel remains diagnostic.
  displayNotice(): string {
    const action = actionNotice(this.actionMessage)
    if (action) return action
    if (!this.snapshot) return this.reading ? 'Loading…' : 'Playback unavailable.'
    if (this.stale()) return 'Connection stale — controls unavailable.'
    if (this.snapshot.restricted) return 'Use this device’s own controls.'
    if (!this.snapshot.active) return 'No active Spotify device.'
    if (!this.snapshot.music) return 'Music controls unavailable.'
    return ''
  }
  setVisible(visible: boolean): void {
    this.visible = visible
    this.generation++
    this.changed()
    if (visible && !this.disposed) void this.read()
  }
  async read(): Promise<void> {
    if (this.disposed || !this.visible || !this.ctx.visible || this.reading || this.pending) return
    if (!this.capacity()) {
      this.readIssue = 'Rate limited; waiting before the next foreground refresh.'
      this.changed()
      return
    }
    this.reading = true
    const generation = this.generation
    this.calls.push(this.now())
    this.changed()
    try {
      const r = await this.ctx.call('now_playing', {})
      if (this.disposed || !this.visible || generation !== this.generation) return
      this.cooldown(r.content)
      const s = r.status === 'completed' ? readSnapshot(r.data) : null
      if (!s || s.observedAt > this.now() + 5000) {
        this.readIssue = `${r.status}: ${r.content.slice(0, 600) || 'Missing or invalid playback data'}`
      } else {
        this.snapshot = s
        this.readIssue = ''
      }
    } catch {
      if (!this.disposed && this.visible && generation === this.generation) this.readIssue = 'Playback read failed. No playback action was sent.'
    } finally {
      this.reading = false
      if (!this.disposed) this.changed()
    }
  }
  // Synchronous gesture -> bridge write; never a timer/preliminary read.
  // value is milliseconds for seek, signed percentage-point delta for volume.
  async action(action: Action, value?: number): Promise<void> {
    if (!this.can(action)) return
    const s = this.snapshot!
    if (action === 'seek' && (!Number.isSafeInteger(value) || value! < 0 || s.duration === null || value! >= s.duration)) {
      this.actionMessage = 'Not run: seek must be inside a track with known duration.'
      this.changed()
      return
    }
    if (action === 'adjust_volume') {
      if (!Number.isInteger(value) || value === 0 || Math.abs(value!) > 100) return
      if ((value! < 0 && s.volume === 0) || (value! > 0 && s.volume === 100)) return
    }
    this.pending = true
    this.generation++
    this.actionMessage = 'Pending — use Custard’s approval card if shown.'
    this.calls.push(this.now())
    this.changed()
    let check = false
    try {
      const input: Record<string, unknown> = { device_id: s.deviceId }
      if (action === 'seek') input.position_ms = value
      if (action === 'adjust_volume') {
        input.direction = value! > 0 ? 'raise' : 'lower'
        input.amount_percent = Math.abs(value!)
      }
      const r = await this.ctx.call(action, input)
      if (this.disposed) return
      const status = outcome(r)
      this.cooldown(r.content)
      check = status === 'completed' || status === 'unknown'
      const label = status === 'completed' ? 'Completed tool call (not playback verification)' :
        status === 'unknown' ? 'Outcome unknown — do not blindly repeat' :
        status === 'not-run' ? 'Not run — declined or refused' : 'Failed'
      this.actionMessage = `${label}: ${r.content.slice(0, 900)}`
    } catch {
      this.actionMessage = 'Outcome unknown: bridge response lost. Do not blindly repeat.'
      check = true
    } finally {
      this.pending = false
      if (!this.disposed) this.changed()
    }
    if (!this.disposed && check && this.visible && this.ctx.visible) await this.read()
  }
  dispose(): void {
    this.disposed = true
    this.visible = false
    this.generation++
  }
}
