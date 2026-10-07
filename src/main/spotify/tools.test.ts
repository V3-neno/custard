import { describe, expect, it, vi } from 'vitest'
import { SpotifyClient } from './client'
import { runSpotifyTool, SeenTracks, type SpotifyDeps } from './tools'

type Call = { method: string; path: string; query: URLSearchParams; body: unknown }
type Handler = (call: Call) => Response | Promise<Response>

const json = (status: number, body?: unknown, headers: Record<string, string> = {}): Response =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers })

const id = (n: number): string => String(n).padStart(22, 'a')
const uri = (n: number): string => `spotify:track:${id(n)}`
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
const makeTrack = (n: number) => ({
  uri: uri(n),
  name: `Song ${n}`,
  artists: [{ name: `Artist ${n}` }],
  album: { name: `Album ${n}`, release_date: '2020-01-01' },
  explicit: false,
  duration_ms: 200000
})

// A fake Spotify: records every request and answers from `handler`.
function setup(
  handler: Handler,
  opts: { refresh?: () => Promise<string> } = {}
): { deps: SpotifyDeps; calls: Call[]; openExternal: ReturnType<typeof vi.fn> } {
  const calls: Call[] = []
  const fetchFn = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input))
    const call = {
      method: init?.method ?? 'GET',
      path: url.pathname.replace('/v1', ''),
      query: url.searchParams,
      body: init?.body ? JSON.parse(String(init.body)) : undefined
    }
    calls.push(call)
    return handler(call)
  })
  const client = new SpotifyClient(
    { token: async () => 'tok', refresh: opts.refresh ?? (async () => 'tok2') },
    fetchFn as typeof fetch
  )
  const openExternal = vi.fn(async () => {})
  const deps: SpotifyDeps = { client, seen: new SeenTracks(), openExternal }
  return { deps, calls, openExternal }
}

const queueCalls = (calls: Call[]): Call[] =>
  calls.filter((c) => c.path === '/me/player/queue' && c.method === 'POST')

// Search first so the URIs count as seen.
async function seed(deps: SpotifyDeps, n: number): Promise<void> {
  for (let i = 1; i <= n; i++) deps.seen.add(makeTrack(i))
}

describe('spotify_search', () => {
  it('returns real results and caps the limit at 10', async () => {
    const { deps, calls } = setup(() =>
      json(200, { tracks: { items: [makeTrack(1), makeTrack(2)] } })
    )
    const r = await runSpotifyTool(deps, 'spotify_search', { query: 'song', limit: 50 })
    expect(r.isError).toBe(false)
    expect(r.content).toContain('Song 1')
    expect(r.content).toContain(uri(2))
    expect(calls[0].query.get('limit')).toBe('10')
    expect(calls[0].query.get('type')).toBe('track')
    expect(deps.seen.get(uri(1))).toBe('Song 1 by Artist 1')
  })

  it('says when nothing is found', async () => {
    const { deps } = setup(() => json(200, { tracks: { items: [] } }))
    const r = await runSpotifyTool(deps, 'spotify_search', { query: 'zzz' })
    expect(r.content).toMatch(/No Spotify tracks/)
  })
})

describe('spotify_add_to_queue validation', () => {
  it('rejects malformed URIs without calling Spotify', async () => {
    const { deps, calls } = setup(() => json(204))
    const r = await runSpotifyTool(deps, 'spotify_add_to_queue', {
      uris: ['spotify:album:' + id(1), 'https://open.spotify.com/track/x']
    })
    expect(r.isError).toBe(true)
    expect(r.content).toMatch(/Nothing was queued/)
    expect(calls).toHaveLength(0)
  })

  it('rejects well-formed URIs that never came from a search', async () => {
    const { deps, calls } = setup(() => json(204))
    await seed(deps, 1)
    const r = await runSpotifyTool(deps, 'spotify_add_to_queue', { uris: [uri(1), uri(9)] })
    expect(r.isError).toBe(true)
    expect(r.content).toContain(uri(9))
    expect(calls).toHaveLength(0)
  })

  it('refuses more than 10 tracks', async () => {
    const { deps } = setup(() => json(204))
    const r = await runSpotifyTool(deps, 'spotify_add_to_queue', {
      uris: Array.from({ length: 11 }, (_, i) => uri(i))
    })
    expect(r.isError).toBe(true)
  })
})

