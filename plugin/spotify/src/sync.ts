import type { Caller, EventSink } from './events'
import type { SpotifyClient } from './client'
import { trackOf } from './history'
import { parseInstant, resolveZone, toLocalIso, utcIso } from './time'

// Background sync (Custard's manifest `background`, docs/plugins/API.md):
// every 30 minutes while Custard runs and the user has turned it on, Custard
// calls sync_recent by itself. It reads the plays Spotify already keeps
// (GET /me/player/recently-played, the last 50) and adds the new ones to the
// event log as `played` entries, so listening history is kept while the
// player is closed. One request per call; it never reads or polls playback.
//
// Where it got to is kept in ctx.storage, so a restart doesn't log a play
// twice. The event log takes entries from the last 24 hours only, and 20 per
// call: older plays are not logged, and a longer backlog goes in the next calls.

type Result = { content: string; isError: boolean }
type Rec = Record<string, unknown>
const rec = (v: unknown): Rec => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {})
const clip = (v: unknown, max: number): string | null => (typeof v === 'string' ? v.slice(0, max) : null)

export const SYNC_KEY = 'recent_synced_until'
// Inside the event log's 24-hour window, with room for a slow call.
export const SYNC_WINDOW_MS = 23 * 3_600_000
// The event log's limit on entries per call.
export const SYNC_PER_CALL = 20

export type SyncDeps = {
  client: SpotifyClient
  caller?: Caller
  sink?: EventSink
  storage: { get<T = unknown>(key: string): Promise<T | undefined>; set(key: string, value: unknown): Promise<void> }
  timeZone?: string
  now?: () => number
}

export async function syncRecent(d: SyncDeps): Promise<Result> {
  // Custard's schedule only: the assistant has recently_played for questions.
  if (d.caller !== 'background')
    return { content: 'sync_recent is run only by Custard\'s background sync. Use recently_played to read listening history.', isError: true }
  if (!d.sink?.enabled)
    return { content: 'The event log is off, so there is nothing to sync into. Turn it on in Manage.', isError: true }
  const now = (d.now ?? Date.now)()
  const saved = await d.storage.get<number>(SYNC_KEY)
  const floor = now - SYNC_WINDOW_MS
  const after = typeof saved === 'number' && Number.isSafeInteger(saved) && saved > floor ? saved : floor
  const data = await d.client.request<{ items?: unknown[] }>('GET', '/me/player/recently-played', {
    query: { limit: 50, after },
    idempotent: true
  })
  const zone = resolveZone(d.timeZone).zone
  const plays = (data?.items ?? [])
    .map((raw) => {
      const e = rec(raw)
      const track = rec(e.track)
      const ms = parseInstant(e.played_at)
      return { ms, track, context: rec(e.context) }
    })
    .filter((p): p is { ms: number; track: Rec; context: Rec } =>
      p.ms !== null && p.ms > after && p.ms <= now && typeof p.track.uri === 'string' && p.track.uri.startsWith('spotify:track:'))
    .sort((a, b) => a.ms - b.ms)
  const batch = plays.slice(0, SYNC_PER_CALL)
  let until = after
  let logged = 0
  for (const p of batch) {
    try {
      await d.sink.append({
        at: utcIso(p.ms),
        record: {
          v: 1,
          id: `p_${p.ms.toString(36)}`,
          type: 'played',
          at_utc: utcIso(p.ms),
          at_local: toLocalIso(p.ms, zone),
          source: 'recently_played',
          track: trackOf(p.track),
          context: typeof p.context.type === 'string' ? { type: clip(p.context.type, 40), uri: clip(p.context.uri, 100) } : null
        }
      })
    } catch (err) {
      // Stop here; the next call starts from the last play that was logged.
      if (logged) await d.storage.set(SYNC_KEY, until)
      return { content: `Logged ${logged} plays, then the event log refused one: ${err instanceof Error ? err.message : String(err)}`, isError: true }
    }
    until = p.ms
    logged++
  }
  await d.storage.set(SYNC_KEY, until)
  const left = plays.length - batch.length
  return {
    content: logged
      ? `Logged ${logged} recently played ${logged === 1 ? 'track' : 'tracks'} to the event log${left ? `; ${left} more next time` : ''}.`
      : 'No new plays since the last sync.',
    isError: false
  }
}
