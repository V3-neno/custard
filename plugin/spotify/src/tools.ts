import { PluginError } from 'custard-plugin-sdk'
import { SpotifyApiError, type SpotifyClient } from './client'
import { playbackCommand, playbackMetadata, type Player } from './playback'

// Opening, queueing, transferring and individual playback commands are separate.
// None implicitly invokes another.
type Artist = { name: string }
type Track = {
  uri: string
  name: string
  artists: Artist[]
  album?: { name: string; release_date?: string }
  explicit?: boolean
  duration_ms?: number
  is_playable?: boolean
}
type Device = {
  id: string | null
  name: string
  type: string
  is_active: boolean
  is_restricted: boolean
  volume_percent?: number | null
}

const TRACK_URI = /^spotify:track:[0-9A-Za-z]{22}$/
const PAGE_URI = /^spotify:(track|album|artist|playlist):[0-9A-Za-z]{22}$/
const describe = (t: Track): string => `${t.name} by ${t.artists.map((a) => a.name).join(', ')}`
const minutes = (ms = 0): string =>
  `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`

// Only Spotify-returned URIs may be queued in this app session.
export class SeenTracks {
  private map = new Map<string, string>()
  add(t: Track): void {
    this.map.delete(t.uri)
    this.map.set(t.uri, describe(t))
    if (this.map.size > 2000) this.map.delete(this.map.keys().next().value!)
  }
  get(uri: string): string | undefined { return this.map.get(uri) }
}

export type SpotifyDeps = {
  client: SpotifyClient
  seen: SeenTracks
  openExternal: (url: string) => Promise<void>
  signal?: AbortSignal
}
export type ToolResult = { content: string; isError: boolean }
const ok = (content: string): ToolResult => ({ content, isError: false })
const fail = (content: string): ToolResult => ({ content, isError: true })

async function search(deps: SpotifyDeps, input: Record<string, unknown>): Promise<ToolResult> {
  const query = typeof input.query === 'string' ? input.query.trim() : ''
  if (!query) return fail('A search query is required.')
  const limit = Math.min(10, Math.max(1, Math.round(Number(input.limit) || 5)))
  const data = await deps.client.request<{ tracks?: { items: (Track | null)[] } }>(
    'GET', '/search', { query: { q: query, type: 'track', limit }, idempotent: true }
  )
  const tracks = (data?.tracks?.items ?? []).filter((t): t is Track => !!t?.uri)
  if (tracks.length === 0) return ok(`No Spotify tracks found for "${query}".`)
  tracks.forEach((t) => deps.seen.add(t))
  return ok(tracks.map((t, i) => [
    `${i + 1}. ${t.name}`,
    `   artists: ${t.artists.map((a) => a.name).join(', ')}`,
    t.album ? `   album: ${t.album.name}${t.album.release_date ? ` (${t.album.release_date.slice(0, 4)})` : ''}` : '',
    `   explicit: ${t.explicit ? 'yes' : 'no'}, length: ${minutes(t.duration_ms)}`,
    t.is_playable === false ? '   not playable in your country' : '',
    `   uri: ${t.uri}`
  ].filter(Boolean).join('\n')).join('\n'))
}

async function nowPlaying(deps: SpotifyDeps): Promise<ToolResult> {
  const p = await deps.client.request<Player>('GET', '/me/player', { idempotent: true })
  const metadata = playbackMetadata(p)
  const lines: string[] = []
  // Preserve the existing human-readable lines, with an additive JSON snapshot.
  if (!p || !p.device) lines.push('Nothing is playing and no Spotify device is active.')
  else {
    lines.push(`device: ${p.device.name} (${p.device.type})`, `state: ${p.is_playing ? 'playing' : 'paused'}`)
  }
  if (metadata.track) {
    const t = metadata.track
    if (t.uri && t.title !== null) deps.seen.add({ uri: t.uri, name: t.title, artists: t.artists.map((name) => ({ name })) })
    lines.push(
      `track: ${t.title ?? 'Unknown'} by ${t.artists.join(', ')}`,
      t.album ? `album: ${t.album}` : '',
      `position: ${minutes(metadata.position_ms ?? 0)} of ${minutes(metadata.duration_ms ?? 0)}`,
      `uri: ${t.uri}`
    )
  } else if (p?.currently_playing_type && p.currently_playing_type !== 'track') {
    lines.push(`playing: a ${p.currently_playing_type}, not a music track`)
  }
  if (p?.shuffle_state !== undefined) lines.push(`shuffle: ${p.shuffle_state ? 'on' : 'off'}`)
  lines.push(`playback_metadata: ${JSON.stringify(metadata)}`)
  return ok(lines.filter(Boolean).join('\n'))
}

