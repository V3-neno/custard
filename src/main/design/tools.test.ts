import { mkdtempSync, readFileSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultDesignSettings, type DesignEvent, type MediaProvider } from '../../shared/design'
import { JobTracker } from './jobs'
import { ArtifactStore, JobStore, safeFilePath, StoreError } from './store'
import {
  designTools,
  jobAction,
  runDesignTool,
  setDesignToolHandler,
  type DesignService,
  type DesignToolContext
} from './tools'
import { normalizeDesignSettings } from './settings'
import { createArtifact, settleVersion } from './versions'
import { slowVideo } from '../../../test/fixtures/media/slow-video'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'custard-design-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const CHAT = '11111111-2222-3333-4444-555555555555'

function service(p: MediaProvider): DesignService & { events: DesignEvent[]; store: JobStore } {
  const store = new JobStore(join(root, 'jobs.json'))
  let clock = 1_000_000
  const events: DesignEvent[] = []
  return {
    artifacts: new ArtifactStore(root),
    jobs: new JobTracker({
      provider: (id) => (id === p.info().id ? p : null),
      save: (j) => store.save(j),
      now: () => (clock += 2000)
    }),
    providers: () => [p],
    settings: () => defaultDesignSettings,
    failures: [],
    emit: (e) => void events.push(e),
    events,
    store
  }
}

const ctx = (over: Partial<DesignToolContext> = {}): DesignToolContext & { asked: string[] } => {
  const asked: string[] = []
  return {
    conversationId: CHAT,
    messageIndex: 0,
    chat: { provider: 'claude', model: 'claude-opus-5-5', hasKey: true },
    approve: async (label, detail) => {
      asked.push(`${label}\n${detail}`)
      return true
    },
    references: async () => [],
    signal: new AbortController().signal,
    asked,
    ...over
  }
}

describe('artifact store', () => {
  it('keeps versions append-only and files write-once', () => {
    const s = new ArtifactStore(root)
    const { artifact, version } = createArtifact({
      conversationId: CHAT,
      name: 'Page',
      kind: 'html',
      source: { kind: 'chat-model', provider: 'claude', model: 'm' },
      skills: []
    })
    s.save(artifact)
    const files = s.writeFiles(CHAT, artifact.id, version.id, [
      { path: 'index.html', mime: 'text/html', bytes: new TextEncoder().encode('<p>hi') }
    ])
    const done = settleVersion(artifact, version.id, { status: 'succeeded', files })
    s.save(done)
    expect(s.read(CHAT, artifact.id, version.id, 'index.html')?.toString()).toBe('<p>hi')
    const full = s.file(CHAT, artifact.id, version.id, 'index.html')!.full
    expect(statSync(full).mode & 0o222).toBe(0)
    expect(() =>
      s.writeFiles(CHAT, artifact.id, version.id, [
        { path: 'index.html', mime: 'text/html', bytes: new Uint8Array([1]) }
      ])
    ).toThrow()
    expect(() => s.save({ ...done, versions: [] })).toThrow(/never be removed/)
    expect(() =>
      s.save({ ...done, versions: [{ ...done.versions[0], name: 'x', files: [] } as never] })
    ).toThrow(/never be changed/)
    // Unrecorded files are never served.
    expect(s.file(CHAT, artifact.id, version.id, '../artifacts.json')).toBeNull()
  })

  it('refuses unsafe file names and ids', () => {
    for (const bad of ['../x', '/abs', 'a/../b', '.hidden', 'con.txt', 'a.', 'a/b/c/d/e', 'x:y'])
      expect(() => safeFilePath(bad), bad).toThrow(StoreError)
    expect(safeFilePath('assets/logo.png')).toEqual(['assets', 'logo.png'])
    expect(() => new ArtifactStore(root).list('../etc')).toThrow(StoreError)
  })

  it('deleting a chat removes its outputs only', () => {
    const s = new ArtifactStore(root)
    const { artifact } = createArtifact({
      conversationId: CHAT,
      name: 'Page',
      kind: 'html',
      source: { kind: 'chat-model', provider: 'claude', model: 'm' },
      skills: []
    })
    s.save(artifact)
    s.deleteChat(CHAT)
    expect(s.list(CHAT)).toEqual([])
  })
})

describe('design settings', () => {
  it('keep ids only, never secrets or unknown fields', () => {
    const n = normalizeDesignSettings({
      image: { provider: 'openai', model: 'some-image-model', apiKey: 'sk-secret' },
      video: { provider: 'plugin:x:y' },
      token: 'abc'
    })
    expect(n).toEqual({
      image: { provider: 'openai', model: 'some-image-model' },
      video: { provider: 'plugin:x:y' }
    })
    expect(JSON.stringify(n)).not.toMatch(/secret|abc/)
    expect(normalizeDesignSettings('junk')).toEqual(defaultDesignSettings)
  })
})

