import { actionNotice, type PlayerController } from './controller'

// Presentation only. Refresh uses the controller's existing foreground read,
// overlap guard, call budget and provider cooldown; never a playback fallback.
export function availabilityNotice(c: PlayerController): string {
  const action = actionNotice(c.actionMessage)
  // Preserve pending/uncertain/error action outcomes even during a refresh.
  if (action) return action
  if (c.reading) return 'Checking Spotify…'
  if (c.readIssue) return /rate.?limit|quota|Retry-After/i.test(c.readIssue)
    ? 'Spotify rate limited — wait before refreshing.'
    : 'Could not refresh playback. Try Refresh.'
  const s = c.snapshot
  if (!s) return c.visible ? 'Playback not loaded. Try Refresh.' : ''
  if (c.stale()) return 'Playback status is stale. Try Refresh.'
  if (!s.active || !s.deviceId || s.state === 'unavailable')
    return 'No active Spotify device. Start playback in Spotify, then Refresh.'
  if (s.restricted) return 'Use this device’s own controls.'
  if (s.state === 'unknown') return 'Playback state unknown. Try Refresh.'
  if (!s.music) return 'Music controls unavailable.'
  return ''
}

export function refreshDisabled(c: PlayerController): boolean {
  // Cooldown remains enforced by read(); a click during cooldown makes no API
  // call and displays a rate-limit notice. A stale snapshot must not block reads.
  return c.disposed || !c.visible || !c.ctx.visible || c.reading || c.pending
}
