import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { discoverCapabilities, type DiscoverInput } from './capabilities'
import { checkRequest, validateCapabilities } from './media'
import {
  createArtifact,
  fileRecords,
  lastSuccessful,
  settleVersion,
  startVersion,
  VersionError
} from './versions'
import { DuplicateRiskError, JobError, JobTracker } from './jobs'
import { approveSubmission } from './approval'
import { fingerprint, planSkills, skillChanges, skillUse, type Candidate } from './skills'
import {
  defaultDesignSettings,
  MediaError,
  type Job,
  type MediaProvider,
  type MediaProviderInfo,
  type Source
} from '../../shared/design'
import { slowVideo } from '../../../test/fixtures/media/slow-video'
import { authorizations } from './authorization'
import type { AuthorizationToken } from '../../shared/design'

// Single-use authorizations as Design mints them after the user approves.
const auth = (t: JobTracker, id: string): AuthorizationToken =>
  authorizations.mint(t.submitBinding(id))
const authCancel = (t: JobTracker, id: string): AuthorizationToken =>
  authorizations.mint(t.cancelBinding(id))

const chatSource: Source = { kind: 'chat-model', provider: 'claude', model: 'claude-opus-5-5' }
const base = (over: Partial<DiscoverInput> = {}): DiscoverInput => ({
  chat: { provider: 'claude', model: 'claude-opus-5-5', hasKey: true },
  design: defaultDesignSettings,
  providers: [],
  failures: [],
  ...over
})
const imageProvider = (over: Partial<MediaProviderInfo> = {}): MediaProviderInfo => ({
  id: 'img',
  name: 'Test images',
  source: { kind: 'image-provider', provider: 'test', model: 'm1' },
  state: 'ready',
  capabilities: [
    {
      operation: 'image.generate',
      formats: ['image/png'],
      progress: false,
      cancel: false,
      idempotency: false
    }
  ],
  ...over
})

