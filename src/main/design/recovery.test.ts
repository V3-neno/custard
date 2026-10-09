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
import { JobTracker } from './jobs'
import { ArtifactStore, JobStore } from './store'
import { jobAction, type DesignService } from './tools'
import { createArtifact } from './versions'
import { reconcileDesign } from './recovery'
import { localImageResult, pruneImages } from './images'
import { DEFAULT_IMAGE_MODEL, OPENAI_IMAGES_ID } from './images/models'
import { OpenAIImages, remoteIdFor } from './images/openai'
import { ResultStore } from './images/results'

// Stabilization 2.1: Custard stopping at each point of a paid image request,
// then starting again. A "crash" is simulated by a save that throws at the
// chosen moment, leaving on disk exactly what was saved before it; the
// restart builds new stores and a new tracker from those files and runs the
// same startup reconciliation as the app (minus Electron). Mock client only:
// nothing here talks to OpenAI.

const CHAT = '11111111-2222-3333-4444-555555555555'
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7])
const KEY = 'sk-test-secret-key-recovery-0000'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'custard-recovery-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

class Crash extends Error {}

type World = {
  provider: OpenAIImages
  results: ResultStore
  artifacts: ArtifactStore
  store: JobStore
  calls: number[]
  service: (jobs: JobTracker) => DesignService
}

function world(answer?: () => Promise<OpenAI.Images.ImagesResponse>): World {
  const calls: number[] = []
  const results = new ResultStore(join(root, 'design', 'openai-images'))
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
            return (
              answer ??
              (async () => ({
                created: 1,
                data: [{ b64_json: Buffer.from(PNG).toString('base64') }]
              }))
            )()
          },
          edit: () => {
            throw new Error('not used')
          }
        }
      }) as unknown as Pick<OpenAI, 'images'>
  })
  const artifacts = new ArtifactStore(join(root, 'design'))
  const store = new JobStore(join(root, 'design', 'jobs.json'))
  return {
    provider,
    results,
    artifacts,
    store,
    calls,
    service: (jobs) => ({
      artifacts,
      jobs,
      providers: () => [provider],
      settings: () => ({
        ...defaultDesignSettings,
        image: { provider: OPENAI_IMAGES_ID, model: null }
      }),
      failures: [],
      emit: () => {}
    })
  }
}

const gen: MediaRequest = { operation: 'image.generate', prompt: 'a copper kettle', references: [] }

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

// A fresh start from what is on disk: new stores, a new tracker, and the
// same reconciliation the app runs. `chats` are the chats that still exist.
// Reconciliation must be local only, so during it the provider is a trap:
// any use of it (status, result, submit, cancel) is recorded as external.
function restart(
  w: World,
  chats: string[] = [CHAT]
): { s: DesignService; r: ReturnType<typeof reconcileDesign>; external: string[] } {
  const results = new ResultStore(join(root, 'design', 'openai-images'))
  const artifacts = new ArtifactStore(join(root, 'design'))
  const store = new JobStore(join(root, 'design', 'jobs.json'))
  const external: string[] = []
  let reconciling = true
  const before = w.calls.length
  const jobs = new JobTracker(
    {
      provider: () => {
        if (reconciling) external.push('provider looked up')
        return w.provider
      },
      save: (j) => store.save(j)
    },
    store.load()
  )
  const s = { ...w.service(jobs), artifacts }
  const r = reconcileDesign({
    jobs,
    chatExists: (c) => chats.includes(c),
    forgetChat: (c) => {
      artifacts.deleteChat(c)
      jobs.forgetChat(c)
      store.deleteChat(c)
    },
    localResult: localImageResult(results),
    prune: () => pruneImages(results, jobs.list(), (c, a) => artifacts.get(c, a))
  })
  reconciling = false
  if (w.calls.length !== before) external.push('OpenAI called')
  return { s, r, external }
}

const version = (s: DesignService, artifactId: string, versionId: string): Version | undefined =>
  s.artifacts.get(CHAT, artifactId)?.versions.find((v) => v.id === versionId)

