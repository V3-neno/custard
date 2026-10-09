import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { APIConnectionError, APIConnectionTimeoutError, APIError } from 'openai'
import type OpenAI from 'openai'
import {
  defaultDesignSettings,
  MediaError,
  type MediaReference,
  type MediaRequest
} from '../../../shared/design'
import { discoverCapabilities } from '../capabilities'
import { JobTracker } from '../jobs'
import { validateCapabilities } from '../media'
import { ArtifactStore, JobStore } from '../store'
import { jobAction, runDesignTool, type DesignService } from '../tools'
import { DEFAULT_IMAGE_MODEL, OPENAI_IMAGE_MODELS, OPENAI_IMAGES_ID } from './models'
import { mapError, OpenAIImages, remoteIdFor, sniffImage, type OpenAIImagesDeps } from './openai'
import { ResultStore } from './results'
import { chosenModel } from './chosen'
import { authorizations } from '../authorization'

// Mock-tested only: a fake OpenAI client stands in for the API. Nothing here
// talks to OpenAI.

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'custard-images-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9])
const KEY = 'sk-test-secret-key-0000'

type Call = {
  kind: 'generate' | 'edit'
  body: Record<string, unknown>
  opts: Record<string, unknown>
}

function fakeClient(answer: () => Promise<OpenAI.Images.ImagesResponse>): {
  calls: Call[]
  made: { key: string; baseURL?: string }[]
  client: NonNullable<OpenAIImagesDeps['client']>
} {
  const calls: Call[] = []
  const made: { key: string; baseURL?: string }[] = []
  const images = {
    generate: (body: Record<string, unknown>, opts: Record<string, unknown>) => {
      calls.push({ kind: 'generate', body, opts })
      return answer()
    },
    edit: (body: Record<string, unknown>, opts: Record<string, unknown>) => {
      calls.push({ kind: 'edit', body, opts })
      return answer()
    }
  }
  return {
    calls,
    made,
    client: (key, baseURL) => {
      made.push({ key, baseURL })
      return { images } as unknown as Pick<OpenAI, 'images'>
    }
  }
}

const ok =
  (bytes: Uint8Array = PNG) =>
  async (): Promise<OpenAI.Images.ImagesResponse> => ({
    created: 1,
    data: [{ b64_json: Buffer.from(bytes).toString('base64') }]
  })

function provider(
  over: Partial<OpenAIImagesDeps> = {},
  answer = ok()
): { p: OpenAIImages; fake: ReturnType<typeof fakeClient>; results: ResultStore } {
  const fake = fakeClient(answer)
  const results = new ResultStore(join(root, 'openai-images'))
  const p = new OpenAIImages({
    apiKey: () => KEY,
    endpoint: () => ({ baseURL: 'http://127.0.0.1:9/v1' }),
    model: () => DEFAULT_IMAGE_MODEL,
    results,
    client: fake.client,
    ...over
  })
  return { p, fake, results }
}

const gen = (over: Partial<MediaRequest> = {}): MediaRequest => ({
  operation: 'image.generate',
  prompt: 'a copper kettle',
  references: [],
  ...over
})
const ref = (over: Partial<MediaReference> = {}): MediaReference => ({
  kind: 'image',
  name: 'kettle.png',
  mime: 'image/png',
  bytes: PNG.length,
  attachmentId: 'att-1',
  sha256: 'h',
  ...over
})
const noRead = async (): Promise<Uint8Array> => {
  throw new Error('no references in this request')
}