describe('design tools', () => {
  it('offers only tools with a handler (design_html waits for Workstream A)', () => {
    expect(designTools().map((t) => t.name)).toEqual(['design_media', 'design_jobs'])
  })

  it('a handler can bring its own schema, under its own name', () => {
    setDesignToolHandler('design_html', async () => ({ content: 'ok', isError: false }), {
      name: 'other',
      description: 'x',
      input_schema: { type: 'object', properties: { files: { type: 'array' } } }
    })
    const html = designTools().find((t) => t.name === 'design_html')
    expect(html?.input_schema.properties).toHaveProperty('files')
  })

  it('request → approval → job → result → version, through the common path', async () => {
    const p = slowVideo()
    const s = service(p)
    const c = ctx()
    const r = await runDesignTool(
      s,
      'design_media',
      { operation: 'video.text-to-video', prompt: 'waves at dusk', durationSeconds: 5 },
      c
    )
    expect(r.outcome).toBe('completed')
    expect(c.asked[0]).toMatch(/Slow video \(test fixture\): Make a video from text/)
    expect(c.asked[0]).toMatch(/No files are sent/)
    expect(c.asked[0]).toMatch(/No price information/)
    const [job] = s.jobs.list(CHAT)
    expect(s.store.load()[0].id).toBe(job.id)
    for (let i = 0; i < 3; i++) await jobAction(s, CHAT, 'check', job.id)
    const [artifact] = s.artifacts.list(CHAT)
    expect(artifact.kind).toBe('video')
    expect(artifact.versions[0].status).toBe('succeeded')
    expect(artifact.selected).toBe(artifact.versions[0].id)
    const f = s.artifacts.file(CHAT, artifact.id, artifact.versions[0].id, 'clip.mp4')!
    expect(readFileSync(f.full).byteLength).toBe(8)
    expect(s.events.some((e) => e.type === 'artifact')).toBe(true)
  })

  it('a provider that finishes at submission has its files saved once, never resent', async () => {
    const base = slowVideo()
    let results = 0
    const p: MediaProvider = {
      ...base,
      info: base.info,
      submit: async (r, o) => ({ ...(await base.submit(r, o)), status: { state: 'completed' } }),
      result: async (id) => {
        results++
        if (results === 1) throw new Error('reset')
        return base.result(id)
      }
    }
    const s = service(p)
    const r = await runDesignTool(
      s,
      'design_media',
      { operation: 'video.text-to-video', prompt: 'waves', durationSeconds: 5 },
      ctx()
    )
    // The first fetch failed: the job is done, its version waits, nothing is resent.
    expect(r.content).toMatch(/won't be sent again/)
    const [job] = s.jobs.list(CHAT)
    expect(job.state).toBe('completed')
    expect(s.artifacts.list(CHAT)[0].versions[0].status).toBe('pending')
    // As after a restart: a check fetches the result only.
    await jobAction(s, CHAT, 'check', job.id)
    expect(s.artifacts.list(CHAT)[0].versions[0].status).toBe('succeeded')
    expect(base.calls.submit).toHaveLength(1)
    expect(base.calls.status).toBe(0)
    expect(results).toBe(2)
  })

  it('declined: nothing is sent or saved', async () => {
    const p = slowVideo()
    const s = service(p)
    const r = await runDesignTool(
      s,
      'design_media',
      { operation: 'video.text-to-video', prompt: 'waves', durationSeconds: 5 },
      ctx({ approve: async () => false })
    )
    expect(r.outcome).toBe('not-run')
    expect(p.calls.submit).toHaveLength(0)
    expect(s.artifacts.list(CHAT)).toEqual([])
  })

  it('unavailable: says why, asks nothing, sends nothing', async () => {
    const p = slowVideo()
    const s = service(p)
    const c = ctx()
    const r = await runDesignTool(
      s,
      'design_media',
      { operation: 'image.generate', prompt: 'a cat' },
      c
    )
    expect(r.outcome).toBe('not-run')
    expect(r.content).toMatch(/isn't available \(unsupported\)/)
    expect(c.asked).toEqual([])
  })

  it('a lost submission is reported as unknown and the version stays pending', async () => {
    const p = slowVideo({ submit: 'lost' })
    const s = service(p)
    const r = await runDesignTool(
      s,
      'design_media',
      { operation: 'video.text-to-video', prompt: 'waves', durationSeconds: 5 },
      ctx()
    )
    expect(r.outcome).toBe('unknown')
    expect(r.content).toMatch(/charged twice/)
    expect(s.artifacts.list(CHAT)[0].versions[0].status).toBe('pending')
  })

  it("jobs from another chat can't be touched", async () => {
    const p = slowVideo()
    const s = service(p)
    await runDesignTool(
      s,
      'design_media',
      { operation: 'video.text-to-video', prompt: 'waves', durationSeconds: 5 },
      ctx()
    )
    const [job] = s.jobs.list(CHAT)
    const r = await runDesignTool(
      s,
      'design_jobs',
      { action: 'cancel', job: job.id },
      ctx({ conversationId: '99999999-2222-3333-4444-555555555555' })
    )
    expect(r.content).toMatch(/no such job in this chat/)
    expect(p.calls.cancel).toBe(0)
  })
})