describe('2.1 crash points during a paid image request', () => {
  it('1. before submission: nothing was sent, nothing is sent on restart', async () => {
    const w = world()
    const { job } = start(w)
    const { s, r, external } = restart(w)
    expect(external).toEqual([])
    expect(s.jobs.get(job.id)?.state).toBe('not-submitted')
    expect(r.recovered).toEqual([])
    expect(w.calls).toHaveLength(0)
  })

  it('2. during submission, outcome uncertain: stays unknown, never resent', async () => {
    let release!: () => void
    const w = world(
      () =>
        new Promise((_, reject) => {
          release = () => reject(new Error('process ended'))
        })
    )
    const { jobs, job } = start(w)
    const sending = jobs.submit(job.id)
    await new Promise((r) => setTimeout(r, 0))
    // Custard stops here: attemptedAt was saved before sending.
    expect(w.store.load()[0].attemptedAt).toBeDefined()
    const { s, r, external } = restart(w)
    expect(external).toEqual([])
    release()
    await sending.catch(() => {})
    expect(s.jobs.get(job.id)?.state).toBe('unknown')
    expect(s.jobs.get(job.id)?.error).toMatch(/may have been submitted/)
    expect(r.recovered).toEqual([])
    expect(w.calls).toHaveLength(1)
  })

  it('3. after OpenAI answered, before the image was saved: lost, and said so', async () => {
    const w = world()
    // The image never reaches disk (the save fails as a crash would).
    w.results.put = () => {
      throw new Crash('Custard stopped while saving')
    }
    const { jobs, job } = start(w)
    const after = await jobs.submit(job.id)
    expect(after.state).toBe('unknown')
    const { s, r, external } = restart(w)
    expect(external).toEqual([])
    const j = s.jobs.get(job.id)!
    expect(j.state).toBe('unknown')
    expect(r.recovered).toEqual([])
    expect(w.calls).toHaveLength(1)
    // A repeat still needs the duplicate-charge go-ahead.
    expect(() =>
      s.jobs.resubmitJob(job.id, {
        acknowledgeDuplicateRisk: false,
        requestedBy: { conversationId: CHAT, messageIndex: 1 },
        target: j.target
      })
    ).toThrow(/charged/)
  })

  it('4. after the image was saved, before the job recorded it: recovered, not pruned', async () => {
    const w = world()
    const { jobs, job, artifactId, versionId } = start(w, (j) => !!j.remoteId)
    await expect(jobs.submit(job.id)).rejects.toBeInstanceOf(Crash)
    const saved = w.store.load()[0]
    expect(saved.remoteId).toBeUndefined()
    expect(w.results.ids()).toEqual([remoteIdFor(job.id)])

    const { s, r, external } = restart(w)
    expect(external).toEqual([])
    expect(r.pruned).toEqual([])
    expect(r.recovered.map((x) => x.id)).toEqual([job.id])
    expect(s.jobs.get(job.id)).toMatchObject({ state: 'completed', remoteId: remoteIdFor(job.id) })
    expect(s.jobs.get(job.id)?.error).toBeUndefined()
    // Saved durably: a second restart sees it linked.
    expect(w.store.load()[0].remoteId).toBe(remoteIdFor(job.id))

    // Checking it puts the image on its version without sending again.
    await jobAction(s, CHAT, 'check', job.id)
    expect(version(s, artifactId, versionId)?.status).toBe('succeeded')
    expect(w.calls).toHaveLength(1)
    // Stored on its version, so the next start tidies the copy away.
    const again = restart(w)
    expect(again.r.pruned).toEqual([remoteIdFor(job.id)])
  })

  it('4b. image written but not yet moved into place: finished on restart', async () => {
    const w = world()
    const { jobs, job } = start(w, (j) => !!j.remoteId)
    await expect(jobs.submit(job.id)).rejects.toBeInstanceOf(Crash)
    // Put the entry back to how a crash just before the rename leaves it.
    const dir = join(root, 'design', 'openai-images')
    renameSync(
      join(dir, remoteIdFor(job.id)),
      join(dir, `.staging-${remoteIdFor(job.id)}-0123456789ab`)
    )
    const { s, external } = restart(w)
    expect(external).toEqual([])
    expect(s.jobs.get(job.id)?.state).toBe('completed')
    expect(readdirSync(dir)).toEqual([remoteIdFor(job.id)])
  })

  it('4c. a half-written staging entry is never used as a result', async () => {
    const w = world()
    const { jobs, job } = start(w, (j) => !!j.remoteId)
    await expect(jobs.submit(job.id)).rejects.toBeInstanceOf(Crash)
    const dir = join(root, 'design', 'openai-images')
    rmSync(join(dir, remoteIdFor(job.id)), { recursive: true })
    const half = join(dir, `.staging-${remoteIdFor(job.id)}-0123456789ab`)
    mkdirSync(half)
    writeFileSync(join(half, 'image'), PNG.slice(0, 4))
    const { s, external } = restart(w)
    expect(external).toEqual([])
    expect(s.jobs.get(job.id)?.state).toBe('unknown')
  })

  it('5. after linking, before the version got the image: collected on check', async () => {
    const w = world()
    // Stops right after the completed job is saved (tools would then save
    // the files on the version).
    const { jobs, job, artifactId, versionId } = start(w)
    await jobs.submit(job.id)
    expect(w.store.load()[0]).toMatchObject({ state: 'completed' })
    const { s, r, external } = restart(w)
    expect(external).toEqual([])
    expect(r.pruned).toEqual([])
    expect(version(s, artifactId, versionId)?.status).toBe('pending')
    await jobAction(s, CHAT, 'check', job.id)
    expect(version(s, artifactId, versionId)?.status).toBe('succeeded')
    expect(w.calls).toHaveLength(1)
  })

  it('5b. files written to the version folder, index not updated: rewritten on check', async () => {
    const w = world()
    const { jobs, job, artifactId, versionId } = start(w)
    await jobs.submit(job.id)
    // The version folder exists (renamed into place) but the index was never
    // updated, so it is unrecorded.
    const files = (await w.provider.result(remoteIdFor(job.id))).map((f) => ({
      path: 'image.png',
      mime: f.mime,
      bytes: f.bytes
    }))
    w.artifacts.writeFiles(CHAT, artifactId, versionId, files)
    const { s, external } = restart(w)
    expect(external).toEqual([])
    await jobAction(s, CHAT, 'check', job.id)
    expect(version(s, artifactId, versionId)?.status).toBe('succeeded')
    expect(s.artifacts.read(CHAT, artifactId, versionId, 'image.png')).toEqual(Buffer.from(PNG))
    expect(readdirSync(join(root, 'design', CHAT, artifactId))).toEqual([versionId])
  })
})

