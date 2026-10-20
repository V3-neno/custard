import type { PlaybackCommand, Player } from './playback'
import { resolveZone, toLocalIso, utcIso } from './time'
import type { Verification } from './verify'

// The playback event log (docs/proposals/spotify-event-log.md): the user's own
// presses in the player and the assistant's playback actions, plus the track
// changes the player's refresh notices, written through ctx.events to one note
// per day in the vault. Custard turns it on (Manage, off by default) and
// formats the entries; this file only decides what an entry says.
//
// Logging never changes a tool's result or what is sent to Spotify: it runs
// after the command and its one verification read, adds no request, and its
// errors are kept here (and in the plugin log), never thrown.

export type Caller = 'assistant' | 'widget' | 'automation' | 'design'
export type EventSink = {
  enabled: boolean
  append(entry: { at: string; record: Record<string, unknown> }): Promise<void>
}
export type LogState = 'on' | 'off' | 'failing'

type Track = { title: string | null; artists: string[]; artist_ids: (string | null)[]; uri: string }
type Seen = Track & { position: number | null; duration: number | null; playing: boolean; at: number }

// Kept in the plugin's sandbox window between calls. A restart (crash, update,
// disable) forgets it: the next refresh only sets a new baseline.
export class EventMemory {
  // What the player's last read saw.
  seen: Seen | null = null
  // The last skip or previous sent, so a track change can name its cause.
  lastSkip: { id: string; at: number; uri: string | null } | null = null
  failing = false
}

export type EventDeps = {
  sink?: EventSink
  caller?: Caller
  memory: EventMemory
  timeZone?: string
  log?: (message: string) => void
}

export const logState = (d: EventDeps | undefined): LogState =>
  !d?.sink?.enabled ? 'off' : d.memory.failing ? 'failing' : 'on'

const TYPE: Record<PlaybackCommand, string> = {
  next_track: 'skip',
  previous_track: 'previous',
  pause_playback: 'pause',
  resume_playback: 'resume',
  seek: 'seek',
  adjust_volume: 'volume'
}
// A track that ended within this much of its end counts as played through.
const END_SLACK_MS = 5000
const TRACK_URI = /^spotify:track:[0-9A-Za-z]{22}$/
const ARTIST_ID = /^[0-9A-Za-z]{22}$/
const validMs = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0

const newId = (): string => `e_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

function stamp(ms: number, timeZone: string | undefined): { at_utc: string; at_local: string | null } {
  return { at_utc: utcIso(ms), at_local: toLocalIso(ms, resolveZone(timeZone).zone) }
}

function trackOf(p: Player | null | undefined): Track | null {
  const item = p?.item
  if (!item?.uri || !TRACK_URI.test(item.uri)) return null
  return {
    title: item.name ?? null,
    artists: (item.artists ?? []).map((a) => a.name),
    artist_ids: (item.artists ?? []).map((a) => (typeof a.id === 'string' && ARTIST_ID.test(a.id) ? a.id : null)),
    uri: item.uri
  }
}

const deviceOf = (p: Player | null | undefined): { name: string | null; type: string | null } | null =>
  p?.device ? { name: p.device.name ?? null, type: p.device.type ?? null } : null

async function write(d: EventDeps, at: number, record: Record<string, unknown>): Promise<void> {
  if (!d.sink?.enabled) return
  try {
    await d.sink.append({ at: utcIso(at), record })
    d.memory.failing = false
  } catch (err) {
    d.memory.failing = true
    d.log?.(`event log: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// Only the user's presses and the assistant's calls are logged; automations
// and Design never run playback actions.
const fromPerson = (c: Caller | undefined): c is 'widget' | 'assistant' => c === 'widget' || c === 'assistant'

