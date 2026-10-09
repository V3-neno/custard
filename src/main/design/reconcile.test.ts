import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type OpenAI from 'openai'
import {
  defaultDesignSettings,
  type Job,
  type MediaCapability,
  type MediaProvider,
  type MediaRequest,
  type Version
} from '../../shared/design'
import { authorizations } from './authorization'
import { JobTracker } from './jobs'
import { ArtifactStore, JobStore } from './store'
import { jobAction, type DesignService } from './tools'
import { createArtifact } from './versions'
import { reconcileDesign } from './reconcile'
import { clearLocalResults, registerLocalResults } from './recovery'
import { forgetImageJobs, localImageIndex, pruneImages } from './images'
import { DEFAULT_IMAGE_MODEL, OPENAI_IMAGES_ID } from './images/models'
import { OpenAIImages, remoteIdFor } from './images/openai'
import { ResultStore } from './images/results'

// Stabilization 2.1 under contract S2 (amendment 2): Custard stopping at each
// point of a paid image request, or a chat being deleted, then starting
// again. A "crash" is a save that throws at the chosen moment, leaving on
// disk exactly what was saved before it. A restart builds new stores, a new
// tracker and the local result index from those files, and runs the same
// reconciliation as the app (minus Electron). During it the provider is a
// trap and the OpenAI client is counted: reconciliation must make no
// external call. Mock client only: nothing here talks to OpenAI.

const CHAT = '11111111-2222-3333-4444-555555555555'
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7])
const KEY = 'sk-test-secret-key-recovery-0000'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'custard-recovery-'))
})
afterEach(() => {
  clearLocalResults()
  rmSync(root, { recursive: true, force: true })
})

class Crash extends Error {}

const imagesDir = (): string => join(root, 'design', 'openai-images')

type World = {
  provider: OpenAIImages
  results: ResultStore
  artifacts: ArtifactStore
  store: JobStore
  calls: number[]
}

function world(answer?: () => Promise<OpenAI.Images.ImagesResponse>): World {
  const calls: number[] = []
  const results = new ResultStore(imagesDir())
  const ok = async (): Promise<OpenAI.Images.ImagesResponse> => ({
    created: 1,
    data: [{ b64_json: Buffer.from(PNG).toString('base64') }]
  })
  const provider = new OpenAIImages({
    apiKey: () => KEY,
    endpoint: () => ({ baseURL: 'http://127.0.0.1:9/v1' }),
    model: () => DEFAULT_IMAGE_MODEL,
    results,
    client: () =>
      ({
        images: {
          generate: () => {
            calls.push(1)
            return (answer ?? ok)()
          },
          edit: () => {
            throw new Error('not used')
          }
        }
      }) as unknown as Pick<OpenAI, 'images'>
  })
  return {
    provider,
    results,
    calls,
    artifacts: new ArtifactStore(join(root, 'design')),
    store: new JobStore(join(root, 'design', 'jobs.json'))
  }
}

const gen: MediaRequest = { operation: 'image.generate', prompt: 'a copper kettle', references: [] }

const send = (jobs: JobTracker, id: string): Promise<Job> =>
  jobs.submit(id, undefined, authorizations.mint(jobs.submitBinding(id)))

// A job and its pending version, as design_media makes them before sending.
function start(
  w: World,
  crashWhen?: (j: Job) => boolean
): { jobs: JobTracker; job: Job; versionId: string; artifactId: string } {
  const { artifact, version } = createArtifact({
    conversationId: CHAT,
    name: 'Kettle',
    kind: 'image',
    source: w.provider.info().source,
    skills: []
  })
  w.artifacts.save(artifact)
  const jobs = new JobTracker({
    provider: () => w.provider,
    save: (j) => {
      if (crashWhen?.(j)) throw new Crash('Custard stopped here')
      w.store.save(j)
    }
  })
  const job = jobs.create({
    providerId: OPENAI_IMAGES_ID,
    request: gen,
    requestedBy: { conversationId: CHAT, messageIndex: 0 },
    target: { artifactId: artifact.id, versionId: version.id }
  })
  return { jobs, job, versionId: version.id, artifactId: artifact.id }
}