describe('2.1 reconciliation rules', () => {
  it('a deleted chat stays deleted: jobs forgotten, stored image removed', async () => {
    const w = world()
    const { jobs, job } = start(w, (j) => !!j.remoteId)
    await expect(jobs.submit(job.id)).rejects.toBeInstanceOf(Crash)
    // The chat was deleted, then Custard stopped before its Design data went.
    const { s, r, external } = restart(w, [])
    expect(external).toEqual([])
    expect(r.forgotten).toEqual([CHAT])
    expect(r.recovered).toEqual([])
    expect(s.jobs.list()).toEqual([])
    expect(w.store.load()).toEqual([])
    expect(existsSync(join(root, 'design', CHAT))).toBe(false)
    expect(w.results.ids()).toEqual([])
  })

  it('a chat that cannot be read is kept', async () => {
    const w = world()
    start(w)
    const r = reconcileDesign({
      jobs: new JobTracker({ provider: () => w.provider, save: () => {} }, w.store.load()),
      localResult: () => null,
      chatExists: () => {
        throw new Error('unreadable')
      },
      forgetChat: () => {
        throw new Error('must not be called')
      }
    })
    expect(r.forgotten).toEqual([])
  })

  it('recovery records hold no credentials', async () => {
    const w = world()
    const { jobs, job } = start(w, (j) => !!j.remoteId)
    await expect(jobs.submit(job.id)).rejects.toBeInstanceOf(Crash)
    restart(w)
    const meta = readFileSync(
      join(root, 'design', 'openai-images', remoteIdFor(job.id), 'meta.json'),
      'utf8'
    )
    expect(JSON.parse(meta)).toMatchObject({ job: job.id, mime: 'image/png' })
    for (const f of [meta, readFileSync(join(root, 'design', 'jobs.json'), 'utf8')])
      expect(f).not.toContain(KEY)
  })

  it('reconciliation never sends and only touches unknown, unlinked jobs', async () => {
    const w = world()
    const { jobs, job } = start(w)
    await jobs.submit(job.id)
    const { r, external } = restart(w)
    expect(external).toEqual([])
    expect(r.recovered).toEqual([])
    expect(w.calls).toHaveLength(1)
  })

  it('an entry whose recorded key is another job is not taken', () => {
    const w = world()
    w.results.put(
      remoteIdFor('a'),
      { name: 'image.png', mime: 'image/png', bytes: PNG },
      'm',
      1,
      'other'
    )
    expect(w.results.recoverLocal(remoteIdFor('a'), 'a')).toBe(false)
    expect(w.results.recoverLocal(remoteIdFor('a'), 'other')).toBe(true)
  })
})

