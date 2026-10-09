import OpenAI, { APIError, APIConnectionError, toFile } from 'openai'
import {
  MediaError,
  type MediaFile,
  type MediaProvider,
  type MediaProviderInfo,
  type MediaReference,
  type MediaRequest,
  type RemoteStatus
} from '../../../shared/design'
import {
  capabilitiesOf,
  imageModel,
  MAX_RESULT_BYTES,
  OPENAI_IMAGE_MODELS,
  OPENAI_IMAGES_ID,
  type OpenAIImageModel
} from './models'
import type { ResultStore } from './results'

// Custard's built-in image provider: OpenAI's Image API (generations and
// edits) with the OpenAI key already saved in AI settings. The key is read
// when a request is made and never stored or copied anywhere else. Requests
// go where the chat connection's go (openaiEndpoint: pinned to OpenAI in a
// packaged build). Nothing falls back to another provider or model: if the
// chosen model can't be used, the request fails and says why.
//
// The Image API answers with the finished image, so submit() does the whole
// job: it saves the image (results.ts) and reports it completed; status()
// and result() only read that copy and never contact OpenAI, so checking a
// job can never start or charge another one.
//
// Paid requests are sent once: the SDK's automatic retries are off, and a
// request whose outcome isn't certain is reported as unknown, never resent.

export type OpenAIImagesDeps = {
  apiKey: () => string | null
  endpoint: () => { baseURL?: string }
  // The model chosen in Design settings (only when this provider is chosen).
  model: () => string | null
  results: ResultStore
  // For tests.
  client?: (apiKey: string, baseURL?: string) => Pick<OpenAI, 'images'>
  now?: () => number
}

// Long enough for a large image; OpenAI's Image API can take minutes.
const TIMEOUT_MS = 10 * 60 * 1000

const EXT: Record<string, 'png' | 'jpeg' | 'webp'> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/webp': 'webp'
}