async function devices(deps: SpotifyDeps): Promise<ToolResult> {
  const data = await deps.client.request<{ devices: Device[] }>('GET', '/me/player/devices', { idempotent: true })
  const list = data?.devices ?? []
  if (list.length === 0) return ok('No Spotify devices are available. The user needs to open Spotify somewhere (spotify__open can open it on this computer).')
  return ok(list.map((d) => `- ${d.name} (${d.type})${d.is_active ? ', active' : ''}${d.is_restricted ? ', restricted: cannot be controlled' : ''}, id: ${d.id ?? 'none'}`).join('\n'))
}

type QueueOutcome = { uri: string; status: 'queued' | 'failed' | 'unknown' | 'skipped'; note?: string }

// Ordered, non-retrying queue writes. Existing partial-success behavior retained.
async function addToQueue(deps: SpotifyDeps, input: Record<string, unknown>): Promise<ToolResult> {
  const uris = Array.isArray(input.uris) ? input.uris : []
  if (uris.length === 0) return fail('Give at least one track URI.')
  if (uris.length > 10) return fail('Queue at most 10 tracks per call.')
  const deviceId = typeof input.device_id === 'string' && input.device_id ? input.device_id : undefined
  const invalid = uris.filter((u) => typeof u !== 'string' || !TRACK_URI.test(u))
  if (invalid.length) return fail(`Not Spotify track URIs: ${invalid.join(', ')}. Nothing was queued.`)
  const unseen = (uris as string[]).filter((u) => !deps.seen.get(u))
  if (unseen.length) return fail(`These URIs didn't come from a Spotify search in this session: ${unseen.join(', ')}. Find them with spotify__search first. Nothing was queued.`)
  const outcomes: QueueOutcome[] = []
  let stopped: string | null = null
  for (const uri of uris as string[]) {
    if (stopped) { outcomes.push({ uri, status: 'skipped' }); continue }
    try {
      await deps.client.request('POST', '/me/player/queue', { query: { uri, device_id: deviceId } })
      outcomes.push({ uri, status: 'queued' })
    } catch (err) {
      if (err instanceof SpotifyApiError) {
        if (err.status === 400 || (err.status === 404 && !/device/i.test(err.message))) {
          outcomes.push({ uri, status: 'failed', note: err.message }); continue
        }
        if (err.status >= 500) {
          outcomes.push({ uri, status: 'unknown', note: 'Spotify had a server error; it may or may not have been added' })
          stopped = 'Stopped after a Spotify server error rather than risk adding songs twice.'
          continue
        }
        outcomes.push({ uri, status: 'failed', note: err.message })
        stopped = err.message
      } else {
        outcomes.push({ uri, status: 'unknown', note: 'the connection failed; it may or may not have been added' })
        stopped = 'Stopped after a connection error rather than risk adding songs twice.'
      }
    }
  }
  const queued = outcomes.filter((o) => o.status === 'queued').length
  let check = ''
  if (queued > 0) {
    try {
      const q = await deps.client.request<{ queue?: { uri: string }[] }>('GET', '/me/player/queue', { idempotent: true })
      const inQueue = new Set((q?.queue ?? []).map((t) => t.uri))
      const shown = outcomes.filter((o) => o.status === 'queued' && inQueue.has(o.uri)).length
      check = `Spotify's queue now lists ${shown} of the ${queued} accepted tracks${shown < queued ? ' (it only shows the next part of the queue, so the rest may still be further down)' : ''}.`
    } catch { check = "Couldn't read the queue back to double-check." }
  }
  const label: Record<QueueOutcome['status'], string> = { queued: 'added to queue', failed: 'not added', unknown: 'unknown', skipped: 'not attempted' }
  const lines = outcomes.map((o, i) => `${i + 1}. ${deps.seen.get(o.uri)}: ${label[o.status]}${o.note ? ` (${o.note})` : ''}`)
  const summary = queued === outcomes.length ? `All ${queued} tracks were accepted into the queue, in this order.` : `${queued} of ${outcomes.length} tracks were accepted into the queue.`
  return {
    content: [summary, ...lines, stopped ? `Stopped: ${stopped}` : '', check,
      'Accepted means queued, not playing. Spotify does not guarantee order if other playback changes happen at the same time.'
    ].filter(Boolean).join('\n'),
    isError: queued === 0
  }
}

