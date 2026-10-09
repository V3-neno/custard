import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import vm from 'vm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultDesignSettings, type Job, type MediaProvider } from '../../../shared/design'
import {
  PluginHost,
  type ApprovalRequest,
  type MediaApproval,
  type MediaRole,
  type RuntimeFactory
} from '../../plugins/host'
import { parseManifest, permissionsOf } from '../../plugins/manifest'
import { PluginStore } from '../../plugins/store'
import { DuplicateRiskError, JobTracker } from '../jobs'
import { approvalDigest, approveSubmission, digestOf, sha256 } from '../approval'
import { ArtifactStore, JobStore } from '../store'
import { jobAction, runDesignTool, type DesignService, type DesignToolContext } from '../tools'
import { pluginMediaProviders, providerIdOf, readStatus, type PluginMediaDeps } from './adapter'
import { fetchResult, sniff, type BinaryTransport } from './results'

// Plugin media end to end without Electron: the real plugin host (real
// esbuild builds of the dev fixture in test/fixtures/media-plugins) with a
// vm stand-in for the sandbox, the adapter, and Design's own job flow. The
// vm is not a security boundary; the real sandbox is covered by
// test/electron and the e2e run.

const SDK = resolve(__dirname, '../../../plugin-sdk')
const FIXTURE = resolve(__dirname, '../../../../test/fixtures/media-plugins/slowmo')
const CHAT = '11111111-2222-3333-4444-555555555555'
const PROVIDER = providerIdOf('slowmo', 'video')

type Bridge = {
  call(callId: string, tool: string, input: unknown, config: unknown): Promise<unknown>
  cancel(callId: string): void
  tools(): string[]
}

const vmRuntime: RuntimeFactory = async ({ code, onCap }) => {
  let h: Bridge | null = null
  const context = vm.createContext({
    custardPluginHost: {
      register: (x: Bridge) => (h = x),
      cap: (id: string, n: string, a: unknown) => onCap(id, n, a)
    },
    AbortController,
    setTimeout,
    clearTimeout,
    URL,
    console
  })
  vm.runInContext(code, context, { timeout: 2000 })
  const bridge = h as unknown as Bridge
  return {
    tools: bridge.tools(),
    handle: {
      dispose: () => {},
      call: async (callId, tool, input, config) =>
        (await bridge.call(callId, tool, JSON.parse(JSON.stringify(input)), config)) as never
    }
  }
}

const crypto = {
  available: () => true,
  encrypt: (s: string) => Buffer.from(`enc:${s}`),
  decrypt: (b: Buffer) => b.toString().slice(4)
}

let base: string
let pluginAsks: ApprovalRequest[]
let decision: 'design-card' | 'pending'
let transport: BinaryTransport | undefined
let clock: number

function newHost(): PluginHost {
  return new PluginHost({
    sourceRoot: () => join(base, 'plugin'),
    sdkDir: SDK,
    store: new PluginStore(join(base, 'plugins'), crypto),
    runtime: vmRuntime,
    testRunner: async () => [],
    openExternal: async () => {},
    openBrowser: async () => {},
    askByDefault: () => true
  })
}

async function install(host: PluginHost): Promise<void> {
  const v = await host.validate('slowmo')
  expect(v.errors).toEqual([])
  await host.activate('slowmo', v.buildId!, permissionsOf(v.manifest!))
}

function deps(host: PluginHost): PluginMediaDeps {
  return {
    catalog: () => host.mediaCatalog(),
    invoke: (a, o) =>
      host.invokeMedia(a, {
        ...o,
        // Records any card the plugin host would raise for these calls.
        approve: async (r) => {
          pluginAsks.push(r)
          return o.approve(r)
        }
      }),
    hosts: (id) => host.mediaHosts(id),
    submitApproval: () => decision,
    transport: () => transport
  }
}

