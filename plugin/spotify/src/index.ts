import { definePlugin, type PluginContext } from 'custard-plugin-sdk'
import { SpotifyClient } from './client'
import { SeenTracks, tools, type SpotifyDeps } from './tools'

// Track URIs Spotify returned while this plugin has been running. Queueing is
// limited to these, so a made-up ID is refused before anything is sent.
const seen = new SeenTracks()

// Each call gets a client bound to that call's context.
const deps = (ctx: PluginContext): SpotifyDeps => ({
  client: new SpotifyClient(ctx),
  seen,
  openExternal: (url) => ctx.openExternal(url)
})

type Input = Record<string, unknown>

export default definePlugin({
  tools: {
    search: (i: Input, ctx) => tools(deps(ctx)).search(i),
    now_playing: (i: Input, ctx) => tools(deps(ctx)).now_playing(i),
    devices: (i: Input, ctx) => tools(deps(ctx)).devices(i),
    add_to_queue: (i: Input, ctx) => tools(deps(ctx)).add_to_queue(i),
    open: (i: Input, ctx) => tools(deps(ctx)).open(i),
    transfer_playback: (i: Input, ctx) => tools(deps(ctx)).transfer_playback(i)
  }
})