// A playback command Spotify accepted, or one sent whose answer was lost.
// Not for a command that was refused, rejected or never sent.
export async function logCommand(d: EventDeps | undefined, c: {
  name: PlaybackCommand
  before: Player
  sentAt: number
  outcome: 'accepted' | 'unknown'
  verification?: Verification
  toMs?: number
  volume?: { from: number; to: number }
}): Promise<void> {
  if (!d || !fromPerson(d.caller)) return
  const track = trackOf(c.before)
  const type = c.name === 'seek' && c.toMs === 0 ? 'restart' : TYPE[c.name]
  const id = newId()
  if (c.name === 'next_track' || c.name === 'previous_track')
    d.memory.lastSkip = { id, at: c.sentAt, uri: track?.uri ?? null }
  await write(d, c.sentAt, {
    v: 1,
    id,
    type,
    ...stamp(c.sentAt, d.timeZone),
    source: d.caller,
    track,
    position_ms: validMs(c.before.progress_ms) ? c.before.progress_ms : null,
    duration_ms: validMs(c.before.item?.duration_ms) ? c.before.item!.duration_ms : null,
    device: deviceOf(c.before),
    outcome: c.outcome,
    verification: c.verification?.state ?? 'not_checked',
    ...(type === 'seek' ? { to_ms: c.toMs ?? null } : {}),
    ...(c.volume ? { from_percent: c.volume.from, to_percent: c.volume.to } : {})
  })
}

// Tracks Spotify accepted into the queue (and ones whose answer was lost).
export async function logQueue(d: EventDeps | undefined, c: {
  sentAt: number
  accepted: string[]
  unknown: string[]
  verification?: Verification
}): Promise<void> {
  if (!d || !fromPerson(d.caller) || (!c.accepted.length && !c.unknown.length)) return
  await write(d, c.sentAt, {
    v: 1,
    id: newId(),
    type: 'queue_add',
    ...stamp(c.sentAt, d.timeZone),
    source: d.caller,
    track: null,
    position_ms: null,
    duration_ms: null,
    device: null,
    outcome: c.accepted.length ? 'accepted' : 'unknown',
    verification: c.verification?.state ?? 'not_checked',
    uris: c.accepted,
    ...(c.unknown.length ? { unknown_uris: c.unknown } : {})
  })
}

// A read by the player widget (its refresh, or its Refresh button). Notices a
// track change since the player's last read. Reads by the assistant never log
// and never move the baseline, so the assistant can't make entries by reading.
export async function observe(d: EventDeps | undefined, p: Player | null, at: number): Promise<void> {
  if (!d || d.caller !== 'widget') return
  const track = trackOf(p)
  // Nothing playing: keep the baseline, so a pause in between doesn't hide a change.
  if (!track) return
  const prev = d.memory.seen
  d.memory.seen = {
    ...track,
    position: validMs(p?.progress_ms) ? p!.progress_ms : null,
    duration: validMs(p?.item?.duration_ms) ? p!.item!.duration_ms! : null,
    playing: p?.is_playing === true,
    at
  }
  if (!prev || prev.uri === track.uri) return
  // Where the previous track had got to: its last position, plus the time it
  // was playing since, never past its end.
  const ran = prev.playing ? Math.max(0, at - prev.at) : 0
  const last = prev.position === null ? null : Math.min(prev.position + ran, prev.duration ?? Infinity)
  const skip = d.memory.lastSkip
  const byAction = !!skip && skip.uri === prev.uri && skip.at >= prev.at - 1000 && skip.at <= at
  const ended = !byAction && last !== null && prev.duration !== null && prev.duration - last <= END_SLACK_MS
  await write(d, at, {
    v: 1,
    id: newId(),
    type: 'track_change',
    ...stamp(at, d.timeZone),
    source: 'widget',
    track,
    position_ms: validMs(p?.progress_ms) ? p!.progress_ms : null,
    duration_ms: validMs(p?.item?.duration_ms) ? p!.item!.duration_ms : null,
    device: deviceOf(p),
    outcome: 'observed',
    verification: 'not_checked',
    previous: {
      track: { title: prev.title, artists: prev.artists, artist_ids: prev.artist_ids, uri: prev.uri },
      last_position_ms: last,
      position_estimated: prev.playing,
      last_seen_utc: utcIso(prev.at)
    },
    cause: byAction ? 'logged_action' : ended ? 'likely_ended' : 'unknown',
    ...(byAction ? { cause_id: skip!.id } : {})
  })
}
