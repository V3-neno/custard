import {
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
  type MediaRequest,
  type Version
} from '../../shared/design'
import { JobTracker } from './jobs'
import { ArtifactStore, JobStore } from './store'
import { jobAction, type DesignService } from './tools'
import { createArtifact } from './versions'
import { reconcileDesign } from './recovery'
import { pruneImages } from './images'
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
async function restart(
  w: World,
  chats: string[] = [CHAT]
): Promise<{ s: DesignService; r: Awaited<ReturnType<typeof reconcileDesign>> }> {
  const results = new ResultStore(join(root, 'design', 'openai-images'))
  const artifacts = new ArtifactStore(join(root, 'design'))
  const store = new JobStore(join(root, 'design', 'jobs.json'))
  const jobs = new JobTracker(
    { provider: () => w.provider, save: (j) => store.save(j) },
    store.load()
  )
  const s = { ...w.service(jobs), artifacts }
  const r = await reconcileDesign({
    jobs,
    chatExists: (c) => chats.includes(c),
    forgetChat: (c) => {
      artifacts.deleteChat(c)
      jobs.forgetChat(c)
      store.deleteChat(c)
    },
    prune: () => pruneImages(results, jobs.list(), (c, a) => artifacts.get(c, a))
  })
  return { s, r }
}

const version = (s: DesignService, artifactId: string, versionId: string): Version | undefined =>
  s.artifacts.get(CHAT, artifactId)?.versions.find((v) => v.id === versionId)

describe('2.1 crash points during a paid image request', () => {
  it('1. before submission: nothing was sent, nothing is sent on restart', async () => {
    const w = world()
    const { job } = start(w)
    const { s, r } = await restart(w)
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
    const { s, r } = await restart(w)
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
    const { s, r } = await restart(w)
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

    const { s, r } = await restart(w)
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
    const again = await restart(w)
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
    const { s } = await restart(w)
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
    const { s } = await restart(w)
    expect(s.jobs.get(job.id)?.state).toBe('unknown')
  })

  it('5. after linking, before the version got the image: collected on check', async () => {
    const w = world()
    // Stops right after the completed job is saved (tools would then save
    // the files on the version).
    const { jobs, job, artifactId, versionId } = start(w)
    await jobs.submit(job.id)
    expect(w.store.load()[0]).toMatchObject({ state: 'completed' })
    const { s, r } = await restart(w)
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
    const { s } = await restart(w)
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
    const { s, r } = await restart(w, [])
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
    const r = await reconcileDesign({
      jobs: new JobTracker({ provider: () => w.provider, save: () => {} }, w.store.load()),
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
    await restart(w)
    const meta = readFileSync(
      join(root, 'design', 'openai-images', remoteIdFor(job.id), 'meta.json'),
      'utf8'
    )
    expect(JSON.parse(meta)).toMatchObject({ key: job.id, mime: 'image/png' })
    for (const f of [meta, readFileSync(join(root, 'design', 'jobs.json'), 'utf8')])
      expect(f).not.toContain(KEY)
  })

  it('recover() never sends and only touches unknown, unlinked jobs', async () => {
    const w = world()
    const { jobs, job } = start(w)
    await jobs.submit(job.id)
    const { r } = await restart(w)
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
    expect(w.results.recover(remoteIdFor('a'), 'a')).toBe(false)
    expect(w.results.recover(remoteIdFor('a'), 'other')).toBe(true)
  })
})