describe('OpenAI Images: what it declares', () => {
  it('declares only generate and edit, valid under the media contract', () => {
    const { p } = provider()
    const info = p.info()
    expect(info.id).toBe(OPENAI_IMAGES_ID)
    expect(info.state).toBe('ready')
    expect(info.source).toEqual({
      kind: 'image-provider',
      provider: 'openai',
      model: DEFAULT_IMAGE_MODEL
    })
    expect(info.capabilities.map((c) => c.operation)).toEqual(['image.generate', 'image.edit'])
    const v = validateCapabilities(info.capabilities)
    expect(v.errors).toEqual([])
    expect(v.capabilities).toHaveLength(2)
    for (const c of info.capabilities) {
      expect(c.idempotency).toBe(false)
      expect(c.cancel).toBe(false)
    }
    expect(info.capabilities.find((c) => c.operation === 'image.edit')?.preservesUnchanged).toBe(
      false
    )
  })

  it('names a price only with its source, and none where the page gave none', () => {
    for (const m of OPENAI_IMAGE_MODELS) {
      const { p } = provider({ model: () => m.id })
      const cap = p.info().capabilities[0]
      if (m.pricing) expect(cap.pricing?.source).toMatch(/OpenAI API pricing page/)
      else expect(cap.pricing).toBeUndefined()
    }
  })

  it('gives rates, never a per-request price', () => {
    for (const m of OPENAI_IMAGE_MODELS.filter((x) => x.pricing)) {
      expect(m.pricing?.text).toMatch(/per 1M tokens/)
      expect(m.pricing?.text).toMatch(/total depends/)
      expect(m.pricing?.text).not.toMatch(/per (image|request)/)
    }
    // No standard-tier row for gpt-image-2 on the pricing page (2026-10-09).
    expect(OPENAI_IMAGE_MODELS.find((m) => m.id === 'gpt-image-2')?.pricing).toBeUndefined()
  })

  it('offers exactly the ids the OpenAI SDK accepts for images, minus those shutting down', () => {
    // ImageModel in openai 7.30.0 resources/images.d.ts, the undated aliases.
    const sdk = ['gpt-image-2', 'gpt-image-2.5-sunburst', 'gpt-image-2.5-flare']
    expect(OPENAI_IMAGE_MODELS.map((m) => m.id).sort()).toEqual([...sdk].sort())
  })

  it('lists no retired or scheduled-for-shutdown model and no chat model', () => {
    const ids = OPENAI_IMAGE_MODELS.map((m) => m.id)
    for (const gone of ['dall-e-2', 'dall-e-3', 'gpt-image-1', 'gpt-image-1-mini', 'gpt-image-1.5'])
      expect(ids).not.toContain(gone)
    expect(ids.every((id) => id.startsWith('gpt-image-'))).toBe(true)
  })

  it('needs a key, and says so', () => {
    const { p } = provider({ apiKey: () => null })
    expect(p.info()).toMatchObject({
      state: 'needs-config',
      needs: expect.stringMatching(/API key/)
    })
  })

  it('an unsupported model makes it not ready instead of falling back', async () => {
    const { p, fake } = provider({ model: () => 'dall-e-3' })
    expect(p.info()).toMatchObject({
      state: 'needs-config',
      needs: expect.stringMatching(/dall-e-3/)
    })
    await expect(p.submit(gen(), { idempotencyKey: 'k1', read: noRead })).rejects.toMatchObject({
      kind: 'unconfigured',
      sent: false
    })
    expect(fake.calls).toHaveLength(0)
  })

  it('Design reports edits as quality-uncertain and variations as unsupported', () => {
    const { p } = provider()
    const report = discoverCapabilities({
      chat: { provider: 'openai', model: 'gpt-5.5', hasKey: true },
      design: { ...defaultDesignSettings, image: { provider: OPENAI_IMAGES_ID, model: null } },
      providers: [p.info()],
      failures: []
    })
    expect(report['image.generate'].availability.status).toBe('supported')
    expect(report['image.edit'].availability).toMatchObject({
      status: 'quality-uncertain',
      uncertainty: expect.stringMatching(/may change parts/)
    })
    expect(report['image.variation'].availability).toMatchObject({
      status: 'unavailable',
      cause: 'unsupported'
    })
  })

  it('uses the chosen model only when OpenAI Images is the chosen provider', () => {
    const s = (
      provider: string | null,
      model: string | null
    ): { image: { provider: string | null; model: string | null } } => ({
      image: { provider, model }
    })
    expect(chosenModel(s(OPENAI_IMAGES_ID, 'gpt-image-2'))).toBe('gpt-image-2')
    expect(chosenModel(s(OPENAI_IMAGES_ID, 'nope'))).toBe('nope')
    expect(chosenModel(s(OPENAI_IMAGES_ID, null))).toBe(DEFAULT_IMAGE_MODEL)
    expect(chosenModel(s('plugin:x:y', 'gpt-image-2'))).toBe(DEFAULT_IMAGE_MODEL)
  })
})