function service(host: PluginHost, saved: Job[] = []): DesignService & { jobStore: JobStore } {
  const jobStore = new JobStore(join(base, 'design', 'jobs.json'))
  const providers = (): MediaProvider[] => pluginMediaProviders(deps(host))
  return {
    artifacts: new ArtifactStore(join(base, 'design')),
    jobs: new JobTracker(
      {
        provider: (id) => providers().find((p) => p.info().id === id) ?? null,
        save: (j) => jobStore.save(j),
        read: async () => REF_BYTES,
        now: () => (clock += 2000)
      },
      saved
    ),
    providers,
    settings: () => defaultDesignSettings,
    failures: [],
    emit: () => {},
    jobStore
  }
}

// What the test attachment "contains", and its fingerprint as the chat's
// attachment record would carry it.
const REF_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])

const ctx = (): DesignToolContext & { asked: string[] } => {
  const asked: string[] = []
  return {
    conversationId: CHAT,
    messageIndex: 0,
    chat: { provider: 'claude', model: 'claude-opus-5-5', hasKey: true },
    approve: async (label, detail) => {
      asked.push(`${label}\n${detail}`)
      return true
    },
    references: async (ids) =>
      ids.map((id) => ({
        kind: 'image',
        name: 'ref.png',
        mime: 'image/png',
        bytes: 95,
        attachmentId: id,
        sha256: 'h'
      })),
    signal: new AbortController().signal,
    asked
  }
}

async function fixtureJobs(
  host: PluginHost
): Promise<{ id: string; key: string; state: string }[]> {
  // The fixture's own read tool, straight through the host.
  const r = await host.invoke(
    'slowmo__jobs',
    {},
    {
      snapshot: new Map([
        ['slowmo__jobs', { pluginId: 'slowmo', buildId: host.status('slowmo').active!.buildId }]
      ]),
      signal: new AbortController().signal,
      approve: async () => false
    }
  )
  return JSON.parse(r.content)
}

const submit = (
  s: DesignService,
  c: DesignToolContext,
  prompt: string,
  extra = {}
): ReturnType<typeof runDesignTool> =>
  runDesignTool(s, 'design_media', { operation: 'video.text-to-video', prompt, ...extra }, c)

async function checkUntilDone(s: DesignService, jobId: string): Promise<Job> {
  for (let i = 0; i < 6; i++) {
    const { job } = await jobAction(s, CHAT, 'check', jobId)
    if (!['pending', 'running'].includes(job.state)) return job
  }
  return s.jobs.get(jobId)!
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'custard-plugin-media-'))
  cpSync(FIXTURE, join(base, 'plugin', 'slowmo'), { recursive: true })
  pluginAsks = []
  decision = 'design-card'
  transport = undefined
  clock = 1_000_000
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

