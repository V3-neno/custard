import { SpotifyApiError, type SpotifyClient } from './client'
import type { PlaybackCommand, Player } from './playback'

// "Accepted" (Spotify returned success) and "verified" (a later read saw the
// expected state) are reported separately. Verification is ONE follow-up read
// after a short delay: no loop, no retry, and never a trigger for another write.
export const timing = { verifyDelayMs: 1000 }

export type VerifyState = 'confirmed' | 'not_observed' | 'inconclusive' | 'not_checked'
export type Verification = { state: VerifyState; detail: string }

const NOTE = 'Single snapshot: Spotify state can lag and other controllers can interfere, so this is neither proof nor disproof. No retry was made; do not repeat the command because of this line.'
// The detail is a sentence fragment: strip any trailing punctuation, then end it with exactly one full stop.
export const verificationLine = (v: Verification): string =>
  `verification: ${v.state} — ${v.detail.replace(/[\s.]+$/, '')}. ${NOTE}`
export const acceptedNote = (v: Verification): string =>
  v.state === 'confirmed' ? 'A follow-up read matched the check below (one snapshot).' : 'Playback has not been verified.'

const result = (state: VerifyState, detail: string): Verification => ({ state, detail })

// Resolves true after the delay, false if cancelled first.
export function pause(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(false); return }
    if (ms <= 0) { resolve(true); return }
    const finish = (waited: boolean): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve(waited)
    }
    const onAbort = (): void => finish(false)
    const timer = setTimeout(() => finish(true), ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

type Observed = { kind: 'player'; player: Player | null } | { kind: 'cancelled' } | { kind: 'error'; message: string }

async function observePlayer(client: SpotifyClient, signal?: AbortSignal): Promise<Observed> {
  if (!(await pause(timing.verifyDelayMs, signal))) return { kind: 'cancelled' }
  try { return { kind: 'player', player: await client.request<Player>('GET', '/me/player', { idempotent: true }) } }
  catch (err) { return { kind: 'error', message: err instanceof SpotifyApiError ? err.message : 'the follow-up read failed' } }
}

function unreadable(seen: Observed): Verification | null {
  if (seen.kind === 'cancelled') return result('not_checked', 'the call was cancelled before the follow-up read')
  if (seen.kind === 'error') return result('inconclusive', `the follow-up read failed (${seen.message})`)
  if (!seen.player?.device) return result('inconclusive', 'Spotify reported no playback device in the follow-up read')
  return null
}

export type Expectation = { volume?: number; position?: number; sentAt: number }

export async function verifyPlayback(
  client: SpotifyClient, signal: AbortSignal | undefined, name: PlaybackCommand, before: Player, expect: Expectation
): Promise<Verification> {
  const seen = await observePlayer(client, signal)
  const bad = unreadable(seen)
  if (bad || seen.kind !== 'player' || !seen.player) return bad ?? result('inconclusive', 'no follow-up snapshot')
  const after = seen.player
  if (after.device?.id !== before.device?.id) return result('inconclusive', 'the active device changed between the command and the follow-up read')
  const beforeUri = before.item?.uri ?? null
  const afterUri = after.item?.uri ?? null
  switch (name) {
    case 'pause_playback':
    case 'resume_playback': {
      if (typeof after.is_playing !== 'boolean') return result('inconclusive', 'Spotify did not report the playing state')
      const wantPlaying = name === 'resume_playback'
      return after.is_playing === wantPlaying
        ? result('confirmed', `reported ${wantPlaying ? 'playing' : 'paused'}`)
        : result('not_observed', `still reported as ${after.is_playing ? 'playing' : 'paused'}`)
    }
    case 'seek': {
      if (!beforeUri || afterUri !== beforeUri) return result('inconclusive', 'the track changed or is unknown, so the position cannot be compared')
      const pos = after.progress_ms
      if (typeof pos !== 'number' || !Number.isFinite(pos)) return result('inconclusive', 'Spotify did not report a position')
      const target = expect.position ?? 0
      const upper = after.is_playing ? Date.now() - expect.sentAt + 3000 : 1500
      const delta = pos - target
      return delta >= -1500 && delta <= upper
        ? result('confirmed', `position ${pos} ms is near the requested ${target} ms`)
        : result('not_observed', `position is ${pos} ms; ${target} ms was requested`)
    }
    case 'adjust_volume': {
      const volume = after.device?.volume_percent
      if (typeof volume !== 'number') return result('inconclusive', 'Spotify did not report the volume')
      return volume === expect.volume
        ? result('confirmed', `volume reported at ${volume}%`)
        : result('not_observed', `volume is reported at ${volume}%; ${expect.volume}% was requested`)
    }
    case 'next_track':
    case 'previous_track': {
      if (!beforeUri || !afterUri) return result('inconclusive', 'the current track was unknown before or after')
      if (afterUri !== beforeUri)
        return result('confirmed', 'the current track now differs from before. Which track it is was not checked, and this does not prove this command caused the change')
      return name === 'next_track'
        ? result('not_observed', 'the same track is still reported (state may lag, or repeat is on)')
        : result('inconclusive', 'the same track is reported; native Previous can restart the current track, or state lagged')
    }
  }
}

export async function verifyTransfer(
  client: SpotifyClient, signal: AbortSignal | undefined, deviceId: string, play: boolean
): Promise<Verification> {
  const seen = await observePlayer(client, signal)
  if (seen.kind === 'cancelled') return result('not_checked', 'the call was cancelled before the follow-up read')
  if (seen.kind === 'error') return result('inconclusive', `the follow-up read failed (${seen.message})`)
  const d = seen.player?.device
  if (!d) return result('not_observed', 'Spotify reports no active device yet')
  if (d.id !== deviceId || d.is_active !== true) return result('not_observed', 'the target is not reported as the active device yet')
  if (play && seen.player?.is_playing !== true) return result('not_observed', 'the target is active but playback is not reported as playing')
  return result('confirmed', play ? 'the target is the active device and reported playing' : 'the target is reported as the active device')
}

// Visible queue as a list of URIs, or null if it could not be read. Best effort.
export async function readQueue(client: SpotifyClient): Promise<string[] | null> {
  try {
    const q = await client.request<{ queue?: { uri?: unknown }[] }>('GET', '/me/player/queue', { idempotent: true })
    if (!q) return null
    return (q.queue ?? []).map((t) => t?.uri).filter((u): u is string => typeof u === 'string')
  } catch { return null }
}

export type QueueEntryStatus = 'new_entry_observed' | 'already_present_ambiguous' | 'visible_no_baseline' | 'not_visible'
export type QueueEntry = { uri: string; status: QueueEntryStatus; positions: number[] }

// accepted: every URI Spotify accepted, in order (duplicates kept).
// before: visible queue before the writes (null if unreadable). after: visible queue afterwards.
export function verifyQueue(accepted: string[], before: string[] | null, after: string[]): { verification: Verification; entries: QueueEntry[] } {
  const occurrences = (list: string[], uri: string): number => list.filter((u) => u === uri).length
  const entries: QueueEntry[] = [...new Set(accepted)].map((uri) => {
    const positions = after.flatMap((u, i) => (u === uri ? [i + 1] : []))
    let status: QueueEntryStatus
    if (positions.length === 0) status = 'not_visible'
    else if (!before) status = 'visible_no_baseline'
    else if (positions.length - occurrences(before, uri) >= occurrences(accepted, uri)) status = 'new_entry_observed'
    else status = 'already_present_ambiguous'
    return { uri, status, positions }
  })
  const fresh = entries.filter((e) => e.status === 'new_entry_observed').length
  const hidden = entries.filter((e) => e.status === 'not_visible').length
  const base = `${fresh} of ${entries.length} distinct accepted tracks newly observed in the visible part of the queue`
  if (entries.length > 0 && fresh === entries.length) return { verification: result('confirmed', base), entries }
  if (entries.length > 0 && hidden === entries.length)
    return { verification: result('not_observed', `${base}. Spotify shows only the next part of the queue, so this does not mean they were not added`), entries }
  return {
    verification: result('inconclusive', `${base}${before ? '' : '; no queue baseline could be read before the writes'}; some entries were already present, hidden or ambiguous`),
    entries
  }
}