// Custard stops right after the image is stored, before the job records it.
const crashAfterStore = (j: Job): boolean => !!j.remoteId

type Restarted = {
  s: DesignService
  r: ReturnType<typeof reconcileDesign>
  external: string[]
}

// A fresh start from what is on disk. `chats` are the chats that still exist.
function restart(w: World, chats: string[] = [CHAT]): Restarted {
  clearLocalResults()
  const results = new ResultStore(imagesDir())
  registerLocalResults(localImageIndex(results))
  const artifacts = new ArtifactStore(join(root, 'design'))
  const store = new JobStore(join(root, 'design', 'jobs.json'))
  const external: string[] = []
  let starting = true
  const before = w.calls.length
  const jobs = new JobTracker(
    {
      provider: () => {
        if (starting) external.push('provider looked up')
        return w.provider
      },
      save: (j) => store.save(j)
    },
    store.load()
  )
  const s: DesignService = {
    artifacts,
    jobs,
    providers: () => [w.provider],
    settings: () => ({
      ...defaultDesignSettings,
      image: { provider: OPENAI_IMAGES_ID, model: null }
    }),
    failures: [],
    emit: () => {}
  }
  const r = reconcileDesign({
    service: s,
    chatExists: (c) => chats.includes(c),
    forgetChat: (c) => {
      forgetImageJobs(results, jobs.list(c))
      artifacts.deleteChat(c)
      jobs.forgetChat(c)
      store.deleteChat(c)
    },
    prune: () => pruneImages(results, jobs.list(), (c, a) => artifacts.get(c, a))
  })
  starting = false
  if (w.calls.length !== before) external.push('OpenAI called')
  return { s, r, external }
}

const version = (s: DesignService, artifactId: string, versionId: string): Version | undefined =>
  s.artifacts.get(CHAT, artifactId)?.versions.find((v) => v.id === versionId)

