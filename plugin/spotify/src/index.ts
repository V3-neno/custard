import { definePlugin, type PluginContext } from 'custard-plugin-sdk'
import { SpotifyClient } from './client'
import { SeenTracks, tools, type SpotifyDeps } from './tools'
import { describeReady, readinessTimeout, waitForDevices } from './readiness'

const seen = new SeenTracks()
const deps = (ctx: PluginContext): SpotifyDeps => ({
  client: new SpotifyClient(ctx),
  seen,
  openExternal: (url) => ctx.openExternal(url),
  signal: ctx.signal
})
type Input = Record<string, unknown>

async function wait(input: Input, ctx: PluginContext): Promise<{ content: string; isError: boolean }> {
  try {
    const devices = await waitForDevices(ctx, {
      deviceId: typeof input.device_id === 'string' ? input.device_id : undefined,
      activeOnly: input.active_only === true
    })
    return { content: describeReady(devices), isError: false }
  } catch (err) {
    return { content: err instanceof Error ? err.message : String(err), isError: true }
  }
}

export default definePlugin({
  tools: {
    search: (i: Input, ctx) => tools(deps(ctx)).search(i),
    now_playing: (i: Input, ctx) => tools(deps(ctx)).now_playing(i),
    devices: (i: Input, ctx) => tools(deps(ctx)).devices(i),
    add_to_queue: (i: Input, ctx) => tools(deps(ctx)).add_to_queue(i),
    open: async (i: Input, ctx) => {
      const started = Date.now()
      const opened = await tools(deps(ctx)).open(i)
      if (opened.isError || i.wait_for_device !== true) return opened
      try {
        const devices = await waitForDevices(ctx, { computerOnly: true },
          Math.max(1, readinessTimeout(ctx) - (Date.now() - started)))
        return { content: `${opened.content}\n${describeReady(devices)}`, isError: false }
      } catch (err) {
        return {
          content: `${opened.content}\nReadiness not confirmed: ${err instanceof Error ? err.message : String(err)}`,
          isError: true
        }
      }
    },
    wait_for_device: wait,
    transfer_playback: (i: Input, ctx) => tools(deps(ctx)).transfer_playback(i),
    next_track: (i: Input, ctx) => tools(deps(ctx)).next_track(i),
    previous_track: (i: Input, ctx) => tools(deps(ctx)).previous_track(i),
    pause_playback: (i: Input, ctx) => tools(deps(ctx)).pause_playback(i),
    resume_playback: (i: Input, ctx) => tools(deps(ctx)).resume_playback(i),
    seek: (i: Input, ctx) => tools(deps(ctx)).seek(i),
    adjust_volume: (i: Input, ctx) => tools(deps(ctx)).adjust_volume(i)
  }
})