describe('capability discovery', () => {
  it('HTML needs only the chat model, and says what it is not', () => {
    const r = discoverCapabilities(base())
    const a = r['design.html'].availability
    expect(a.status).toBe('supported')
    if (a.status === 'supported') expect(a.limits.join(' ')).toMatch(/not generated/)
    const noKey = discoverCapabilities(base({ chat: { ...base().chat, hasKey: false } }))
    expect(noKey['design.html'].availability).toMatchObject({
      status: 'unavailable',
      cause: 'unconfigured',
      fix: { place: 'ai-settings' }
    })
  })

  it('never offers images from the chat model, for either provider', () => {
    for (const provider of ['claude', 'openai'] as const) {
      const r = discoverCapabilities(base({ chat: { provider, model: 'x', hasKey: true } }))
      expect(r['image.generate'].availability).toMatchObject({
        status: 'unavailable',
        cause: 'unsupported'
      })
    }
  })

  it('tells unsupported, unconfigured and failed apart', () => {
    // Nothing can make video: unsupported, fixed by a plugin.
    const none = discoverCapabilities(base())
    expect(none['video.text-to-video'].availability).toMatchObject({
      status: 'unavailable',
      cause: 'unsupported',
      fix: { place: 'plugins' }
    })
    // A provider exists, but no default is chosen: unconfigured.
    const unchosen = discoverCapabilities(base({ providers: [imageProvider()] }))
    expect(unchosen['image.generate'].availability).toMatchObject({
      status: 'unavailable',
      cause: 'unconfigured',
      fix: { place: 'design-settings' }
    })
    // Chosen and ready: supported.
    const design = { ...defaultDesignSettings, image: { provider: 'img', model: 'm1' } }
    const chosen = discoverCapabilities(base({ providers: [imageProvider()], design }))
    expect(chosen['image.generate'].availability.status).toBe('supported')
    // Chosen, but it can't edit: unsupported, not unconfigured.
    expect(chosen['image.edit'].availability).toMatchObject({
      status: 'unavailable',
      cause: 'unsupported'
    })
    // It failed this session: failed, with whether it was temporary.
    const failed = discoverCapabilities(
      base({
        providers: [imageProvider()],
        design,
        failures: [
          {
            operation: 'image.generate',
            source: imageProvider().source,
            reason: 'Timed out.',
            temporary: true
          }
        ]
      })
    )
    expect(failed['image.generate'].availability).toMatchObject({
      status: 'unavailable',
      cause: 'failed',
      temporary: true,
      reason: 'Timed out.'
    })
    // A plugin provider that's switched off: unconfigured, fixed in Plugins.
    const off = discoverCapabilities(
      base({ providers: [{ ...slowVideo().info(), state: 'disabled', needs: 'turn it on' }] })
    )
    expect(off['video.text-to-video'].availability).toMatchObject({
      status: 'unavailable',
      cause: 'unconfigured',
      fix: { place: 'plugins' }
    })
  })

  it('reports declared uncertainty, never a made-up figure', () => {
    const design = { ...defaultDesignSettings, image: { provider: 'img', model: 'm1' } }
    const p = imageProvider({
      capabilities: [
        {
          operation: 'image.edit',
          formats: ['image/png'],
          references: { kinds: ['image'], maxCount: 1, maxBytes: 1000, formats: ['image/png'] },
          progress: false,
          cancel: false,
          idempotency: false,
          preservesUnchanged: false
        }
      ]
    })
    const a = discoverCapabilities(base({ providers: [p], design }))['image.edit'].availability
    expect(a.status).toBe('quality-uncertain')
    if (a.status === 'quality-uncertain') {
      expect(a.uncertainty).toMatch(/may change parts/)
      expect(a.uncertainty).not.toMatch(/\d+ ?%/)
    }
  })

  it('never switches providers on its own', () => {
    const other = imageProvider({
      id: 'other',
      name: 'Other',
      source: { kind: 'image-provider', provider: 'o', model: 'o' }
    })
    const design = { ...defaultDesignSettings, image: { provider: 'img', model: 'm1' } }
    const r = discoverCapabilities(
      base({
        providers: [imageProvider({ state: 'needs-config', needs: 'add its key' }), other],
        design
      })
    )
    expect(r['image.generate'].availability).toMatchObject({
      status: 'unavailable',
      cause: 'unconfigured'
    })
    expect(r['image.generate'].alternatives).toEqual([other.source])
    // A chosen provider that's gone isn't replaced either.
    const gone = discoverCapabilities(
      base({
        providers: [other],
        design: { ...design, image: { provider: 'missing', model: null } }
      })
    )
    expect(gone['image.generate'].availability).toMatchObject({ cause: 'unconfigured' })
  })

  it('finds video only through a plugin', () => {
    const r = discoverCapabilities(base({ providers: [slowVideo().info()] }))
    const a = r['video.text-to-video'].availability
    expect(a.status).toBe('supported')
    if (a.status === 'supported') expect(a.via.kind).toBe('plugin')
    // Two capable plugins and no choice: the user picks.
    const two = discoverCapabilities(
      base({ providers: [slowVideo().info(), { ...slowVideo().info(), id: 'second' }] })
    )
    expect(two['video.text-to-video'].availability).toMatchObject({ cause: 'unconfigured' })
    expect(two['video.text-to-video'].alternatives).toHaveLength(2)
  })
})

