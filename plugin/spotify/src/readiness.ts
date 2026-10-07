import { PluginError, type PluginContext } from 'custard-plugin-sdk'
import { SpotifyApiError, SpotifyClient } from './client'

export type ReadyDevice = {
  id: string | null
  name: string
  type: string
  is_active: boolean
  is_restricted: boolean
}

export type WaitOptions = { deviceId?: string; computerOnly?: boolean; activeOnly?: boolean }
export type WaitRuntime = {
  now: () => number
  sleep: (ms: number, signal: AbortSignal) => Promise<void>
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new PluginError('Spotify readiness wait cancelled.')); return }
    const abort = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      reject(new PluginError('Spotify readiness wait cancelled.'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, ms)
    signal.addEventListener('abort', abort, { once: true })
  })
}

const runtime: WaitRuntime = { now: () => Date.now(), sleep }

export function readinessTimeout(ctx: Pick<PluginContext, 'config'>): number {
  const value = ctx.config.deviceReadyTimeoutSeconds
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(50, Math.max(1, value)) * 1000
    : 30000
}

class ReadinessTimeout extends PluginError {}

// Bound the whole operation, including a slow/hung HTTP response. API v1 has
// no per-fetch abort signal; an in-flight read may finish in the host, but no
// further polling or writes are started after this wait exits.
export async function waitForDevices(
  ctx: PluginContext,
  options: WaitOptions = {},
  timeoutMs = readinessTimeout(ctx),
  clock: WaitRuntime = runtime
): Promise<ReadyDevice[]> {
  const controller = new AbortController()
  const cancelled = () => controller.abort()
  ctx.signal.addEventListener('abort', cancelled, { once: true })
  if (ctx.signal.aborted) controller.abort()
  const deadline = clock.now() + timeoutMs
  const timeout = () => new ReadinessTimeout(
    `Spotify did not expose a matching controllable device within ${timeoutMs / 1000} seconds. ` +
    'The app may still be opening or may need sign-in. No playback or queue changes were made by this wait.'
  )
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const boundary = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { reject(timeout()); controller.abort() }, timeoutMs)
    onAbort = () => reject(new PluginError('Spotify readiness wait cancelled.'))
    controller.signal.addEventListener('abort', onAbort, { once: true })
    if (controller.signal.aborted) onAbort()
  })
  const poll = async (): Promise<ReadyDevice[]> => {
    const client = new SpotifyClient(ctx)
    while (true) {
      if (controller.signal.aborted) throw new PluginError('Spotify readiness wait cancelled.')
      if (clock.now() >= deadline) throw timeout()
      let devices: ReadyDevice[] = []
      try {
        // No hidden client retries: this loop owns the readiness budget.
        const data = await client.request<{ devices?: ReadyDevice[] }>('GET', '/me/player/devices')
        devices = data?.devices ?? []
      } catch (err) {
        if (controller.signal.aborted) throw new PluginError('Spotify readiness wait cancelled.')
        // Authentication, permissions and rate limits need action, not a startup
        // delay. Do not hammer Spotify on 429. Retry transient read failures only.
        if (err instanceof SpotifyApiError && err.status < 500) throw err
      }
      if (controller.signal.aborted) throw new PluginError('Spotify readiness wait cancelled.')
      if (clock.now() >= deadline) throw timeout()
      const matching = devices.filter((d) =>
        !!d.id && !d.is_restricted &&
        (!options.deviceId || d.id === options.deviceId) &&
        (!options.computerOnly || d.type === 'Computer') &&
        (!options.activeOnly || d.is_active)
      )
      if (matching.length) return matching
      await clock.sleep(Math.min(1000, deadline - clock.now()), controller.signal)
    }
  }
  try {
    return await Promise.race([boundary, poll()])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (onAbort) controller.signal.removeEventListener('abort', onAbort)
    ctx.signal.removeEventListener('abort', cancelled)
    controller.abort()
  }
}

export function describeReady(devices: ReadyDevice[]): string {
  return [
    'Spotify reports these controllable devices:',
    ...devices.map((d) => `- ${d.name} (${d.type})${d.is_active ? ', active' : ', inactive'}, id: ${d.id}`),
    'Continue the requested next step now. For queueing on an inactive device, pass its device_id explicitly. ' +
    'If the intended device is ambiguous, ask the user. Availability does not prove this is the local app, ' +
    'and does not guarantee a later queue command will succeed. Nothing was started or queued by this wait.'
  ].join('\n')
}