describe('media manifest', () => {
  const fixture = (): Record<string, unknown> =>
    JSON.parse(readFileSync(join(FIXTURE, 'plugin.json'), 'utf8'))
  const errorsOf = (m: Record<string, unknown>): string[] => parseManifest(m).errors
  const withCap = (change: (c: Record<string, unknown>) => void): Record<string, unknown> => {
    const m = fixture()
    const media = m.media as { capabilities: Record<string, unknown>[] }[]
    change(media[0].capabilities[0])
    return m
  }

  it('accepts the fixture and asks for media approval per provider', () => {
    const r = parseManifest(fixture(), 'slowmo')
    expect(r.errors).toEqual([])
    expect(r.manifest!.media![0].capabilities.map((c) => c.operation)).toEqual([
      'video.text-to-video',
      'video.image-to-video'
    ])
    expect(r.manifest!.media![0].capabilities[0].tools).toEqual({
      submit: 'submit',
      status: 'status',
      result: 'result',
      cancel: 'cancel'
    })
    expect(permissionsOf(r.manifest!)).toContain('media:video')
  })

  it('leaves a manifest without media exactly as before', () => {
    const raw = JSON.parse(
      readFileSync(resolve(__dirname, '../../../../plugin/spotify/plugin.json'), 'utf8')
    )
    const r = parseManifest(raw, 'spotify')
    expect(r.errors).toEqual([])
    expect('media' in r.manifest!).toBe(false)
    expect(permissionsOf(r.manifest!).some((p) => p.startsWith('media:'))).toBe(false)
  })

  it.each([
    [
      'a read tool as submit',
      withCap((c) => ((c.tools as Record<string, string>).submit = 'status')),
      /tools\.submit: status must be a write tool/
    ],
    [
      'a write tool as status',
      withCap((c) => ((c.tools as Record<string, string>).status = 'submit')),
      /tools\.status: submit must be a read tool/
    ],
    [
      'a read tool as cancel (cancelling changes the job at the provider)',
      withCap((c) => ((c.tools as Record<string, string>).cancel = 'jobs')),
      /tools\.cancel: jobs must be a write tool \(it changes the job at the provider\)/
    ],
    [
      'an unknown tool',
      withCap((c) => ((c.tools as Record<string, string>).result = 'nope')),
      /tools\.result: "nope" is not one of this plugin's tools/
    ],
    [
      'cancel true without a cancel tool',
      withCap((c) => delete (c.tools as Record<string, string>).cancel),
      /cancel is true, so tools\.cancel must name a tool/
    ],
    [
      'a cancel tool with cancel false',
      withCap((c) => (c.cancel = false)),
      /tools\.cancel is named but cancel is false/
    ],
    [
      'a capability Design rejects',
      withCap((c) => (c.formats = ['image/png'])),
      /media\[0\] \(video\): capabilities\[0\]: formats must list video\/\* types/
    ],
    [
      'an unsupported key',
      withCap((c) => ((c.tools as Record<string, string>).extra = 'jobs')),
      /tools\.extra is not supported/
    ]
  ])('rejects %s', (_, m, error) => {
    expect(errorsOf(m).join('\n')).toMatch(error)
  })

  it('needs the submit schema to take what Custard sends, and status to require remoteId', () => {
    const m = fixture()
    const tools = m.tools as { name: string; inputSchema: Record<string, unknown> }[]
    const submitTool = tools.find((t) => t.name === 'submit')!
    delete (submitTool.inputSchema.properties as Record<string, unknown>).prompt
    delete (submitTool.inputSchema.properties as Record<string, unknown>).references
    tools.find((t) => t.name === 'status')!.inputSchema.required = []
    const e = errorsOf(m).join('\n')
    expect(e).toMatch(/capabilities\[0\]: submit's inputSchema must declare prompt$/m)
    expect(e).toMatch(/capabilities\[1\]: submit's inputSchema must declare prompt, references$/m)
    expect(e).toMatch(/status's inputSchema must require remoteId/)
  })

  it('refuses media tools that a widget can also call, and malformed lists', () => {
    const m = fixture()
    m.widgets = [
      {
        id: 'w',
        title: 'W',
        description: 'A widget.',
        widgetApi: 1,
        entry: 'src/index.ts',
        tools: ['submit']
      }
    ]
    expect(errorsOf(m).join('\n')).toMatch(/submit can't also be a widget's tool/)
    expect(errorsOf({ ...fixture(), media: {} })).toContain(
      'media must be a list of 1 to 4 providers'
    )
    const dup = fixture()
    dup.media = [...(dup.media as unknown[]), ...(dup.media as unknown[])]
    expect(errorsOf(dup).join('\n')).toMatch(/duplicate media id/)
  })
})

describe('plugin host media route', () => {
  it("doesn't offer media tools to the model, and refuses them as plain tool calls", async () => {
    const host = newHost()
    await install(host)
    const { tools, snapshot } = host.toolSet()
    expect(tools.map((t) => t.name)).toEqual(['slowmo__jobs'])
    const r = await host.invoke(
      'slowmo__submit',
      { operation: 'video.text-to-video', prompt: 'x', idempotencyKey: 'k' },
      {
        snapshot,
        signal: new AbortController().signal,
        approve: async () => true
      }
    )
    expect(r.outcome).toBe('not-run')
    expect(await fixtureJobs(host)).toEqual([])
  })

  it('runs only the tool declared for the provider, operation and role', async () => {
    const host = newHost()
    await install(host)
    const o = { signal: new AbortController().signal, approve: async () => true }
    const bad = await host.invokeMedia(
      {
        pluginId: 'slowmo',
        providerId: 'video',
        operation: 'image.generate',
        role: 'submit',
        input: {}
      },
      o
    )
    expect(bad.outcome).toBe('not-run')
    const other = await host.invokeMedia(
      {
        pluginId: 'slowmo',
        providerId: 'nope',
        operation: 'video.text-to-video',
        role: 'status',
        input: { remoteId: 'x' }
      },
      o
    )
    expect(other.outcome).toBe('not-run')
  })

  it('reports why a provider is not ready', async () => {
    const host = newHost()
    await install(host)
    expect(host.mediaCatalog().map((e) => e.ready)).toEqual([true])
    host.disable('slowmo')
    expect(host.mediaCatalog()[0]).toMatchObject({
      ready: false,
      needs: expect.stringMatching(/turned off/)
    })
  })
})

describe('plugin media jobs', () => {
  it('submits once after one Design card, then checks to a stored, playable video', async () => {
    const host = newHost()
    await install(host)
    const s = service(host)
    const c = ctx()
    const r = await submit(s, c, 'a slow pan over a forge', { durationSeconds: 4 })
    expect(r.outcome).toBe('completed')
    expect(c.asked).toHaveLength(1)
    expect(c.asked[0]).toMatch(/Slowmo test video: Make a video from text/)
    expect(pluginAsks).toEqual([])
    const [job] = s.jobs.list(CHAT)
    expect(job).toMatchObject({ providerId: PROVIDER, state: 'pending' })
    const done = await checkUntilDone(s, job.id)
    expect(done.state).toBe('completed')
    const art = s.artifacts.get(CHAT, job.target.artifactId)!
    const v = art.versions.find((x) => x.id === job.target.versionId)!
    expect(v.status).toBe('succeeded')
    expect(v.source).toMatchObject({ kind: 'plugin', pluginId: 'slowmo', providerId: 'video' })
    expect(v.files[0].mime).toBe('video/webm')
    const bytes = s.artifacts.read(CHAT, art.id, v.id, v.files[0].path)!
    expect(sniff(bytes)).toBe('video/webm')
    // Status and result never submitted anything else.
    expect(await fixtureJobs(host)).toHaveLength(1)
    expect((await fixtureJobs(host))[0].key).toBe(job.idempotencyKey)
  })

  it('sends nothing while the approval decision is pending', async () => {
    decision = 'pending'
    const host = newHost()
    await install(host)
    const s = service(host)
    const r = await submit(s, ctx(), 'anything')
    expect(r.outcome).toBe('failed')
    expect(r.content).toMatch(/waiting on a decision/)
    expect(await fixtureJobs(host)).toEqual([])
    expect(s.jobs.list(CHAT)[0].state).toBe('failed')
  })

  it('sends an attached reference as bytes for image-to-video', async () => {
    const host = newHost()
    await install(host)
    const s = service(host)
    const c = ctx()
    const r = await runDesignTool(
      s,
      'design_media',
      { operation: 'video.image-to-video', prompt: 'animate it fast', references: ['att-1'] },
      c
    )
    expect(r.outcome).toBe('completed')
    expect(c.asked[0]).toMatch(/Files sent to Slowmo test video: ref\.png/)
    expect((await fixtureJobs(host))[0]).toMatchObject({ references: 1 })
  })

  it("a plugin's refusal, a lost or a garbled answer are all unknown", async () => {
    const host = newHost()
    await install(host)
    const s = service(host)
    // The plugin's "not sent" is only its claim (contract S1): unknown.
    expect((await submit(s, ctx(), 'please reject this')).outcome).toBe('unknown')
    expect(s.jobs.list(CHAT)[0].dispatch).toMatchObject({ providerClaim: 'not sent' })
    expect((await submit(s, ctx(), 'this gets lost')).outcome).toBe('unknown')
    expect((await submit(s, ctx(), 'garbled reply')).outcome).toBe('unknown')
    const states = s.jobs.list(CHAT).map((j) => j.state)
    expect(states).toEqual(['unknown', 'unknown', 'unknown'])
    // Sending an unknown one again needs the user to accept a possible double charge.
    const lost = s.jobs.list(CHAT)[1]
    expect(() =>
      s.jobs.resubmitJob(lost.id, {
        acknowledgeDuplicateRisk: false,
        requestedBy: lost.requestedBy,
        target: lost.target
      })
    ).toThrow(DuplicateRiskError)
  })

  it('a job fails when the provider says so, keeping no file', async () => {
    const host = newHost()
    await install(host)
    const s = service(host)
    await submit(s, ctx(), 'this will fail')
    const [job] = s.jobs.list(CHAT)
    const done = await checkUntilDone(s, job.id)
    expect(done).toMatchObject({ state: 'failed', error: 'The test service failed this job.' })
    const v = s.artifacts.get(CHAT, job.target.artifactId)!.versions[0]
    expect(v).toMatchObject({ status: 'failed', files: [] })
  })

  it('cancels only when asked, without the plugin card, and confirms', async () => {
    const host = newHost()
    await install(host)
    const s = service(host)
    await submit(s, ctx(), 'cancel me')
    const [job] = s.jobs.list(CHAT)
    const { job: after } = await jobAction(s, CHAT, 'cancel', job.id, undefined, async () => true)
    expect(after.state).toBe('cancelled')
    expect(pluginAsks).toEqual([])
    expect((await fixtureJobs(host))[0].state).toBe('cancelled')
  })

  it("the model's cancel asks on its own card; declining sends nothing", async () => {
    const host = newHost()
    await install(host)
    const s = service(host)
    await submit(s, ctx(), 'cancel me')
    const [job] = s.jobs.list(CHAT)
    const no = ctx()
    no.approve = async (label, detail) => {
      no.asked.push(`${label}\n${detail}`)
      return false
    }
    const r = await runDesignTool(s, 'design_jobs', { action: 'cancel', job: job.id }, no)
    expect(r.outcome).toBe('not-run')
    expect(no.asked[0]).toMatch(/Cancel a job[\s\S]*only when the provider confirms/)
    expect((await fixtureJobs(host))[0].state).not.toBe('cancelled')
    const yes = ctx()
    const ok = await runDesignTool(s, 'design_jobs', { action: 'cancel', job: job.id }, yes)
    expect(ok.content).toMatch(/cancelled/)
    expect(yes.asked).toHaveLength(1)
    expect((await fixtureJobs(host))[0].state).toBe('cancelled')
  })

  it('stop tracking is local and says the provider may keep charging', async () => {
    const host = newHost()
    await install(host)
    const s = service(host)
    await submit(s, ctx(), 'keep going')
    const [job] = s.jobs.list(CHAT)
    const r = await runDesignTool(s, 'design_jobs', { action: 'stop', job: job.id }, ctx())
    expect(r.content).toMatch(/keeps running \(and may be charged\)/)
    expect((await fixtureJobs(host))[0].state).not.toBe('cancelled')
  })

  it('survives a restart: tracking off, then checked to completion with no resubmission', async () => {
    const host = newHost()
    await install(host)
    const s = service(host)
    await submit(s, ctx(), 'restart test')
    const saved = s.jobStore.load()
    expect(saved[0].tracking).toBe(true)
    // Custard restarts: new host, new tracker from the saved records.
    const host2 = newHost()
    await host2.startAll()
    const s2 = service(host2, saved)
    expect(s2.jobs.list(CHAT)[0].tracking).toBe(false)
    const done = await checkUntilDone(s2, saved[0].id)
    expect(done.state).toBe('completed')
    expect(await fixtureJobs(host2)).toHaveLength(1)
  })

  it('a disabled or removed plugin keeps saved outputs but checks say why they cannot run', async () => {
    const host = newHost()
    await install(host)
    const s = service(host)
    await submit(s, ctx(), 'done fast')
    const [first] = s.jobs.list(CHAT)
    await checkUntilDone(s, first.id)
    await submit(s, ctx(), 'still going')
    const second = s.jobs.list(CHAT)[1]
    host.disable('slowmo')
    await expect(jobAction(s, CHAT, 'check', second.id)).rejects.toThrow(
      /isn't ready: the Slowmo .* turned off/
    )
    host.uninstall('slowmo')
    await expect(jobAction(s, CHAT, 'check', second.id)).rejects.toThrow(
      /removed or turned off.*Saved outputs stay/
    )
    const art = s.artifacts.get(CHAT, first.target.artifactId)!
    const v = art.versions[0]
    expect(v.status).toBe('succeeded')
    expect(s.artifacts.read(CHAT, art.id, v.id, v.files[0].path)).not.toBeNull()
    // And new submissions are refused with the reason.
    const r = await submit(s, ctx(), 'new one')
    expect(r.outcome).toBe('not-run')
  })

  it('fetches a result link only from the plugin’s approved hosts, and checks the type', async () => {
    const host = newHost()
    await install(host)
    const s = service(host)
    const clip = readFileSync(join(FIXTURE, 'src', 'clip.ts'), 'utf8').match(
      /'([A-Za-z0-9+/=]{1000,})'/
    )![1]
    const fetched: string[] = []
    transport = async ({ url }) => {
      fetched.push(url.toString())
      return { status: 200, headers: {}, body: new Uint8Array(Buffer.from(clip, 'base64')) }
    }
    await submit(s, ctx(), 'url fast')
    await submit(s, ctx(), 'evil-url fast')
    await submit(s, ctx(), 'wrong-type fast')
    const [ok, evil, wrong] = s.jobs.list(CHAT)
    expect((await checkUntilDone(s, ok.id)).state).toBe('completed')
    expect(fetched).toEqual(['https://media.example.com/clip.webm'])
    // A forbidden host or a wrong type is permanent: the job and its
    // version fail rather than being retried.
    const e = await checkUntilDone(s, evil.id)
    expect(e.state).toBe('failed')
    expect(e.error).toMatch(/no permission to connect to evil\.example\.net/)
    const w = await checkUntilDone(s, wrong.id)
    expect(w.state).toBe('failed')
    expect(w.error).toMatch(/says it is video\/webm but is image\/png/)
    for (const j of [e, w])
      expect(s.artifacts.get(CHAT, j.target.artifactId)!.versions[0].status).toBe('failed')
    expect(fetched).toHaveLength(1)
  })

  it('keeps a job open when its result link has expired, so a later check can fetch it', async () => {
    const host = newHost()
    await install(host)
    const s = service(host)
    transport = async () => ({ status: 410, headers: {}, body: new Uint8Array() })
    await submit(s, ctx(), 'url fast')
    const [job] = s.jobs.list(CHAT)
    const after = await checkUntilDone(s, job.id)
    expect(after.state).toBe('running')
    expect(after.error).toMatch(/expired/)
  })
})

describe('untrusted plugin output', () => {
  it('reads only well-formed statuses', () => {
    expect(readStatus({ state: 'running', progress: 0.4 })).toEqual({
      state: 'running',
      progress: 0.4
    })
    expect(readStatus({ state: 'running', progress: 4 })).toBeNull()
    expect(readStatus({ state: 'done' })).toBeNull()
    expect(readStatus({ state: 'failed', reason: 'x\u0000'.repeat(400) })!).toMatchObject({
      state: 'failed'
    })
    expect(
      (readStatus({ state: 'failed', reason: 'y'.repeat(900) }) as { reason: string }).reason
    ).toHaveLength(300)
  })

  it('treats expired links and oversized bodies as errors', async () => {
    const gone: BinaryTransport = async () => ({ status: 410, headers: {}, body: new Uint8Array() })
    await expect(
      fetchResult('https://media.example.com/a.webm', {
        allowedHosts: ['media.example.com'],
        transport: gone
      })
    ).rejects.toThrow(/expired/)
    const big: BinaryTransport = async () => ({
      status: 200,
      headers: {},
      body: new Uint8Array(20)
    })
    await expect(
      fetchResult('https://media.example.com/a.webm', {
        allowedHosts: ['media.example.com'],
        transport: big,
        maxBytes: 10
      })
    ).rejects.toThrow(/larger/)
    const hop: BinaryTransport = async () => ({
      status: 302,
      headers: { location: 'https://127.0.0.1/x' },
      body: new Uint8Array()
    })
    await expect(
      fetchResult('https://media.example.com/a.webm', { allowedHosts: ['*'], transport: hop })
    ).rejects.toThrow(/won't follow/)
    await expect(
      fetchResult('http://media.example.com/a', { allowedHosts: ['*'] })
    ).rejects.toThrow(/https/)
  })
})