describe('media capability contract', () => {
  it('accepts a valid declaration and keeps only declared fields', () => {
    const { capabilities, errors } = validateCapabilities(slowVideo().info().capabilities)
    expect(errors).toEqual([])
    expect(capabilities).toHaveLength(2)
  })

  it('refuses malformed or overreaching declarations', () => {
    const { capabilities, errors } = validateCapabilities([
      {
        operation: 'image.generate',
        formats: ['video/mp4'],
        progress: true,
        cancel: false,
        idempotency: false
      },
      { operation: 'shell.run', formats: [], progress: true, cancel: true, idempotency: true },
      {
        operation: 'video.text-to-video',
        formats: ['video/mp4'],
        progress: true,
        cancel: true,
        idempotency: true
      },
      {
        operation: 'image.edit',
        formats: ['image/png'],
        progress: false,
        cancel: false,
        idempotency: false
      },
      {
        operation: 'image.variation',
        formats: ['image/png'],
        references: { kinds: ['image'], maxCount: 1, maxBytes: 10, formats: ['image/png'] },
        progress: false,
        cancel: false,
        idempotency: false,
        pricing: { text: 'cheap' }
      }
    ])
    expect(capabilities).toEqual([])
    expect(errors.join('\n')).toMatch(/formats must list image/)
    expect(errors.join('\n')).toMatch(/unknown operation "shell.run"/)
    expect(errors.join('\n')).toMatch(/video needs durations/)
    expect(errors.join('\n')).toMatch(/image.edit must say which references/)
    expect(errors.join('\n')).toMatch(/pricing needs text and its source/)
  })

  it('checks requests against what was declared', () => {
    const [t2v, i2v] = slowVideo().info().capabilities
    const req = { operation: 'video.text-to-video' as const, prompt: 'waves', references: [] }
    expect(checkRequest(req, t2v)).toBeNull()
    expect(checkRequest({ ...req, durationSeconds: 60 }, t2v)).toMatch(/between 1 and 10/)
    expect(checkRequest({ ...req, operation: 'video.image-to-video' }, i2v)).toMatch(
      /needs a reference/
    )
    expect(
      checkRequest(
        {
          ...req,
          operation: 'video.image-to-video',
          references: [
            {
              kind: 'image',
              name: 'a.jpg',
              mime: 'image/jpeg',
              bytes: 10,
              attachmentId: 'x',
              sha256: 'h'
            }
          ]
        },
        i2v
      )
    ).toMatch(/image\/jpeg isn't accepted/)
  })
})

describe('outputs and versions', () => {
  const png = [{ path: 'v.html', mime: 'text/html', sha256: 'a', size: 1 }]

  it('never overwrites the last successful version', () => {
    const created = createArtifact({
      conversationId: 'c',
      name: 'Landing page',
      kind: 'html',
      source: chatSource,
      skills: []
    })
    const v1 = created.version
    let artifact = settleVersion(created.artifact, v1.id, { status: 'succeeded', files: png })
    const settled = structuredClone(artifact.versions[0])
    const r = startVersion(artifact, v1.id, 'revision', { source: chatSource, skills: [] })
    artifact = settleVersion(r.artifact, r.version.id, { status: 'failed', error: 'cut off' })
    expect(artifact.versions[0]).toEqual(settled)
    expect(artifact.selected).toBe(v1.id)
    expect(lastSuccessful(artifact)?.id).toBe(v1.id)
    expect(() => settleVersion(artifact, v1.id, { status: 'failed', error: 'x' })).toThrow(
      VersionError
    )
  })

  it('editing an older version makes a new one derived from it', () => {
    const created = createArtifact({
      conversationId: 'c',
      name: 'Page',
      kind: 'html',
      source: chatSource,
      skills: []
    })
    const v1 = created.version
    let artifact = settleVersion(created.artifact, v1.id, { status: 'succeeded', files: png })
    const v2 = startVersion(artifact, v1.id, 'revision', { source: chatSource, skills: [] })
    artifact = settleVersion(v2.artifact, v2.version.id, { status: 'succeeded', files: png })
    const v3 = startVersion(artifact, v1.id, 'revision', { source: chatSource, skills: [] })
    expect(v3.version).toMatchObject({ n: 3, parent: v1.id, relation: 'revision' })
    const option = startVersion(artifact, v2.version.id, 'variation', {
      source: chatSource,
      skills: []
    })
    expect(option.version).toMatchObject({ relation: 'variation', parent: v2.version.id })
  })

  it("markup can't be recorded as a generated image", () => {
    expect(() =>
      createArtifact({
        conversationId: 'c',
        name: 'Logo',
        kind: 'image',
        source: chatSource,
        skills: []
      })
    ).toThrow(/media provider/)
  })
})

describe('generation jobs, with the development-only video fixture', () => {
  let saved: Map<string, Job>
  let clock: number
  const deps = (p: MediaProvider): ConstructorParameters<typeof JobTracker>[0] => ({
    provider: (id) => (id === p.info().id ? p : null),
    save: (j) => void saved.set(j.id, structuredClone(j)),
    now: () => clock
  })
  const request = {
    operation: 'video.text-to-video' as const,
    prompt: 'waves at dusk',
    references: [],
    durationSeconds: 5
  }
  beforeEach(() => {
    saved = new Map()
    clock = 1_000_000
  })

  it('runs request, job and result into a version with no provider-specific Design code', async () => {
    const p = slowVideo()
    const tracker = new JobTracker(deps(p))
    const created = createArtifact({
      conversationId: 'c1',
      name: 'Waves',
      kind: 'video',
      source: p.info().source,
      skills: []
    })
    let artifact = created.artifact
    const job = tracker.create({
      providerId: p.info().id,
      request,
      approval: approveSubmission(p.info().source, request, 0),
      requestedBy: { conversationId: 'c1', messageIndex: 0 },
      target: { artifactId: artifact.id, versionId: created.version.id }
    })
    expect(job.state).toBe('not-submitted')
    expect(saved.get(job.id)?.state).toBe('not-submitted')
    const sent = await tracker.submit(job.id, undefined, auth(tracker, job.id))
    expect(sent).toMatchObject({ state: 'pending', remoteId: 'remote-1', tracking: true })
    expect(p.calls.submit[0].key).toBe(job.idempotencyKey)
    let files
    for (const expected of ['pending', 'running', 'completed']) {
      clock += 1000
      const r = await tracker.check(job.id)
      expect(r.job.state).toBe(expected)
      files = r.files
    }
    expect(files).toHaveLength(1)
    artifact = settleVersion(artifact, job.target.versionId, {
      status: 'succeeded',
      files: fileRecords(files!)
    })
    expect(lastSuccessful(artifact)?.files[0]).toMatchObject({
      path: 'clip.mp4',
      mime: 'video/mp4',
      size: 8
    })
    expect(tracker.get(job.id)?.tracking).toBe(false)
  })

  it('does nothing on its own: no timers, no checks, no resubmission', async () => {
    const p = slowVideo()
    const tracker = new JobTracker(deps(p))
    const job = tracker.create({
      providerId: p.info().id,
      request,
      approval: approveSubmission(p.info().source, request, 0),
      requestedBy: { conversationId: 'c', messageIndex: 0 },
      target: { artifactId: 'a', versionId: 'v' }
    })
    await tracker.submit(job.id, undefined, auth(tracker, job.id))
    await new Promise((r) => setTimeout(r, 50))
    expect(p.calls).toMatchObject({ status: 0, result: 0, cancel: 0 })
    expect(p.calls.submit).toHaveLength(1)
    await expect(tracker.submit(job.id, undefined, auth(tracker, job.id))).rejects.toThrow(
      /already sent/
    )
  })

  it('bounds status checks', async () => {
    const p = slowVideo({ steps: [{ state: 'running' }] })
    const tracker = new JobTracker(deps(p))
    const job = tracker.create({
      providerId: p.info().id,
      request,
      approval: approveSubmission(p.info().source, request, 0),
      requestedBy: { conversationId: 'c', messageIndex: 0 },
      target: { artifactId: 'a', versionId: 'v' }
    })
    await tracker.submit(job.id, undefined, auth(tracker, job.id))
    await tracker.check(job.id)
    await expect(tracker.check(job.id)).rejects.toThrow(/too recently/)
    expect(p.calls.status).toBe(1)
  })

  it('a lost submission is unknown, and only an informed resubmit sends it again', async () => {
    const p = slowVideo({ submit: 'lost' })
    const tracker = new JobTracker(deps(p))
    const job = tracker.create({
      providerId: p.info().id,
      request,
      approval: approveSubmission(p.info().source, request, 0),
      requestedBy: { conversationId: 'c', messageIndex: 0 },
      target: { artifactId: 'a', versionId: 'v' }
    })
    expect((await tracker.submit(job.id, undefined, auth(tracker, job.id))).state).toBe('unknown')
    const next = {
      requestedBy: { conversationId: 'c', messageIndex: 2 },
      target: { artifactId: 'a', versionId: 'v2' },
      approval: approveSubmission(p.info().source, request, 1)
    }
    expect(() => tracker.resubmitJob(job.id, { acknowledgeDuplicateRisk: false, ...next })).toThrow(
      DuplicateRiskError
    )
    const again = tracker.resubmitJob(job.id, { acknowledgeDuplicateRisk: true, ...next })
    expect(again.id).not.toBe(job.id)
    expect(again.state).toBe('not-submitted')
    expect(p.calls.submit).toHaveLength(1)
  })

  it('a rejected submission is a failure', async () => {
    const p = slowVideo({ submit: 'rejected' })
    const tracker = new JobTracker(deps(p))
    const job = tracker.create({
      providerId: p.info().id,
      request,
      approval: approveSubmission(p.info().source, request, 0),
      requestedBy: { conversationId: 'c', messageIndex: 0 },
      target: { artifactId: 'a', versionId: 'v' }
    })
    expect(await tracker.submit(job.id, undefined, auth(tracker, job.id))).toMatchObject({
      state: 'failed',
      error: 'Prompt rejected.'
    })
  })

  it('a plugin saying "not sent" is a claim: the outcome stays unknown and a repeat warns', async () => {
    const base = slowVideo()
    const p: MediaProvider = {
      ...base,
      info: base.info,
      submit: async () => {
        throw new MediaError('rejected', 'Service refused.', false)
      }
    }
    const tracker = new JobTracker(deps(p))
    const job = tracker.create({
      providerId: p.info().id,
      request,
      requestedBy: { conversationId: 'c', messageIndex: 0 },
      target: { artifactId: 'a', versionId: 'v' }
    })
    const sent = await tracker.submit(job.id, undefined, auth(tracker, job.id))
    expect(sent).toMatchObject({
      state: 'unknown',
      dispatch: { state: 'unknown', repeat: { risk: 'unknown' }, providerClaim: 'not sent' }
    })
    // Even a plugin "not dispatched" can't be host evidence.
    expect(() =>
      tracker.resubmitJob(job.id, {
        acknowledgeDuplicateRisk: false,
        requestedBy: { conversationId: 'c', messageIndex: 1 },
        target: { artifactId: 'a', versionId: 'v2' }
      })
    ).toThrow(DuplicateRiskError)
  })

  it('a provider rejection is a failure, but a repeat still warns', async () => {
    const p = slowVideo({ submit: 'rejected' })
    const tracker = new JobTracker(deps(p))
    const job = tracker.create({
      providerId: p.info().id,
      request,
      requestedBy: { conversationId: 'c', messageIndex: 0 },
      target: { artifactId: 'a', versionId: 'v' }
    })
    await tracker.submit(job.id, undefined, auth(tracker, job.id))
    expect(tracker.get(job.id)?.dispatch?.state).toBe('rejected')
    expect(() =>
      tracker.resubmitJob(job.id, {
        acknowledgeDuplicateRisk: false,
        requestedBy: { conversationId: 'c', messageIndex: 1 },
        target: { artifactId: 'a', versionId: 'v2' }
      })
    ).toThrow(DuplicateRiskError)
  })

  it('without a valid single-use authorization nothing is dispatched', async () => {
    const p = slowVideo()
    const tracker = new JobTracker(deps(p))
    const mk = (): ReturnType<JobTracker['create']> =>
      tracker.create({
        providerId: p.info().id,
        request,
        requestedBy: { conversationId: 'c', messageIndex: 0 },
        target: { artifactId: 'a', versionId: 'v' }
      })
    // None at all.
    const a = mk()
    expect(await tracker.submit(a.id)).toMatchObject({
      state: 'failed',
      dispatch: { state: 'not-dispatched', repeat: { risk: 'safe' } }
    })
    // One minted for another job.
    const b = mk()
    const c = mk()
    expect((await tracker.submit(c.id, undefined, auth(tracker, b.id))).state).toBe('failed')
    // A token for a changed request (another prompt).
    const d = mk()
    const other = authorizations.mint({
      ...tracker.submitBinding(d.id),
      argsSha256: 'changed'
    })
    expect((await tracker.submit(d.id, undefined, other)).error).toMatch(/request changed/)
    expect(p.calls.submit).toHaveLength(0)
  })

  it('a built-in provider consumes its token once; replay is refused', () => {
    const t = authorizations.mint({
      action: 'submit',
      jobId: 'j',
      conversationId: 'c',
      source: { kind: 'image-provider', provider: 'x', model: 'm' },
      operation: 'image.generate',
      argsSha256: 'a',
      references: []
    })
    const b = {
      action: 'submit' as const,
      jobId: 'j',
      conversationId: 'c',
      source: { kind: 'image-provider' as const, provider: 'x', model: 'm' },
      operation: 'image.generate',
      argsSha256: 'a',
      references: []
    }
    expect(() => authorizations.consume(t, b)).not.toThrow()
    expect(() => authorizations.consume(t, b)).toThrow(/no valid approval/)
    // A changed reference file is refused, and the token is gone after.
    const t2 = authorizations.mint({ ...b, references: [{ attachmentId: 'r', sha256: '1' }] })
    expect(() =>
      authorizations.consume(t2, { ...b, references: [{ attachmentId: 'r', sha256: '2' }] })
    ).toThrow(/files to send changed/)
    expect(() =>
      authorizations.consume(t2, { ...b, references: [{ attachmentId: 'r', sha256: '1' }] })
    ).toThrow(/no valid approval/)
  })

  it('reuses the key only where the provider deduplicates', async () => {
    const p = slowVideo({ submit: 'lost', idempotency: true })
    const tracker = new JobTracker(deps(p))
    const job = tracker.create({
      providerId: p.info().id,
      request,
      approval: approveSubmission(p.info().source, request, 0),
      requestedBy: { conversationId: 'c', messageIndex: 0 },
      target: { artifactId: 'a', versionId: 'v' }
    })
    await tracker.submit(job.id, undefined, auth(tracker, job.id))
    const again = tracker.resubmitJob(job.id, {
      acknowledgeDuplicateRisk: false,
      requestedBy: { conversationId: 'c', messageIndex: 2 },
      target: { artifactId: 'a', versionId: 'v2' },
      approval: approveSubmission(p.info().source, request, 1)
    })
    expect(again.idempotencyKey).toBe(job.idempotencyKey)
  })

  it('a restart mid-submission is unknown, and nothing is tracked until asked', () => {
    const p = slowVideo()
    const stuck: Job = {
      id: 'j1',
      idempotencyKey: 'j1',
      providerId: p.info().id,
      request,
      approval: approveSubmission(p.info().source, request, 0),
      requestedBy: { conversationId: 'c', messageIndex: 0 },
      target: { artifactId: 'a', versionId: 'v' },
      state: 'not-submitted',
      attemptedAt: 5,
      tracking: false,
      checks: 0,
      createdAt: 1,
      updatedAt: 5
    }
    const running: Job = {
      ...stuck,
      id: 'j2',
      idempotencyKey: 'j2',
      state: 'running',
      remoteId: 'r',
      tracking: true
    }
    const tracker = new JobTracker(deps(p), [stuck, running])
    expect(tracker.get('j1')).toMatchObject({ state: 'unknown' })
    expect(tracker.get('j2')).toMatchObject({ state: 'running', tracking: false })
    expect(p.calls.status + p.calls.submit.length).toBe(0)
  })

  it('cancels only on confirmation; stopping tracking cancels nothing', async () => {
    const p = slowVideo({ steps: [{ state: 'running' }] })
    const tracker = new JobTracker(deps(p))
    const mk = (): Job =>
      tracker.create({
        providerId: p.info().id,
        request,
        approval: approveSubmission(p.info().source, request, 0),
        requestedBy: { conversationId: 'c', messageIndex: 0 },
        target: { artifactId: 'a', versionId: 'v' }
      })
    const a = mk()
    await tracker.submit(a.id, undefined, auth(tracker, a.id))
    expect(tracker.stopTracking(a.id)).toMatchObject({ state: 'pending', tracking: false })
    expect(p.calls.cancel).toBe(0)
    expect(await tracker.cancel(a.id, authCancel(tracker, a.id))).toMatchObject({
      state: 'cancelled'
    })
    const noCancel = slowVideo({ cancel: false })
    const t2 = new JobTracker(deps(noCancel))
    const b = t2.create({
      providerId: noCancel.info().id,
      request,
      approval: approveSubmission(noCancel.info().source, request, 0),
      requestedBy: { conversationId: 'c', messageIndex: 0 },
      target: { artifactId: 'a', versionId: 'v' }
    })
    await t2.submit(b.id, undefined, auth(t2, b.id))
    await expect(t2.cancel(b.id, authCancel(t2, b.id))).rejects.toThrow(/can't cancel/)
  })

  it('a disabled provider stops new work but keeps the job record', async () => {
    const p = slowVideo({ state: 'disabled' })
    const tracker = new JobTracker(deps(p), [])
    expect(() =>
      tracker.create({
        providerId: 'nope',
        request,
        requestedBy: { conversationId: 'c', messageIndex: 0 },
        target: { artifactId: 'a', versionId: 'v' }
      })
    ).toThrow(JobError)
    const kept: Job = {
      id: 'j',
      idempotencyKey: 'j',
      providerId: p.info().id,
      request,
      approval: approveSubmission(p.info().source, request, 0),
      requestedBy: { conversationId: 'c', messageIndex: 0 },
      target: { artifactId: 'a', versionId: 'v' },
      state: 'completed',
      remoteId: 'r',
      tracking: false,
      checks: 3,
      createdAt: 1,
      updatedAt: 2
    }
    const t = new JobTracker(deps(p), [kept])
    expect(t.list('c')).toHaveLength(1)
    await expect(t.check('j')).rejects.toThrow(/isn't ready/)
  })
})

describe('skills: precedence and provenance', () => {
  const c = (
    path: string,
    strength: Candidate['strength'],
    over: Partial<Candidate> = {}
  ): Candidate => ({
    path,
    name: path,
    strength,
    available: true,
    conflicts: [],
    ...over
  })

  it('applies explicit and clear skills, with a note', () => {
    const plan = planSkills([c('brand', 'explicit'), c('a11y', 'clear')])
    expect(plan.apply.map((a) => [a.path, a.how])).toEqual([
      ['brand', 'explicit'],
      ['a11y', 'matched']
    ])
    expect(plan.notes[0]).toBe('Used: brand, a11y.')
    expect(plan.ask).toBeNull()
  })

  it('explains similar skills, and asks only when it would matter', () => {
    expect(planSkills([c('dark', 'similar')])).toMatchObject({ apply: [], ask: null })
    expect(planSkills([c('dark', 'similar', { material: true })]).ask).toMatch(/should I use it/)
  })

  it('asks about conflicting matches instead of blending them', () => {
    const plan = planSkills([
      c('minimal', 'clear', { conflicts: ['maximal'] }),
      c('maximal', 'clear', { conflicts: ['minimal'] })
    ])
    expect(plan.apply).toEqual([])
    expect(plan.ask).toMatch(/disagree/)
  })

  it('an explicit skill wins over a conflicting match; a missing one is said', () => {
    const plan = planSkills([
      c('brand', 'explicit', { conflicts: ['other'] }),
      c('other', 'clear', { conflicts: ['brand'] }),
      c('gone', 'explicit', { available: false })
    ])
    expect(plan.apply.map((a) => a.path)).toEqual(['brand'])
    expect(plan.notes.join(' ')).toMatch(/isn't available/)
    expect(plan.notes.join(' ')).toMatch(/conflicts with the skill you named/)
  })

  it('no match means defaults', () => {
    expect(planSkills([])).toEqual({ apply: [], notes: [], ask: null })
  })

  describe('provenance', () => {
    let vault: string
    beforeEach(() => {
      vault = mkdtempSync(join(tmpdir(), 'custard-prov-'))
      mkdirSync(join(vault, 'Custard/Skills/brand'), { recursive: true })
      writeFileSync(join(vault, 'Custard/Skills/brand/SKILL.md'), 'Use amber.\n')
    })
    afterEach(() => rmSync(vault, { recursive: true, force: true }))

    it('records a fingerprint and the guidance relied on, and detects changes', () => {
      const path = 'Custard/Skills/brand/SKILL.md'
      const use = skillUse(vault, { path, name: 'brand', how: 'matched', guidance: 'Use amber.' })
      expect(use.fingerprint).toBe(fingerprint('Use amber.\n'))
      expect(skillChanges(vault, [use])[0].state).toBe('same')
      writeFileSync(join(vault, path), 'Use teal.\n')
      expect(skillChanges(vault, [use])[0].state).toBe('changed')
      rmSync(join(vault, path))
      expect(skillChanges(vault, [use])[0].state).toBe('missing')
      // The version still has what it was made with.
      expect(use.guidance).toBe('Use amber.')
    })
  })
})

describe('the media fixture stays a development fixture', () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n)
      return statSync(p).isDirectory() ? walk(p) : [p]
    })

  it('no app source imports it, and no bundled plugin is it', () => {
    const root = join(__dirname, '..', '..', '..')
    const offenders = walk(join(root, 'src'))
      .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f))
      .filter((f) => /fixtures\/media|slow-video/.test(readFileSync(f, 'utf8')))
    expect(offenders).toEqual([])
    const bundled = walk(join(root, 'plugin')).filter((f) => f.endsWith('plugin.json'))
    for (const f of bundled) expect(readFileSync(f, 'utf8')).not.toMatch(/dev-slow-video/)
  })
})