async function open(deps: SpotifyDeps, input: Record<string, unknown>): Promise<ToolResult> {
  const uri = typeof input.uri === 'string' && input.uri ? input.uri : undefined
  if (uri && !PAGE_URI.test(uri)) return fail('Only Spotify track, album, artist or playlist URIs can be opened.')
  try {
    await deps.openExternal(uri ?? 'spotify:')
    return ok(`Asked the system to open the Spotify app${uri ? ` on ${uri}` : ''}. Playback was not started. If it isn't installed, nothing will open.`)
  } catch { return fail('The Spotify app could not be opened. It may not be installed on this computer.') }
}

async function transfer(deps: SpotifyDeps, input: Record<string, unknown>): Promise<ToolResult> {
  const deviceId = typeof input.device_id === 'string' ? input.device_id.trim() : ''
  if (!deviceId) return fail('A device_id from spotify__devices is required.')
  if (typeof input.play !== 'boolean') return fail('Say explicitly whether to start playback: play must be true or false.')
  const data = await deps.client.request<{ devices: Device[] }>('GET', '/me/player/devices', { idempotent: true })
  const device = data?.devices.find((d) => d.id === deviceId)
  if (!device) return fail('That device is not available. List devices again with spotify__devices.')
  if (device.is_restricted) return fail(`${device.name} can't be controlled through the Web API.`)
  await deps.client.request('PUT', '/me/player', { body: { device_ids: [deviceId], play: input.play }, idempotent: true })
  return ok(`Spotify accepted moving playback to ${device.name}${input.play ? ' and starting it' : ' without changing play/pause'}.`)
}

export function tools(deps: SpotifyDeps): Record<string, (input: Record<string, unknown>) => Promise<ToolResult>> {
  const wrap = (f: (i: Record<string, unknown>) => Promise<ToolResult>) => async (i: Record<string, unknown>): Promise<ToolResult> => {
    try { return await f(i ?? {}) }
    catch (err) {
      if (err instanceof SpotifyApiError) return fail(err.message)
      throw new PluginError(err instanceof Error ? err.message : String(err))
    }
  }
  return {
    search: wrap((i) => search(deps, i)),
    now_playing: wrap(() => nowPlaying(deps)),
    devices: wrap(() => devices(deps)),
    add_to_queue: wrap((i) => addToQueue(deps, i)),
    open: wrap((i) => open(deps, i)),
    transfer_playback: wrap((i) => transfer(deps, i)),
    next_track: wrap((i) => playbackCommand(deps, 'next_track', i)),
    previous_track: wrap((i) => playbackCommand(deps, 'previous_track', i)),
    pause_playback: wrap((i) => playbackCommand(deps, 'pause_playback', i)),
    resume_playback: wrap((i) => playbackCommand(deps, 'resume_playback', i)),
    seek: wrap((i) => playbackCommand(deps, 'seek', i)),
    adjust_volume: wrap((i) => playbackCommand(deps, 'adjust_volume', i))
  }
}