// A provider whose submit and result wait until released, so a chat can be
// deleted while a call for it is still running.
function slowProvider(): {
  p: MediaProvider
  submitted: () => void
  resulted: () => void
  calls: string[]
} {
  const calls: string[] = []
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
    submit: () => {
      calls.push('submit')
      return new Promise((r) => {
        submitted = () => r({ remoteId: 'r1', status: { state: 'completed' } })
      })
    },
    status: async () => {
      calls.push('status')
      return { state: 'completed' }
    },
    result: () => {
      calls.push('result')
      return new Promise((r) => {
        resulted = () => r([{ name: 'image.png', mime: 'image/png', bytes: PNG }])
      })
    }
  }
  return { p, submitted: () => submitted(), resulted: () => resulted(), calls }
}

describe('2.1 deletion while work is running, and after', () => {
  // The app's delete: the chat's outputs, then its jobs (index.ts).
  const deleteChat = (artifacts: ArtifactStore, jobs: JobTracker, store: JobStore): void => {
    artifacts.deleteChat(CHAT)
    jobs.forgetChat(CHAT)
    store.deleteChat(CHAT)
  }

  function setup(p: MediaProvider): {
    jobs: JobTracker
    store: JobStore
    artifacts: ArtifactStore
    job: Job
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
    return { jobs, store, artifacts, job }
  }

  it('6. chat deleted during submission: the late answer brings nothing back', async () => {
    // (The app also refuses to delete a chat while it is answering, which is
    // when design_media submits; this is the tracker's own guarantee.)
    const slow = slowProvider()
    const { jobs, store, artifacts, job } = setup(slow.p)
    const sending = jobs.submit(job.id)
    await new Promise((r) => setTimeout(r, 0))
    deleteChat(artifacts, jobs, store)
    slow.submitted()
    await sending
    expect(jobs.list()).toEqual([])
    expect(store.load()).toEqual([])
    expect(existsSync(join(root, 'design', CHAT))).toBe(false)
  })

  it('7. chat deleted while a result is being collected: nothing comes back', async () => {
    const slow = slowProvider()
    const { jobs, store, artifacts, job } = setup(slow.p)
    const s: DesignService = {
      artifacts,
      jobs,
      providers: () => [slow.p],
      settings: () => defaultDesignSettings,
      failures: [],
      emit: () => {}
    }
    const sending = jobs.submit(job.id)
    await new Promise((r) => setTimeout(r, 0))
    slow.submitted()
    await sending
    const collecting = jobAction(s, CHAT, 'check', job.id)
    await new Promise((r) => setTimeout(r, 0))
    deleteChat(artifacts, jobs, store)
    slow.resulted()
    await collecting
    expect(jobs.list()).toEqual([])
    expect(store.load()).toEqual([])
    expect(existsSync(join(root, 'design', CHAT))).toBe(false)
  })

  it('7b. chat deleted after an unlinked image was stored: the restart does not recover it', () => {
    // Recovery itself runs before anything else at startup, so a delete
    // can't interleave with it; a delete that was interrupted is finished
    // first (reconcileDesign step 1).
    const w = world()
    const { jobs, job } = start(w, (j) => !!j.remoteId)
    return expect(jobs.submit(job.id))
      .rejects.toBeInstanceOf(Crash)
      .then(() => {
        const { s, r, external } = restart(w, [])
        expect(external).toEqual([])
        expect(r.recovered).toEqual([])
        expect(s.jobs.list()).toEqual([])
        expect(w.results.ids()).toEqual([])
      })
  })

  it('8. restart after a completed, intentional deletion: nothing is resurrected', async () => {
    const w = world()
    const { jobs, job, artifactId } = start(w, (j) => !!j.remoteId)
    await expect(jobs.submit(job.id)).rejects.toBeInstanceOf(Crash)
    // Deleted in full while running (outputs and job records). The stored
    // OpenAI copy isn't part of a chat's folder, so it is still on disk.
    w.artifacts.deleteChat(CHAT)
    w.store.deleteChat(CHAT)
    expect(w.results.ids()).toEqual([remoteIdFor(job.id)])
    const { s, r, external } = restart(w)
    expect(external).toEqual([])
    expect(r.recovered).toEqual([])
    expect(s.jobs.list()).toEqual([])
    expect(s.artifacts.get(CHAT, artifactId)).toBeNull()
    expect(w.results.ids()).toEqual([])
  })

  it('a stored image that no longer matches its recorded type is not recovered', async () => {
    const w = world()
    const { jobs, job } = start(w, (j) => !!j.remoteId)
    await expect(jobs.submit(job.id)).rejects.toBeInstanceOf(Crash)
    const img = join(root, 'design', 'openai-images', remoteIdFor(job.id), 'image')
    chmodSync(img, 0o600)
    writeFileSync(img, 'not an image')
    const { s, external } = restart(w)
    expect(external).toEqual([])
    expect(s.jobs.get(job.id)?.state).toBe('unknown')
  })
})
