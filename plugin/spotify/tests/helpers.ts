import {
  createContext,
  response,
  type FetchCall,
  type TestContext
} from 'custard-plugin-sdk/testing'
import type { FetchInit, PluginResponse } from 'custard-plugin-sdk'
import { SpotifyClient } from '../src/client'
import { SeenTracks, tools, type SpotifyDeps } from '../src/tools'

export type Call = {
  method: string
  path: string
  query: URLSearchParams
  body: unknown
  init: FetchInit
}

export const json = (
  status: number,
  body?: unknown,
  headers: Record<string, string> = {}
): PluginResponse => response(status, body, headers)

export const id = (n: number): string => String(n).padStart(22, 'a')
export const uri = (n: number): string => `spotify:track:${id(n)}`
export const makeTrack = (
  n: number
): {
  uri: string
  name: string
  artists: { name: string }[]
  album: { name: string; release_date: string }
  explicit: boolean
  duration_ms: number
} => ({
  uri: uri(n),
  name: `Song ${n}`,
  artists: [{ name: `Artist ${n}` }],
  album: { name: `Album ${n}`, release_date: '2020-01-01' },
  explicit: false,
  duration_ms: 200000
})

// A fake Spotify behind the plugin context: records every request and
// answers from `handler`.
export function setup(handler: (c: Call) => PluginResponse | Promise<PluginResponse>): {
  t: ReturnType<typeof tools>
  deps: SpotifyDeps
  calls: Call[]
  ctx: TestContext
} {
  const calls: Call[] = []
  const ctx = createContext({
    fetch: (url, init) => {
      const u = new URL(url)
      const c = {
        method: init.method ?? 'GET',
        path: u.pathname.replace('/v1', ''),
        query: u.searchParams,
        body: init.body ? JSON.parse(init.body) : undefined,
        init
      }
      calls.push(c)
      return handler(c)
    }
  })
  const deps: SpotifyDeps = {
    client: new SpotifyClient(ctx),
    seen: new SeenTracks(),
    openExternal: (u) => ctx.openExternal(u)
  }
  return { t: tools(deps), deps, calls, ctx }
}

export const queueCalls = (calls: Call[]): Call[] =>
  calls.filter((c) => c.path === '/me/player/queue' && c.method === 'POST')

export function seed(deps: SpotifyDeps, n: number): void {
  for (let i = 1; i <= n; i++) deps.seen.add(makeTrack(i))
}

export type { FetchCall }