describe('2.1 crash points during a paid image request (amendment 2, 1–5)', () => {
  it('1. before dispatch: nothing was sent, nothing is sent on restart', () => {
    const w = world()
    const { job } = start(w)
    const { s, r, external } = restart(w)
    expect(external).toEqual([])
    expect(s.jobs.get(job.id)?.state).toBe('not-submitted')
    expect(r.linked).toEqual([])
    expect(w.calls).toHaveLength(0)
  })

  it('2. during an uncertain submission: stays unknown, never resent', async () => {
    let release!: () => void
    const w = world(
      () =>
        new Promise((_, reject) => {
          release = () => reject(new Error('process ended'))
        })
    )
    const { jobs, job } = start(w)
    const sending = send(jobs, job.id)
    await new Promise((r) => setTimeout(r, 0))
    // Custard stops here: attemptedAt was saved before sending.
    expect(w.store.load()[0].attemptedAt).toBeDefined()
    const { s, r, external } = restart(w)
    release()
    await sending.catch(() => {})
    expect(external).toEqual([])
    expect(s.jobs.get(job.id)?.state).toBe('unknown')
    expect(s.jobs.get(job.id)?.error).toMatch(/may have been submitted/)
    expect(r.linked).toEqual([])
    expect(w.calls).toHaveLength(1)
  })

  it('3. response received, not yet stored: lost (OpenAI keeps no copy), and said so', async () => {
    const w = world()
    w.results.put = () => {
      throw new Crash('Custard stopped while saving')
    }
    const { jobs, job } = start(w)
    expect((await send(jobs, job.id)).state).toBe('unknown')
    const { s, r, external } = restart(w)
    expect(external).toEqual([])
    const j = s.jobs.get(job.id)!
    expect(j.state).toBe('unknown')
    expect(r.linked).toEqual([])
    // A repeat still needs the duplicate-charge go-ahead.
    expect(() =>
      s.jobs.resubmitJob(job.id, {
        acknowledgeDuplicateRisk: false,
        requestedBy: { conversationId: CHAT, messageIndex: 1 },
        target: j.target
      })
    ).toThrow(/charged/)
  })

  it('4. stored, not yet linked: linked and saved on its version at startup', async () => {
    const w = world()
    const { jobs, job, artifactId, versionId } = start(w, crashAfterStore)
    await expect(send(jobs, job.id)).rejects.toBeInstanceOf(Crash)
    expect(w.store.load()[0].remoteId).toBeUndefined()
    expect(w.results.ids()).toEqual([remoteIdFor(job.id)])

    const { s, r, external } = restart(w)
    expect(external).toEqual([])
    // Linked by the tracker's restore (the index is registered first, as at
    // startup), then filled by reconciliation.
    expect(r.filled).toEqual([job.id])
    expect(s.jobs.get(job.id)).toMatchObject({
      state: 'completed',
      remoteId: remoteIdFor(job.id),
      dispatch: { state: 'completed' }
    })
    expect(s.jobs.get(job.id)?.error).toBeUndefined()
    expect(w.store.load()[0].remoteId).toBe(remoteIdFor(job.id))
    // On its version through the normal save path, with no request.
    expect(version(s, artifactId, versionId)?.status).toBe('succeeded')
    expect(s.artifacts.read(CHAT, artifactId, versionId, 'image.png')).toEqual(Buffer.from(PNG))
    expect(w.calls).toHaveLength(1)
    // Stored on its version, so the copy is tidied away.
    expect(r.pruned).toEqual([remoteIdFor(job.id)])
  })

  it('4b. written but not yet moved into place: finished on restart', async () => {
    const w = world()
    const { jobs, job, artifactId, versionId } = start(w, crashAfterStore)
    await expect(send(jobs, job.id)).rejects.toBeInstanceOf(Crash)
    renameSync(
      join(imagesDir(), remoteIdFor(job.id)),
      join(imagesDir(), `.staging-${remoteIdFor(job.id)}-0123456789ab`)
    )
    const { s, external } = restart(w)
    expect(external).toEqual([])
    expect(s.jobs.get(job.id)?.state).toBe('completed')
    expect(version(s, artifactId, versionId)?.status).toBe('succeeded')
  })

  it('4c. a half-written staging entry is never used, and is tidied', async () => {
    const w = world()
    const { jobs, job } = start(w, crashAfterStore)
    await expect(send(jobs, job.id)).rejects.toBeInstanceOf(Crash)
    rmSync(join(imagesDir(), remoteIdFor(job.id)), { recursive: true })
    const half = join(imagesDir(), `.staging-${remoteIdFor(job.id)}-0123456789ab`)
    mkdirSync(half)
    writeFileSync(join(half, 'image'), PNG.slice(0, 4))
    const { s, external } = restart(w)
    expect(external).toEqual([])
    expect(s.jobs.get(job.id)?.state).toBe('unknown')
    expect(readdirSync(imagesDir())).toEqual([])
  })

  it('4d. a stored image that no longer validates is not used', async () => {
    const w = world()
    const { jobs, job } = start(w, crashAfterStore)
    await expect(send(jobs, job.id)).rejects.toBeInstanceOf(Crash)
    const img = join(imagesDir(), remoteIdFor(job.id), 'image')
    chmodSync(img, 0o600)
    writeFileSync(img, 'not an image')
    const { s, external } = restart(w)
    expect(external).toEqual([])
    expect(s.jobs.get(job.id)?.state).toBe('unknown')
  })

  it('5. linked, not yet shown: saved on its version at startup', async () => {
    const w = world()
    const { jobs, job, artifactId, versionId } = start(w)
    await send(jobs, job.id)
    expect(w.store.load()[0]).toMatchObject({ state: 'completed' })
    const { s, r, external } = restart(w)
    expect(external).toEqual([])
    expect(r.filled).toEqual([job.id])
    expect(version(s, artifactId, versionId)?.status).toBe('succeeded')
    expect(w.calls).toHaveLength(1)
  })

  it('5b. version folder written, index not updated: rewritten at startup', async () => {
    const w = world()
    const { jobs, job, artifactId, versionId } = start(w)
    await send(jobs, job.id)
    w.artifacts.writeFiles(CHAT, artifactId, versionId, [
      { path: 'image.png', mime: 'image/png', bytes: PNG }
    ])
    const { s, external } = restart(w)
    expect(external).toEqual([])
    expect(version(s, artifactId, versionId)?.status).toBe('succeeded')
    expect(readdirSync(join(root, 'design', CHAT, artifactId))).toEqual([versionId])
  })
})