describe('OpenAI Images: submitting', () => {
  it('generates once with the saved key, no retries, and stores the image', async () => {
    const { p, fake, results } = provider()
    const r = await p.submit(gen({ size: { width: 1536, height: 1024 } }), {
      idempotencyKey: 'job-1',
      read: noRead
    })
    expect(r).toEqual({ remoteId: remoteIdFor('job-1'), status: { state: 'completed' } })
    expect(fake.made).toEqual([{ key: KEY, baseURL: 'http://127.0.0.1:9/v1' }])
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0]).toMatchObject({
      kind: 'generate',
      body: {
        model: DEFAULT_IMAGE_MODEL,
        prompt: 'a copper kettle',
        n: 1,
        output_format: 'png',
        size: '1536x1024',
        stream: false
      },
      opts: { maxRetries: 0 }
    })
    expect(results.has(r.remoteId)).toBe(true)
    expect(await p.status(r.remoteId)).toEqual({ state: 'completed' })
    const files = await p.result(r.remoteId)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({ name: 'image.png', mime: 'image/png' })
    expect([...files[0].bytes]).toEqual([...PNG])
    // Checking never calls OpenAI again.
    expect(fake.calls).toHaveLength(1)
  })

  it('never stores the key with the image', async () => {
    const { p } = provider()
    await p.submit(gen(), { idempotencyKey: 'job-k', read: noRead })
    const dir = join(root, 'openai-images', remoteIdFor('job-k'))
    for (const f of readdirSync(dir))
      expect(readFileSync(join(dir, f), 'latin1')).not.toContain(KEY)
  })

  it('refuses to send the same request twice', async () => {
    const { p, fake } = provider()
    await p.submit(gen(), { idempotencyKey: 'job-2', read: noRead })
    await expect(p.submit(gen(), { idempotencyKey: 'job-2', read: noRead })).rejects.toMatchObject({
      sent: false
    })
    expect(fake.calls).toHaveLength(1)
  })

  it('asks for the requested format and refuses a different one back', async () => {
    const jpeg = provider({}, ok(JPEG))
    const r = await jpeg.p.submit(gen({ format: 'image/jpeg' }), {
      idempotencyKey: 'job-3',
      read: noRead
    })
    expect(jpeg.fake.calls[0].body.output_format).toBe('jpeg')
    expect(r.status).toEqual({ state: 'completed' })
    expect((await jpeg.p.result(r.remoteId))[0]).toMatchObject({
      name: 'image.jpg',
      mime: 'image/jpeg'
    })

    const wrong = provider({}, ok(JPEG))
    const w = await wrong.p.submit(gen(), { idempotencyKey: 'job-4', read: noRead })
    expect(w.status).toMatchObject({
      state: 'failed',
      reason: expect.stringMatching(/image\/jpeg instead of image\/png/)
    })
    expect(wrong.results.has(w.remoteId)).toBe(false)
  })

  it('treats a response without an image, or not an image, as a failed job', async () => {
    const none = provider({}, async () => ({ created: 1, data: [] }))
    expect(
      (await none.p.submit(gen(), { idempotencyKey: 'a', read: noRead })).status
    ).toMatchObject({
      state: 'failed'
    })
    const html = provider({}, ok(new TextEncoder().encode('<html>hi</html>')))
    expect(
      (await html.p.submit(gen(), { idempotencyKey: 'b', read: noRead })).status
    ).toMatchObject({ state: 'failed', reason: expect.stringMatching(/not an image/) })
  })

  it('edits with the referenced files read by Custard', async () => {
    const { p, fake } = provider()
    const reads: string[] = []
    const r = await p.submit(
      gen({ operation: 'image.edit', prompt: 'make it blue', references: [ref()] }),
      {
        idempotencyKey: 'job-5',
        read: async (x) => {
          reads.push(x.attachmentId)
          return PNG
        }
      }
    )
    expect(reads).toEqual(['att-1'])
    expect(fake.calls[0].kind).toBe('edit')
    const image = fake.calls[0].body.image as File
    expect(image.name).toBe('kettle.png')
    expect(image.type).toBe('image/png')
    expect(r.status).toEqual({ state: 'completed' })
  })

  it('refuses a reference whose bytes are not what it was attached as, before sending', async () => {
    const { p, fake } = provider()
    await expect(
      p.submit(gen({ operation: 'image.edit', references: [ref()] }), {
        idempotencyKey: 'job-6',
        read: async () => JPEG
      })
    ).rejects.toMatchObject({ kind: 'rejected', sent: false })
    expect(fake.calls).toHaveLength(0)
  })

  it('never does a variation', async () => {
    const { p, fake } = provider()
    await expect(
      p.submit(gen({ operation: 'image.variation', references: [ref()] }), {
        idempotencyKey: 'job-7',
        read: async () => PNG
      })
    ).rejects.toMatchObject({ kind: 'unsupported', sent: false })
    expect(fake.calls).toHaveLength(0)
  })

  it('needs a key to send anything', async () => {
    const { p, fake } = provider({ apiKey: () => null })
    await expect(p.submit(gen(), { idempotencyKey: 'x', read: noRead })).rejects.toMatchObject({
      kind: 'unconfigured',
      sent: false
    })
    expect(fake.calls).toHaveLength(0)
  })
})