describe('spotify_add_to_queue results', () => {
  const queueBack = (uris: string[]): Response =>
    json(200, { queue: uris.map((u) => ({ uri: u })) })

  it('queues in order, one call per track, and reads the queue back', async () => {
    const { deps, calls } = setup((c) =>
      c.method === 'POST' ? json(204) : queueBack([uri(1), uri(2), uri(3)])
    )
    await seed(deps, 3)
    const r = await runSpotifyTool(deps, 'spotify_add_to_queue', { uris: [uri(1), uri(2), uri(3)] })
    expect(r.isError).toBe(false)
    expect(queueCalls(calls).map((c) => c.query.get('uri'))).toEqual([uri(1), uri(2), uri(3)])
    expect(r.content).toMatch(/All 3 tracks were accepted/)
    expect(r.content).toMatch(/lists 3 of the 3/)
    expect(r.content).toMatch(/not playing/)
  })

  it('reports partial success when one track is rejected', async () => {
    const { deps } = setup((c) => {
      if (c.method === 'GET') return queueBack([uri(1), uri(3)])
      return c.query.get('uri') === uri(2)
        ? json(400, { error: { status: 400, message: 'Invalid track uri' } })
        : json(204)
    })
    await seed(deps, 3)
    const r = await runSpotifyTool(deps, 'spotify_add_to_queue', { uris: [uri(1), uri(2), uri(3)] })
    expect(r.isError).toBe(false)
    expect(r.content).toMatch(/2 of 3 tracks were accepted/)
    expect(r.content).toMatch(/2\. Song 2 by Artist 2: not added/)
  })

  it('stops at no active device and marks the rest not attempted', async () => {
    const { deps, calls } = setup(() =>
      json(404, {
        error: {
          status: 404,
          message: 'Player command failed: No active device found',
          reason: 'NO_ACTIVE_DEVICE'
        }
      })
    )
    await seed(deps, 3)
    const r = await runSpotifyTool(deps, 'spotify_add_to_queue', { uris: [uri(1), uri(2), uri(3)] })
    expect(r.isError).toBe(true)
    expect(queueCalls(calls)).toHaveLength(1)
    expect(r.content).toMatch(/No active Spotify device/)
    expect(r.content).toMatch(/3\. Song 3 by Artist 3: not attempted/)
    expect(r.content).toMatch(/0 of 3/)
  })

  it('stops on Premium-required without retrying', async () => {
    const { deps, calls } = setup(() =>
      json(403, {
        error: {
          status: 403,
          message: 'Player command failed: Premium required',
          reason: 'PREMIUM_REQUIRED'
        }
      })
    )
    await seed(deps, 2)
    const r = await runSpotifyTool(deps, 'spotify_add_to_queue', { uris: [uri(1), uri(2)] })
    expect(queueCalls(calls)).toHaveLength(1)
    expect(r.content).toMatch(/Premium/)
  })

  it('never retries a rate-limited queue call (it could add the song twice)', async () => {
    const { deps, calls } = setup(() =>
      json(
        429,
        { error: { status: 429, message: 'API rate limit exceeded' } },
        { 'Retry-After': '0' }
      )
    )
    await seed(deps, 2)
    const r = await runSpotifyTool(deps, 'spotify_add_to_queue', { uris: [uri(1), uri(2)] })
    expect(queueCalls(calls)).toHaveLength(1)
    expect(r.content).toMatch(/rate limit/)
  })

  it('treats a server error as unknown and stops, without retrying', async () => {
    const { deps, calls } = setup((c) =>
      c.method === 'GET'
        ? queueBack([uri(1)])
        : c.query.get('uri') === uri(2)
          ? json(502, {})
          : json(204)
    )
    await seed(deps, 3)
    const r = await runSpotifyTool(deps, 'spotify_add_to_queue', { uris: [uri(1), uri(2), uri(3)] })
    expect(queueCalls(calls)).toHaveLength(2)
    expect(r.content).toMatch(/2\. Song 2 by Artist 2: unknown/)
    expect(r.content).toMatch(/3\. Song 3 by Artist 3: not attempted/)
    expect(r.content).toMatch(/1 of 3/)
  })

  it('refreshes an expired token once and continues', async () => {
    let first = true
    const refresh = vi.fn(async () => 'fresh')
    const { deps, calls } = setup(
      (c) => {
        if (c.method === 'POST' && first) {
          first = false
          return json(401, { error: { status: 401, message: 'The access token expired' } })
        }
        return c.method === 'GET' ? queueBack([uri(1)]) : json(204)
      },
      { refresh }
    )
    await seed(deps, 1)
    const r = await runSpotifyTool(deps, 'spotify_add_to_queue', { uris: [uri(1)] })
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(queueCalls(calls)).toHaveLength(2)
    expect(r.content).toMatch(/All 1 tracks/)
  })
})