// What the returned bytes actually are, by their signature. Output from the
// provider is untrusted: it's stored only if it is the image type asked for.
export function sniffImage(b: Uint8Array): string | null {
  const at = (i: number, ...xs: number[]): boolean => xs.every((x, k) => b[i + k] === x)
  if (b.length >= 8 && at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png'
  if (b.length >= 3 && at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (b.length >= 12 && at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50))
    return 'image/webp'
  return null
}

// A short, plain reason from an OpenAI error body, without echoing anything
// long (the body is untrusted text).
function reasonOf(err: APIError): string {
  const m = typeof err.message === 'string' ? err.message : ''
  const clean = m
    .replace(/^\d{3}\s+/, '')
    .replace(/\s+/g, ' ')
    .trim()
  return clean.length > 240 ? `${clean.slice(0, 240)}…` : clean || `HTTP ${err.status}`
}

// Dispatch evidence (stabilization contract S1), set only from what Custard
// itself observed:
//   - refusedHere: Custard stopped it before calling OpenAI, so nothing left
//     this computer and repeating it is safe;
//   - refusedByOpenAI: Custard's own HTTP client got a 4xx from OpenAI. It
//     was dispatched and failed. Whether OpenAI bills a refused request isn't
//     documented (docs/design/IMAGES.md, Evidence E7, checked 2026-10-09), so
//     a repeat's risk stays unknown and Design warns before one;
//   - unclear: anything else after sending.
const refusedHere = (kind: MediaError['kind'], message: string): MediaError =>
  new MediaError(kind, message, false, {
    state: 'not-dispatched',
    repeat: { risk: 'safe', basis: 'Custard refused it before calling OpenAI.' }
  })

// `sent: true`: a 4xx is a response, so the request did leave (amendment 1).
const refusedByOpenAI = (kind: MediaError['kind'], message: string, status: number): MediaError =>
  new MediaError(kind, message, true, {
    state: 'rejected',
    repeat: {
      risk: 'unknown',
      basis: `OpenAI answered HTTP ${status}. OpenAI doesn't document whether a refused request is billed.`
    }
  })

const unclear = (message: string): MediaError =>
  new MediaError('temporary', message, 'unknown', {
    state: 'unknown',
    repeat: {
      risk: 'unknown',
      basis: 'It may have reached OpenAI and run; OpenAI offers no way to check.'
    }
  })

// How a failed request maps to a job outcome:
//   - OpenAI answered with a 4xx: it refused the request and made no image
//     (rejected; repeat risk unknown, see refusedByOpenAI).
//   - Anything else (5xx, a dropped connection, a timeout, Custard stopping
//     the turn): it may have reached OpenAI and run, so the outcome is
//     unknown and it is never sent again on its own.
export function mapError(err: unknown, model: string): MediaError {
  if (err instanceof MediaError) return err
  if (err instanceof APIError && typeof err.status === 'number') {
    const reason = reasonOf(err)
    if (err.status === 401)
      return refusedByOpenAI('unconfigured', 'OpenAI rejected the saved API key.', err.status)
    if (err.status === 403)
      return refusedByOpenAI(
        'unconfigured',
        `OpenAI refused access to ${model}: ${reason} (OpenAI may require organization verification for its image models.)`,
        err.status
      )
    if (err.status === 404)
      return refusedByOpenAI(
        'unsupported',
        `OpenAI doesn't offer ${model} to this key: ${reason}`,
        err.status
      )
    if (err.status === 429)
      return refusedByOpenAI(
        'temporary',
        `OpenAI is rate limiting or out of quota: ${reason}`,
        err.status
      )
    if (err.status >= 400 && err.status < 500)
      return refusedByOpenAI('rejected', `OpenAI refused the request: ${reason}`, err.status)
    return unclear(`OpenAI had an error (${err.status}): ${reason}`)
  }
  if (err instanceof APIConnectionError)
    return unclear(`The connection to OpenAI failed: ${err.message}`)
  return unclear(err instanceof Error ? err.message : String(err))
}

export const remoteIdFor = (idempotencyKey: string): string =>
  `oai-img-${idempotencyKey.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64)}`

export class OpenAIImages implements MediaProvider {
  constructor(private deps: OpenAIImagesDeps) {}

  private chosen(): OpenAIImageModel | undefined {
    return imageModel(this.deps.model())
  }

  models(): { id: string; name: string; note: string }[] {
    return OPENAI_IMAGE_MODELS.map(({ id, name, note }) => ({ id, name, note }))
  }

  info(): MediaProviderInfo {
    const picked = this.deps.model()
    const model = this.chosen()
    const hasKey = this.deps.apiKey() !== null
    const base = {
      id: OPENAI_IMAGES_ID,
      name: 'OpenAI Images',
      source: { kind: 'image-provider' as const, provider: 'openai', model: model?.id ?? '' }
    }
    if (!hasKey)
      return {
        ...base,
        state: 'needs-config',
        needs: 'Add your OpenAI API key in Settings.',
        // Declared even when not ready, so Design can say what setting it up
        // would allow.
        capabilities: capabilitiesOf(model ?? OPENAI_IMAGE_MODELS[0])
      }
    if (!model)
      return {
        ...base,
        state: 'needs-config',
        needs: picked
          ? `${picked} isn't an image model Custard supports. Choose one in Design settings.`
          : 'Choose an image model in Design settings.',
        capabilities: capabilitiesOf(OPENAI_IMAGE_MODELS[0])
      }
    return { ...base, state: 'ready', capabilities: capabilitiesOf(model) }
  }

  async submit(
    request: MediaRequest,
    options: {
      idempotencyKey: string
      // Custard's job id (contract S2), recorded with the stored image.
      // Always set by JobTracker; optional only for direct calls in tests.
      correlationId?: string
      signal?: AbortSignal
      read: (ref: MediaReference) => Promise<Uint8Array>
    }
  ): Promise<{ remoteId: string; status: RemoteStatus }> {
    const model = this.chosen()
    const key = this.deps.apiKey()
    if (!key) throw refusedHere('unconfigured', 'Add your OpenAI API key in Settings.')
    if (!model) throw refusedHere('unconfigured', 'Choose an image model in Design settings.')
    if (request.operation !== 'image.generate' && request.operation !== 'image.edit')
      throw refusedHere('unsupported', `OpenAI Images can't do ${request.operation}.`)
    const remoteId = remoteIdFor(options.idempotencyKey)
    if (this.deps.results.has(remoteId))
      throw refusedHere('rejected', 'This request was already made.')
    const format = EXT[request.format ?? 'image/png']
    if (!format) throw refusedHere('unsupported', `${request.format} isn't offered.`)

    // Everything that can fail before sending happens here, so a failure
    // is certain not to have reached OpenAI.
    let images: Awaited<ReturnType<typeof toFile>>[] = []
    if (request.operation === 'image.edit') {
      if (!request.references.length)
        throw refusedHere('rejected', 'An edit needs an image to work from.')
      try {
        images = await Promise.all(
          request.references.map(async (r) => {
            const bytes = await options.read(r)
            if (sniffImage(bytes) !== r.mime)
              throw new Error(`${r.name} isn't the ${r.mime} file it was attached as.`)
            return toFile(bytes, r.name, { type: r.mime })
          })
        )
      } catch (err) {
        throw refusedHere('rejected', err instanceof Error ? err.message : String(err))
      }
    }
    if (options.signal?.aborted) throw refusedHere('rejected', 'Stopped before it was sent.')

    const { baseURL } = this.deps.endpoint()
    const client = this.deps.client
      ? this.deps.client(key, baseURL)
      : new OpenAI({
          apiKey: key,
          ...(baseURL ? { baseURL } : {}),
          maxRetries: 0,
          timeout: TIMEOUT_MS
        })
    const common = {
      model: model.id,
      prompt: request.prompt,
      n: 1,
      output_format: format,
      ...(request.size ? { size: `${request.size.width}x${request.size.height}` } : {})
    }
    let response: OpenAI.Images.ImagesResponse
    try {
      response =
        request.operation === 'image.edit'
          ? await client.images.edit(
              { ...common, image: images.length === 1 ? images[0] : images, stream: false },
              { signal: options.signal, maxRetries: 0 }
            )
          : await client.images.generate(
              { ...common, stream: false },
              { signal: options.signal, maxRetries: 0 }
            )
    } catch (err) {
      throw mapError(err, model.id)
    }

    // It ran (and may be charged). From here on, a problem is a finished job
    // that failed, not a reason to send again.
    const b64 = response.data?.[0]?.b64_json
    if (typeof b64 !== 'string' || !b64)
      return { remoteId, status: { state: 'failed', reason: 'OpenAI returned no image.' } }
    if (b64.length > Math.ceil((MAX_RESULT_BYTES * 4) / 3) + 4)
      return {
        remoteId,
        status: { state: 'failed', reason: 'OpenAI returned an image that is too large.' }
      }
    const bytes = new Uint8Array(Buffer.from(b64, 'base64'))
    const mime = sniffImage(bytes)
    const asked = request.format ?? 'image/png'
    if (mime !== asked)
      return {
        remoteId,
        status: {
          state: 'failed',
          reason: `OpenAI returned ${mime ?? 'something that is not an image'} instead of ${asked}.`
        }
      }
    const file: MediaFile = { name: `image.${format === 'jpeg' ? 'jpg' : format}`, mime, bytes }
    try {
      this.deps.results.put(
        remoteId,
        file,
        model.id,
        (this.deps.now ?? Date.now)(),
        // Custard's own job id (contract S2), so a restart can link this
        // image to its job from local files (images/index.ts).
        options.correlationId
      )
    } catch (err) {
      // Made and probably charged, but not saved: say so rather than fail
      // quietly. It can't be fetched again from OpenAI.
      throw new MediaError(
        'temporary',
        `OpenAI made the image but Custard couldn't save it (${err instanceof Error ? err.message : String(err)}).`,
        true,
        {
          state: 'unknown',
          repeat: {
            risk: 'may-duplicate',
            basis: 'OpenAI returned an image, so it ran and was probably charged.'
          }
        }
      )
    }
    return { remoteId, status: { state: 'completed' } }
  }

  // Local only: OpenAI has nothing to check.
  async status(remoteId: string): Promise<RemoteStatus> {
    return this.deps.results.has(remoteId)
      ? { state: 'completed' }
      : { state: 'failed', reason: "This image isn't stored on this computer any more." }
  }

  async result(remoteId: string): Promise<MediaFile[]> {
    const r = this.deps.results.get(remoteId)
    if (!r) throw new Error("This image isn't stored on this computer any more.")
    return [r.file]
  }
}