// A provider whose submit and result wait until released, so a chat can be
// deleted while a call for it is still running.
function slowProvider(): { p: MediaProvider; submitted: () => void; resulted: () => void } {
  let submitted!: () => void
  let resulted!: () => void
  const p: MediaProvider = {
    info: () => ({
      id: 'slow',
      name: 'Slow',
      source: { kind: 'image-provider', provider: 'test', model: 'm' },
      state: 'ready',
      capabilities: [
        {
          operation: 'image.generate',
          outputs: ['image/png'],
          maxReferences: 0,
          referenceTypes: [],
          idempotency: false,
          cancel: false,
          maxPrompt: 1000
        } as unknown as MediaCapability
      ]
    }),
    submit: () =>
      new Promise((r) => {
        submitted = () => r({ remoteId: 'r1', status: { state: 'completed' } })
      }),
    status: async () => ({ state: 'completed' }),
    result: () =>
      new Promise((r) => {
        resulted = () => r([{ name: 'image.png', mime: 'image/png', bytes: PNG }])
      })
  }
  return { p, submitted: () => submitted(), resulted: () => resulted() }
}

describe('2.1 deletion (amendment 2, 6–8)', () => {
  function setup(p: MediaProvider): {
    s: DesignService
    jobs: JobTracker
    store: JobStore
    job: Job
    del: () => void
  } {
    const artifacts = new ArtifactStore(join(root, 'design'))
    const store = new JobStore(join(root, 'design', 'jobs.json'))
    const { artifact, version } = createArtifact({
      conversationId: CHAT,
      name: 'Kettle',
      kind: 'image',
      source: p.info().source,
      skills: []
    })
    artifacts.save(artifact)
    const jobs = new JobTracker({ provider: () => p, save: (j) => store.save(j) })
    const job = jobs.create({
      providerId: 'slow',
      request: gen,
      requestedBy: { conversationId: CHAT, messageIndex: 0 },
      target: { artifactId: artifact.id, versionId: version.id }
    })
    const s: DesignService = {
      artifacts,
      jobs,
      providers: () => [p],
      settings: () => defaultDesignSettings,
      failures: [],
      emit: () => {}
    }
    // The app's delete: outputs, then jobs (index.ts designChatDeleted).
    const del = (): void => {
      artifacts.deleteChat(CHAT)
      jobs.forgetChat(CHAT)
      store.deleteChat(CHAT)
    }
    return { s, jobs, store, job, del }
  }

  it('6. chat deleted during submission: the late answer brings nothing back', async () => {
    // (The app also refuses to delete a chat while it is answering, which is
    // when design_media submits; this is the tracker's own guarantee.)
    const slow = slowProvider()
    const { jobs, store, job, del } = setup(slow.p)
    const sending = send(jobs, job.id)
    await new Promise((r) => setTimeout(r, 0))
    del()
    slow.submitted()
    await sending
    expect(jobs.list()).toEqual([])
    expect(store.load()).toEqual([])
    expect(existsSync(join(root, 'design', CHAT))).toBe(false)
  })

  it('7. chat deleted during result collection: nothing comes back', async () => {
    const slow = slowProvider()
    const { s, jobs, store, job, del } = setup(slow.p)
    const sending = send(jobs, job.id)
    await new Promise((r) => setTimeout(r, 0))
    slow.submitted()
    await sending
    const collecting = jobAction(s, CHAT, 'check', job.id)
    await new Promise((r) => setTimeout(r, 0))
    del()
    slow.resulted()
    await collecting
    expect(jobs.list()).toEqual([])
    expect(store.load()).toEqual([])
    expect(existsSync(join(root, 'design', CHAT))).toBe(false)
  })

  it('7b. chat deleted, then Custard stopped before its Design data went: not recovered', async () => {
    // Recovery runs before anything else at startup, so a delete can't
    // interleave with it; an interrupted delete is finished first.
    const w = world()
    const { jobs, job } = start(w, crashAfterStore)
    await expect(send(jobs, job.id)).rejects.toBeInstanceOf(Crash)
    const { s, r, external } = restart(w, [])
    expect(external).toEqual([])
    expect(r.forgotten).toEqual([CHAT])
    expect(r.linked).toEqual([])
    expect(s.jobs.list()).toEqual([])
    expect(w.store.load()).toEqual([])
    expect(existsSync(join(root, 'design', CHAT))).toBe(false)
    expect(w.results.ids()).toEqual([])
  })

  it('8. restart after an intentional deletion: nothing is resurrected', async () => {
    const w = world()
    const { jobs, job, artifactId } = start(w, crashAfterStore)
    await expect(send(jobs, job.id)).rejects.toBeInstanceOf(Crash)
    // Deleted in full while running, as designChatDeleted does: stored
    // images of the chat's jobs, outputs, job records.
    forgetImageJobs(w.results, w.store.load())
    w.artifacts.deleteChat(CHAT)
    w.store.deleteChat(CHAT)
    expect(w.results.ids()).toEqual([])
    const { s, r, external } = restart(w)
    expect(external).toEqual([])
    expect(r.linked).toEqual([])
    expect(s.jobs.list()).toEqual([])
    expect(s.artifacts.get(CHAT, artifactId)).toBeNull()
  })
})

