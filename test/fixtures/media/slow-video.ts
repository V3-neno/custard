// DEVELOPMENT-ONLY media provider for tests. Not a plugin, not bundled, not
// user-facing: nothing under src/ may import it (src/main/design tests check
// that). It stands in for a plugin that makes video asynchronously, so the
// Design contracts can be exercised end to end without any real service:
// submit returns a job reference, status steps from pending to running to
// completed (or whatever a test scripts), and result returns a few bytes.
import {
  MediaError,
  type MediaFile,
  type MediaProvider,
  type MediaProviderInfo,
  type MediaRequest,
  type RemoteStatus
} from '../../../src/shared/design'

export type SlowVideoOptions = {
  // Statuses returned by successive status() calls; the last one repeats.
  steps?: RemoteStatus[]
  // What submit() does: succeed, fail before sending, or fail after it may
  // have been sent (a lost response).
  submit?: 'ok' | 'rejected' | 'lost'
  idempotency?: boolean
  cancel?: boolean
  state?: MediaProviderInfo['state']
}

export function slowVideo(o: SlowVideoOptions = {}): MediaProvider & {
  calls: {
    submit: { request: MediaRequest; key: string }[]
    status: number
    result: number
    cancel: number
  }
} {
  const steps = o.steps ?? [
    { state: 'pending' },
    { state: 'running', progress: 0.5 },
    { state: 'completed' }
  ]
  const calls = {
    submit: [] as { request: MediaRequest; key: string }[],
    status: 0,
    result: 0,
    cancel: 0
  }
  const byKey = new Map<string, string>()
  let cancelled = false
  const info: MediaProviderInfo = {
    id: 'dev-slow-video',
    name: 'Slow video (test fixture)',
    source: { kind: 'plugin', pluginId: 'dev-slow-video', buildId: 'test', providerId: 'video' },
    state: o.state ?? 'ready',
    capabilities: [
      {
        operation: 'video.text-to-video',
        formats: ['video/mp4'],
        durations: { min: 1, max: 10 },
        progress: true,
        cancel: o.cancel ?? true,
        idempotency: o.idempotency ?? false,
        minPollSeconds: 1
      },
      {
        operation: 'video.image-to-video',
        references: { kinds: ['image'], maxCount: 1, maxBytes: 5_000_000, formats: ['image/png'] },
        formats: ['video/mp4'],
        durations: { min: 1, max: 10 },
        progress: true,
        cancel: o.cancel ?? true,
        idempotency: o.idempotency ?? false,
        minPollSeconds: 1
      }
    ]
  }
  return {
    calls,
    info: () => info,
    async submit(request, { idempotencyKey }) {
      calls.submit.push({ request, key: idempotencyKey })
      // A response saying the operation failed (contract S1). Whether it was
      // charged isn't known, so a repeat still warns.
      if (o.submit === 'rejected')
        throw new MediaError('rejected', 'Prompt rejected.', false, {
          state: 'rejected',
          repeat: { risk: 'unknown' }
        })
      if (o.submit === 'lost') throw new MediaError('temporary', 'Connection reset.', 'unknown')
      if (o.idempotency && byKey.has(idempotencyKey))
        return { remoteId: byKey.get(idempotencyKey)!, status: { state: 'pending' } }
      const remoteId = `remote-${calls.submit.length}`
      byKey.set(idempotencyKey, remoteId)
      return { remoteId, status: { state: 'pending' } }
    },
    async status() {
      calls.status++
      if (cancelled) return { state: 'cancelled' }
      return steps[Math.min(calls.status - 1, steps.length - 1)]
    },
    async cancel() {
      calls.cancel++
      cancelled = true
      return 'cancelled'
    },
    async result(): Promise<MediaFile[]> {
      calls.result++
      return [
        {
          name: 'clip.mp4',
          mime: 'video/mp4',
          bytes: new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112])
        }
      ]
    }
  }
}