describe('playback permission boundaries', () => {
  it('queueing never starts, transfers or replaces playback', async () => {
    const { deps, calls } = setup((c) =>
      c.method === 'GET' ? json(200, { queue: [] }) : json(204)
    )
    await seed(deps, 2)
    await runSpotifyTool(deps, 'spotify_add_to_queue', { uris: [uri(1), uri(2)] })
    expect(calls.every((c) => c.path === '/me/player/queue')).toBe(true)
  })

  it('opening Spotify only opens spotify: URIs and makes no API call', async () => {
    const { deps, calls, openExternal } = setup(() => json(204))
    expect((await runSpotifyTool(deps, 'spotify_open', {})).isError).toBe(false)
    expect(openExternal).toHaveBeenLastCalledWith('spotify:')
    const bad = await runSpotifyTool(deps, 'spotify_open', {
      uri: 'file:///C:/Windows/system32/calc.exe'
    })
    expect(bad.isError).toBe(true)
    expect(openExternal).toHaveBeenCalledTimes(1)
    expect(calls).toHaveLength(0)
  })

  it('transfer requires an explicit play choice', async () => {
    const { deps, calls } = setup(() => json(204))
    const r = await runSpotifyTool(deps, 'spotify_transfer_playback', { device_id: 'd1' })
    expect(r.isError).toBe(true)
    expect(calls).toHaveLength(0)
  })

  it('transfer with play=false moves without starting playback', async () => {
    const { deps, calls } = setup((c) =>
      c.method === 'GET'
        ? json(200, {
            devices: [
              { id: 'd1', name: 'Desk', type: 'Computer', is_active: false, is_restricted: false }
            ]
          })
        : json(204)
    )
    const r = await runSpotifyTool(deps, 'spotify_transfer_playback', {
      device_id: 'd1',
      play: false
    })
    expect(r.isError).toBe(false)
    const put = calls.find((c) => c.method === 'PUT')
    expect(put?.body).toEqual({ device_ids: ['d1'], play: false })
  })

  it('refuses restricted or unknown devices', async () => {
    const { deps, calls } = setup(() =>
      json(200, {
        devices: [{ id: 'd1', name: 'TV', type: 'TV', is_active: false, is_restricted: true }]
      })
    )
    expect(
      (await runSpotifyTool(deps, 'spotify_transfer_playback', { device_id: 'd1', play: true }))
        .isError
    ).toBe(true)
    expect(
      (await runSpotifyTool(deps, 'spotify_transfer_playback', { device_id: 'nope', play: true }))
        .isError
    ).toBe(true)
    expect(calls.some((c) => c.method === 'PUT')).toBe(false)
  })
})

describe('read-only tools', () => {
  it('now playing handles no active device (204)', async () => {
    const { deps } = setup(() => new Response(null, { status: 204 }))
    const r = await runSpotifyTool(deps, 'spotify_now_playing', {})
    expect(r.content).toMatch(/Nothing is playing/)
  })

  it('now playing remembers the current track so it can be referenced', async () => {
    const { deps } = setup(() =>
      json(200, {
        device: { id: 'd', name: 'Desk', type: 'Computer', is_active: true, is_restricted: false },
        is_playing: true,
        progress_ms: 1000,
        item: makeTrack(5)
      })
    )
    const r = await runSpotifyTool(deps, 'spotify_now_playing', {})
    expect(r.content).toContain('Song 5 by Artist 5')
    expect(deps.seen.get(uri(5))).toBeTruthy()
  })

  it('devices lists none helpfully', async () => {
    const { deps } = setup(() => json(200, { devices: [] }))
    const r = await runSpotifyTool(deps, 'spotify_devices', {})
    expect(r.content).toMatch(/spotify_open/)
  })

  it('retries a rate-limited read once', async () => {
    let n = 0
    const { deps, calls } = setup(() =>
      n++ === 0 ? json(429, {}, { 'Retry-After': '0' }) : json(200, { devices: [] })
    )
    await runSpotifyTool(deps, 'spotify_devices', {})
    expect(calls).toHaveLength(2)
  })
})