describe('OpenAI Images: outcomes', () => {
  const h = new Headers()
  it('a 4xx means OpenAI refused it: it was sent, and made no image', () => {
    expect(
      mapError(APIError.generate(400, { error: { message: 'bad prompt' } }, undefined, h), 'm')
    ).toMatchObject({ kind: 'rejected', sent: true })
    expect(mapError(APIError.generate(401, undefined, 'nope', h), 'm')).toMatchObject({
      kind: 'unconfigured',
      sent: true
    })
    expect(mapError(APIError.generate(403, undefined, 'verify', h), 'm').message).toMatch(
      /organization verification/
    )
    expect(mapError(APIError.generate(429, undefined, 'slow down', h), 'm')).toMatchObject({
      kind: 'temporary',
      sent: true
    })
  })

  it('sets dispatch evidence only from what Custard saw (contract S1)', async () => {
    // A 4xx is a response: dispatched and failed, repeat risk unknown,
    // because OpenAI doesn't document whether a refused request is billed.
    for (const status of [400, 401, 403, 404, 409, 413, 422, 429])
      expect(
        mapError(APIError.generate(status, undefined, 'no', h), 'm'),
        String(status)
      ).toMatchObject({ sent: true, dispatch: { state: 'rejected', repeat: { risk: 'unknown' } } })
    for (const e of [
      APIError.generate(500, undefined, 'oops', h),
      APIError.generate(503, undefined, 'busy', h),
      new APIConnectionError({ message: 'reset' }),
      new APIConnectionTimeoutError(),
      new Error('aborted')
    ])
      expect(mapError(e, 'm').dispatch).toMatchObject({
        state: 'unknown',
        repeat: { risk: 'unknown' }
      })
    // Refused here, before calling OpenAI: not dispatched, safe to repeat.
    const notSent = { state: 'not-dispatched', repeat: { risk: 'safe' } }
    const noKey = provider({ apiKey: () => null }).p
    expect(
      (await noKey.submit(gen(), { idempotencyKey: 'c1', read: noRead }).catch((e) => e)).dispatch
    ).toMatchObject(notSent)
    const stop = new AbortController()
    stop.abort()
    const { p, fake } = provider()
    expect(
      (
        await p
          .submit(gen(), { idempotencyKey: 'c2', read: noRead, signal: stop.signal })
          .catch((e) => e)
      ).dispatch
    ).toMatchObject(notSent)
    expect(fake.calls).toHaveLength(0)
  })

  it('a 5xx, a dropped connection or a timeout leaves the outcome unknown', () => {
    expect(mapError(APIError.generate(500, undefined, 'oops', h), 'm').sent).toBe('unknown')
    expect(mapError(new APIConnectionError({ message: 'reset' }), 'm').sent).toBe('unknown')
    expect(mapError(new APIConnectionTimeoutError(), 'm').sent).toBe('unknown')
    expect(mapError(new Error('aborted'), 'm').sent).toBe('unknown')
  })

  it('keeps long provider messages short', () => {
    const e = mapError(APIError.generate(400, undefined, 'x'.repeat(5000), h), 'm')
    expect(e.message.length).toBeLessThan(300)
  })

  it('through the job tracker: refused is failed, unknown is never resent', async () => {
    const store = new JobStore(join(root, 'jobs.json'))
    for (const [status, expected] of [
      [400, 'failed'],
      [503, 'unknown']
    ] as const) {
      const { p, fake } = provider({}, async () => {
        throw APIError.generate(status, undefined, 'no', h)
      })
      const t = new JobTracker({ provider: () => p, save: (j) => store.save(j) })
      const job = t.create({
        providerId: OPENAI_IMAGES_ID,
        request: gen(),
        requestedBy: { conversationId: 'c', messageIndex: 0 },
        target: { artifactId: 'a', versionId: 'v' }
      })
      const after = await t.submit(job.id, undefined, authorizations.mint(t.submitBinding(job.id)))
      expect(after.state).toBe(expected)
      await expect(t.submit(job.id)).rejects.toThrow(/already sent/)
      expect(fake.calls).toHaveLength(1)
    }
  })

  it('an image made but not saved is reported, not hidden', async () => {
    const results = new ResultStore(join(root, 'r'))
    results.put = () => {
      throw new Error('disk full')
    }
    const { p } = provider({ results })
    const err = await p.submit(gen(), { idempotencyKey: 'z', read: noRead }).catch((e) => e)
    expect(err).toBeInstanceOf(MediaError)
    expect(err.message).toMatch(/made the image but Custard couldn't save it/)
    expect(err.sent).toBe(true)
  })
})

describe('OpenAI Images: stored results', () => {
  it('prunes what Design no longer needs and keeps what it does', () => {
    const results = new ResultStore(join(root, 'r'))
    const file = { name: 'image.png', mime: 'image/png', bytes: PNG }
    results.put(remoteIdFor('keep'), file, 'm')
    results.put(remoteIdFor('drop'), file, 'm')
    expect(results.prune((id) => id === remoteIdFor('keep'))).toEqual([remoteIdFor('drop')])
    expect(results.ids()).toEqual([remoteIdFor('keep')])
  })

  it('refuses ids that are not its own', () => {
    const results = new ResultStore(join(root, 'r'))
    expect(results.has('../../etc')).toBe(false)
    expect(() => results.remove('../x')).toThrow()
  })

  it('a half-written entry reads as missing', async () => {
    const results = new ResultStore(join(root, 'r'))
    const { p } = provider({ results })
    expect(await p.status(remoteIdFor('never'))).toMatchObject({ state: 'failed' })
    await expect(p.result(remoteIdFor('never'))).rejects.toThrow(/isn't stored/)
  })

  it('sniffs image types', () => {
    expect(sniffImage(PNG)).toBe('image/png')
    expect(sniffImage(JPEG)).toBe('image/jpeg')
    expect(
      sniffImage(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))
    ).toBe('image/webp')
    expect(sniffImage(new Uint8Array([1, 2, 3]))).toBeNull()
  })
})

describe('OpenAI Images: through design_media', () => {
  it('shows OpenAI, the operation and the price source on the card, and sends once', async () => {
    const { p, fake } = provider()
    const store = new JobStore(join(root, 'jobs.json'))
    const s: DesignService = {
      artifacts: new ArtifactStore(join(root, 'design')),
      jobs: new JobTracker({ provider: () => p, save: (j) => store.save(j) }),
      providers: () => [p],
      settings: () => ({
        ...defaultDesignSettings,
        image: { provider: OPENAI_IMAGES_ID, model: null }
      }),
      failures: [],
      emit: () => {}
    }
    const asked: string[] = []
    const r = await runDesignTool(
      s,
      'design_media',
      { operation: 'image.generate', prompt: 'a copper kettle', name: 'Kettle' },
      {
        conversationId: '11111111-2222-3333-4444-555555555555',
        messageIndex: 0,
        chat: { provider: 'claude', model: 'claude-opus-5-5', hasKey: true },
        approve: async (label, detail) => {
          asked.push(`${label}\n${detail}`)
          return true
        },
        references: async () => [],
        signal: new AbortController().signal
      }
    )
    expect(r.isError).toBe(false)
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatch(/^OpenAI Images: Generate an image/)
    expect(asked[0]).toMatch(/from OpenAI API pricing page/)
    // A rate with its source, never shown as what this request costs.
    expect(asked[0]).toMatch(/Pricing, not a quote for this request: image output \$30\.00/)
    expect(asked[0]).toMatch(/doesn't know the total before it runs/)
    expect(asked[0]).not.toMatch(/^Price:/m)
    expect(asked[0]).toMatch(/can't be cancelled/)
    expect(fake.calls).toHaveLength(1)
    const job = s.jobs.list()[0]
    expect(job.state).toBe('completed')
    // Saved on its version in the same call (B1), without another request.
    expect(r.content).toMatch(/^Made by OpenAI Images/)
    const a = s.artifacts.list('11111111-2222-3333-4444-555555555555')[0]
    expect(a.kind).toBe('image')
    const v = a.versions[0]
    expect(v).toMatchObject({
      status: 'succeeded',
      source: { kind: 'image-provider', provider: 'openai', model: DEFAULT_IMAGE_MODEL }
    })
    expect(v.files).toMatchObject([{ path: 'image.png', mime: 'image/png', size: PNG.length }])
    expect(a.selected).toBe(v.id)
    expect(fake.calls).toHaveLength(1)
  })

  it('declined: nothing is sent', async () => {
    const { p, fake } = provider()
    const s: DesignService = {
      artifacts: new ArtifactStore(join(root, 'design')),
      jobs: new JobTracker({ provider: () => p, save: () => {} }),
      providers: () => [p],
      settings: () => ({
        ...defaultDesignSettings,
        image: { provider: OPENAI_IMAGES_ID, model: null }
      }),
      failures: [],
      emit: () => {}
    }
    const r = await runDesignTool(
      s,
      'design_media',
      { operation: 'image.generate', prompt: 'x' },
      {
        conversationId: '11111111-2222-3333-4444-555555555555',
        messageIndex: 0,
        chat: { provider: 'claude', model: 'claude-opus-5-5', hasKey: true },
        approve: async () => false,
        references: async () => [],
        signal: new AbortController().signal
      }
    )
    expect(r.outcome).toBe('not-run')
    expect(fake.calls).toHaveLength(0)
  })
})

describe('OpenAI Images: restart', () => {
  it('an image made before a restart is saved on its version without sending again', async () => {
    const CHAT = '11111111-2222-3333-4444-555555555555'
    const { p, fake } = provider()
    const store = new JobStore(join(root, 'jobs.json'))
    const artifacts = new ArtifactStore(join(root, 'design'))
    const before: DesignService = {
      artifacts,
      jobs: new JobTracker({ provider: () => p, save: (j) => store.save(j) }),
      providers: () => [p],
      settings: () => ({
        ...defaultDesignSettings,
        image: { provider: OPENAI_IMAGES_ID, model: null }
      }),
      failures: [],
      emit: () => {}
    }
    // Simulate Custard stopping after OpenAI answered but before the image
    // reached its version: the job is completed, the version still pending.
    const { artifact, version } = await import('../versions').then((v) =>
      v.createArtifact({
        conversationId: CHAT,
        name: 'Kettle',
        kind: 'image',
        source: p.info().source,
        skills: []
      })
    )
    artifacts.save(artifact)
    const job = before.jobs.create({
      providerId: OPENAI_IMAGES_ID,
      request: gen(),
      requestedBy: { conversationId: CHAT, messageIndex: 0 },
      target: { artifactId: artifact.id, versionId: version.id }
    })
    await before.jobs.submit(
      job.id,
      undefined,
      authorizations.mint(before.jobs.submitBinding(job.id))
    )
    expect(fake.calls).toHaveLength(1)

    const after: DesignService = {
      ...before,
      jobs: new JobTracker({ provider: () => p, save: (j) => store.save(j) }, store.load())
    }
    const r = await jobAction(after, CHAT, 'check', job.id)
    expect(r.job.state).toBe('completed')
    expect(artifacts.get(CHAT, artifact.id)?.versions[0].status).toBe('succeeded')
    expect(fake.calls).toHaveLength(1)
  })
})