describe('2.1 retention and records', () => {
  it('an image no job refers to is never pruned (it may have been paid for)', async () => {
    const w = world()
    const { jobs, job } = start(w, crashAfterStore)
    await expect(send(jobs, job.id)).rejects.toBeInstanceOf(Crash)
    // The job records are lost (jobs.json unreadable and moved aside).
    rmSync(join(root, 'design', 'jobs.json'))
    expect(restart(w).r.pruned).toEqual([])
    expect(restart(w).r.pruned).toEqual([])
    expect(w.results.ids()).toEqual([remoteIdFor(job.id)])
  })

  it('a chat that cannot be read is kept', () => {
    const w = world()
    start(w)
    const jobs = new JobTracker({ provider: () => w.provider, save: () => {} }, w.store.load())
    const r = reconcileDesign({
      service: { artifacts: w.artifacts, jobs, emit: () => {} },
      chatExists: () => {
        throw new Error('unreadable')
      },
      forgetChat: () => {
        throw new Error('must not be called')
      }
    })
    expect(r.forgotten).toEqual([])
  })

  it('recovery records hold the job id and no credentials', async () => {
    const w = world()
    const { jobs, job } = start(w, crashAfterStore)
    await expect(send(jobs, job.id)).rejects.toBeInstanceOf(Crash)
    const meta = readFileSync(join(imagesDir(), remoteIdFor(job.id), 'meta.json'), 'utf8')
    expect(JSON.parse(meta)).toMatchObject({ job: job.id, mime: 'image/png' })
    restart(w)
    for (const f of [meta, readFileSync(join(root, 'design', 'jobs.json'), 'utf8')])
      expect(f).not.toContain(KEY)
  })

  it('an entry recorded for another job is not taken', () => {
    const w = world()
    w.results.put(
      remoteIdFor('a'),
      { name: 'image.png', mime: 'image/png', bytes: PNG },
      'm',
      1,
      'other'
    )
    const index = localImageIndex(w.results)
    expect(index.find('a')).toBeNull()
    expect(index.find('other')).toEqual({ remoteId: remoteIdFor('a') })
  })

  it('only built-in stores are consulted: a provider without one is never linked', async () => {
    const slow = slowProvider()
    const store = new JobStore(join(root, 'design', 'jobs.json'))
    const t = new JobTracker({ provider: () => slow.p, save: (j) => store.save(j) })
    const { artifact, version } = createArtifact({
      conversationId: CHAT,
      name: 'K',
      kind: 'image',
      source: slow.p.info().source,
      skills: []
    })
    const job = t.create({
      providerId: 'slow',
      request: gen,
      requestedBy: { conversationId: CHAT, messageIndex: 0 },
      target: { artifactId: artifact.id, versionId: version.id }
    })
    const sending = send(t, job.id)
    await new Promise((r) => setTimeout(r, 0))
    const after = new JobTracker(
      {
        provider: () => {
          throw new Error('no provider call during restore')
        },
        save: () => {}
      },
      store.load()
    )
    expect(after.get(job.id)?.state).toBe('unknown')
    slow.submitted()
    await sending
  })
})
