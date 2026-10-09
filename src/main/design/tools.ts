import type { BetaTool } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import {
  MediaError,
  mediaOperations,
  type Artifact,
  type DesignEvent,
  type DesignSettings,
  type DesignToolName,
  type Job,
  type MediaFile,
  type MediaOperation,
  type MediaProvider,
  type MediaReference,
  type MediaRequest,
  type Source
} from '../../shared/design'
import type { Provider } from '../../shared/chat'
import type { ToolRun } from '../turn'
import { discoverCapabilities, type Failure } from './capabilities'
import { checkRequest } from './media'
import { createArtifact, settleVersion, startVersion, VersionError } from './versions'
import { JobError, type JobTracker } from './jobs'
import { authorizations, bindingFor } from './authorization'
import type { ArtifactStore } from './store'

// Design mode's tools. Only Design is offered them (modes/policy.ts), and
// each call runs through here:
//   design_html   create or revise an HTML output. Workstream A registers it.
//   design_media  ask a media provider for an image or video: one approved
//                 submission, one job, one new version. Provider-agnostic.
//   design_jobs   check, cancel or stop tracking a job, when asked.
// Nothing here runs on its own: no timers, no follow-up submissions.

export type DesignService = {
  artifacts: ArtifactStore
  jobs: JobTracker
  providers: () => MediaProvider[]
  settings: () => DesignSettings
  // This session's failures, for capability reports.
  failures: Failure[]
  emit: (e: DesignEvent) => void
}

export type DesignToolContext = {
  conversationId: string
  // The user message this turn answers.
  messageIndex: number
  chat: { provider: Provider; model: string; hasKey: boolean }
  // An approval card (one at a time, never "for this chat").
  approve: (label: string, detail: string) => Promise<boolean>
  // Attachment ids from this chat to media references (Workstream A).
  references: (ids: string[]) => Promise<MediaReference[]>
  signal: AbortSignal
}

export type DesignToolHandler = (
  service: DesignService,
  input: unknown,
  ctx: DesignToolContext
) => Promise<ToolRun>

const handlers = new Map<DesignToolName, DesignToolHandler>()
// A handler may bring its own schema in place of the base entry.
const schemas = new Map<DesignToolName, BetaTool>()
export const setDesignToolHandler = (
  name: DesignToolName,
  h: DesignToolHandler,
  schema?: BetaTool
): void => {
  handlers.set(name, h)
  if (schema) schemas.set(name, { ...schema, name })
}

const notRun = (content: string): ToolRun => ({ content, isError: true, outcome: 'not-run' })

export const designToolSchemas: BetaTool[] = [
  {
    name: 'design_html',
    description:
      "Creates an HTML output (a page or mockup) in Design's workspace, or a new version of one. Always send the complete document; it's shown only once complete, in a sandbox with no network.",
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short name for a new output.' },
        artifact: { type: 'string', description: 'The output to change; omit for a new one.' },
        from: {
          type: 'string',
          description: 'The version to start from; omit for the selected one.'
        },
        relation: { type: 'string', enum: ['revision', 'variation'] },
        html: { type: 'string', description: 'The complete HTML document.' },
        skills: {
          type: 'array',
          description: 'Skills applied: vault path and how chosen.',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              how: { type: 'string', enum: ['explicit', 'matched'] },
              guidance: { type: 'string' }
            },
            required: ['path', 'how']
          }
        }
      },
      required: ['html']
    },
    eager_input_streaming: true
  },
  {
    name: 'design_media',
    description:
      'Asks the configured media provider to make an image or video. The user sees the provider, the operation, the prompt and any files sent, and must allow it first. Returns a job to check with design_jobs. Never retried or repeated on its own.',
    input_schema: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: [...mediaOperations] },
        prompt: { type: 'string' },
        name: { type: 'string', description: 'Short name for a new output.' },
        artifact: { type: 'string', description: 'The output to add a version to; omit for new.' },
        from: { type: 'string', description: 'The version to start from.' },
        relation: { type: 'string', enum: ['revision', 'variation'] },
        references: {
          type: 'array',
          items: { type: 'string' },
          description: 'Files the user attached in this chat, by exact file name.'
        },
        size: {
          type: 'object',
          properties: { width: { type: 'integer' }, height: { type: 'integer' } }
        },
        durationSeconds: { type: 'number' },
        format: { type: 'string' }
      },
      required: ['operation', 'prompt']
    }
  },
  {
    name: 'design_jobs',
    description:
      "Checks a generation job once, cancels it (only if the provider can), or stops tracking it (it keeps running at the provider). Only when the user asks or right after submitting; don't loop.",
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['check', 'cancel', 'stop'] },
        job: { type: 'string' }
      },
      required: ['action', 'job']
    }
  }
]

const sameSource = (a: Source, b: Source): boolean => JSON.stringify(a) === JSON.stringify(b)
const NAMES: Record<MediaOperation, string> = {
  'image.generate': 'Generate an image',
  'image.edit': 'Edit an image',
  'image.variation': 'Make a variation of an image',
  'video.text-to-video': 'Make a video from text',
  'video.image-to-video': 'Make a video from an image'
}
const kb = (n: number): string => `${Math.max(1, Math.round(n / 1024)).toLocaleString('en-US')} KB`

function describeJob(job: Job): string {
  const where = `Job ${job.id} is ${job.state}`
  const progress =
    job.progress !== undefined ? ` (${Math.round(job.progress * 100)}% per the provider)` : ''
  return `${where}${progress}.${job.error ? ` ${job.error}` : ''}`
}

// A submission that went through: earlier failures of this source no longer
// describe it.
function clearFailures(s: DesignService, op: MediaOperation, source: Source): void {
  for (let n = s.failures.length - 1; n >= 0; n--)
    if (s.failures[n].operation === op && sameSource(s.failures[n].source, source))
      s.failures.splice(n, 1)
}

async function media(s: DesignService, input: unknown, ctx: DesignToolContext): Promise<ToolRun> {
  const i = (input ?? {}) as Record<string, unknown>
  const op = i.operation as MediaOperation
  if (!mediaOperations.includes(op)) return notRun('Unknown operation, so nothing was done.')
  if (typeof i.prompt !== 'string') return notRun('A prompt is required.')
  const providers = s.providers()
  const report = discoverCapabilities({
    chat: ctx.chat,
    design: s.settings(),
    providers: providers.map((p) => p.info()),
    failures: s.failures
  })[op]
  const a = report.availability
  // A temporary failure is shown, but doesn't refuse a new request: the user
  // asked again, and the request still needs its own approval.
  if (a.status === 'unavailable' && !(a.cause === 'failed' && a.temporary && a.via))
    return notRun(
      `${NAMES[op]} isn't available (${a.cause}): ${a.reason}${a.fix ? ` ${a.fix.text}` : ''}`
    )
  const provider = providers.find((p) => sameSource(p.info().source, a.via!))
  const info = provider?.info()
  const cap = info?.capabilities.find((c) => c.operation === op)
  if (!provider || !info || !cap) return notRun('The provider is no longer available.')
  let references: MediaReference[] = []
  try {
    const ids = Array.isArray(i.references) ? i.references.map(String) : []
    if (ids.length) references = await ctx.references(ids)
  } catch (err) {
    return notRun(err instanceof Error ? err.message : String(err))
  }
  const request: MediaRequest = {
    operation: op,
    prompt: i.prompt,
    references,
    ...(i.size && typeof i.size === 'object' ? { size: i.size as MediaRequest['size'] } : {}),
    ...(typeof i.durationSeconds === 'number' ? { durationSeconds: i.durationSeconds } : {}),
    ...(typeof i.format === 'string' ? { format: i.format } : {})
  }
  const wrong = checkRequest(request, cap)
  if (wrong) return notRun(`${wrong} Nothing was sent.`)

  const kind = op.startsWith('video.') ? 'video' : 'image'
  let artifact: Artifact
  let versionId: string
  try {
    if (typeof i.artifact === 'string') {
      const existing = s.artifacts.get(ctx.conversationId, i.artifact)
      if (!existing) return notRun('There is no such output in this chat.')
      if (existing.kind !== kind)
        return notRun(`That output isn't ${kind === 'image' ? 'an image' : 'a video'}.`)
      const r = startVersion(
        existing,
        typeof i.from === 'string' ? i.from : existing.selected,
        i.relation === 'variation' ? 'variation' : 'revision',
        { source: info.source, skills: [] }
      )
      artifact = r.artifact
      versionId = r.version.id
    } else {
      const r = createArtifact({
        conversationId: ctx.conversationId,
        name: (typeof i.name === 'string' && i.name.trim()) || i.prompt.slice(0, 40),
        kind,
        source: info.source,
        skills: []
      })
      artifact = r.artifact
      versionId = r.version.id
    }
  } catch (err) {
    if (err instanceof VersionError) return notRun(err.message)
    throw err
  }

  const allowed = await ctx.approve(
    `${info.name}: ${NAMES[op]}`,
    [
      `Provider: ${info.name}`,
      `Operation: ${NAMES[op]}`,
      references.length
        ? `Files sent to ${info.name}: ${references.map((r) => `${r.name} (${kb(r.bytes)})`).join(', ')}`
        : 'No files are sent.',
      cap.pricing
        ? `Price: ${cap.pricing.text} (from ${cap.pricing.source})`
        : 'No price information from the provider.',
      ...(cap.cancel ? [] : ["It can't be cancelled once submitted."]),
      ...(a.status === 'quality-uncertain' ? [`Note: ${a.uncertainty}`] : []),
      '',
      request.prompt
    ].join('\n')
  )
  if (!allowed)
    return notRun(
      ctx.signal.aborted
        ? 'Stopped before it ran, so nothing was done.'
        : 'The user declined, so nothing was sent.'
    )

  s.artifacts.save(artifact)
  s.emit({ type: 'artifact', conversationId: ctx.conversationId, artifact })
  let job: Job
  try {
    job = s.jobs.create({
      providerId: info.id,
      request,
      requestedBy: { conversationId: ctx.conversationId, messageIndex: ctx.messageIndex },
      target: { artifactId: artifact.id, versionId }
    })
  } catch (err) {
    artifact = settleVersion(artifact, versionId, { status: 'failed', error: String(err) })
    s.artifacts.save(artifact)
    s.emit({ type: 'artifact', conversationId: ctx.conversationId, artifact })
    return notRun(err instanceof Error ? err.message : String(err))
  }
  // The user approved this request above: mint its single-use authorization
  // (contract S3), bound to this job, provider (build) and exact request.
  const token = authorizations.mint(
    bindingFor('submit', {
      jobId: job.id,
      conversationId: ctx.conversationId,
      source: info.source,
      request
    })
  )
  try {
    job = await s.jobs.submit(job.id, ctx.signal, token)
  } catch (err) {
    // Refused before sending (e.g. the provider stopped being ready after
    // the card): nothing was sent; settle the version rather than leave it
    // pending.
    if (!(err instanceof JobError)) throw err
    artifact = settleVersion(artifact, versionId, { status: 'failed', error: err.message })
    s.artifacts.save(artifact)
    s.emit({ type: 'artifact', conversationId: ctx.conversationId, artifact })
    return notRun(`${err.message} Nothing was sent.`)
  }
  s.emit({ type: 'job', conversationId: ctx.conversationId, job })
  // Only failures that say something about the provider are kept for the
  // session. A refused prompt (rejected) says nothing about the next one, so
  // it never makes the operation unavailable.
  if (job.state === 'failed' && job.errorKind && job.errorKind !== 'rejected')
    s.failures.push({
      operation: op,
      source: info.source,
      reason: job.error ?? 'Failed.',
      temporary: job.errorKind === 'temporary'
    })
  else if (job.state !== 'failed' && job.state !== 'unknown') clearFailures(s, op, info.source)
  if (job.state === 'failed') {
    artifact = settleVersion(artifact, versionId, {
      status: 'failed',
      error: job.error ?? 'Failed.'
    })
    s.artifacts.save(artifact)
    s.emit({ type: 'artifact', conversationId: ctx.conversationId, artifact })
    return { content: `${info.name} refused it: ${job.error}`, isError: true, outcome: 'failed' }
  }
  // Finished at submission (a synchronous provider): save the files now.
  if (job.state === 'completed') {
    const r = await jobAction(s, ctx.conversationId, 'check', job.id, ctx.signal)
    const saved = s.artifacts
      .get(ctx.conversationId, artifact.id)
      ?.versions.find((v) => v.id === versionId)?.status
    return saved === 'succeeded'
      ? {
          content: `Made by ${info.name}. Output ${artifact.id}, version ${versionId}.`,
          isError: false,
          outcome: 'completed'
        }
      : {
          content: `${info.name} finished, but ${r.text} Check it again with design_jobs; it won't be sent again.`,
          isError: true,
          outcome: 'completed'
        }
  }
  if (job.state === 'unknown')
    return {
      content: `${describeJob(job)} Don't send it again without asking the user: it may run and be charged twice.`,
      isError: true,
      outcome: 'unknown'
    }
  return {
    content: `Submitted to ${info.name}. ${describeJob(job)} Output ${artifact.id}, version ${versionId}. Check it with design_jobs when the user asks.`,
    isError: false,
    outcome: 'completed'
  }
}

// One check, cancel or stop, from the model or the workspace.
export async function jobAction(
  s: DesignService,
  conversationId: string,
  action: 'check' | 'cancel' | 'stop',
  jobId: string,
  signal?: AbortSignal,
  // cancel only: the user's explicit go-ahead (an approval card for the
  // model, the workspace's confirmation for the user). Without it nothing
  // is cancelled.
  confirmCancel?: (label: string, detail: string) => Promise<boolean>
): Promise<{ job: Job; text: string }> {
  const job = s.jobs.get(jobId)
  if (!job || job.requestedBy.conversationId !== conversationId)
    throw new JobError('There is no such job in this chat.')
  let next: Job
  let files: Awaited<ReturnType<JobTracker['check']>>['files']
  if (action === 'stop') next = s.jobs.stopTracking(jobId)
  else if (action === 'cancel') {
    // Cancelling changes state at the provider (contract S3).
    const name = s
      .providers()
      .find((p) => p.info().id === job.providerId)
      ?.info().name
    const ok =
      !!confirmCancel &&
      (await confirmCancel(
        `${name ?? 'Provider'}: cancel a job`,
        `Asks ${name ?? 'the provider'} to cancel job ${job.id}. It counts as cancelled only if the provider confirms; whether anything was already charged is up to the provider.`
      ))
    if (!ok) throw new JobError('Cancelling was not confirmed, so nothing was cancelled.')
    next = await s.jobs.cancel(jobId, authorizations.mint(s.jobs.cancelBinding(jobId)))
  } else {
    // A completed job whose version is still waiting for its files.
    const waiting =
      job.state === 'completed' &&
      s.artifacts
        .get(conversationId, job.target.artifactId)
        ?.versions.find((v) => v.id === job.target.versionId)?.status === 'pending'
    ;({ job: next, files } = waiting
      ? await s.jobs.collect(jobId, signal)
      : await s.jobs.check(jobId, signal))
  }
  settleJobVersion(s, conversationId, next, files)
  s.emit({ type: 'job', conversationId, job: next })
  const text =
    action === 'stop'
      ? `Stopped tracking job ${next.id}. It keeps running at the provider.`
      : files?.length
        ? `${describeJob(next)} The result is saved as a new version.`
        : describeJob(next)
  return { job: next, text }
}

// A job's outcome on its pending version: its files stored (the normal
// save path: name cleaning, store limits, read-only files), or its failure
// or cancellation recorded. Used by checks and by startup reconciliation
// (reconcile.ts), so a recovered result goes through the same validation.
export function settleJobVersion(
  s: Pick<DesignService, 'artifacts' | 'emit'>,
  conversationId: string,
  next: Job,
  files?: MediaFile[]
): void {
  let artifact = s.artifacts.get(conversationId, next.target.artifactId)
  const version = artifact?.versions.find((v) => v.id === next.target.versionId)
  if (artifact && version?.status === 'pending') {
    if (files?.length) {
      const records = s.artifacts.writeFiles(
        conversationId,
        artifact.id,
        version.id,
        files.map((f, n) => ({ path: safeName(f.name, n), mime: f.mime, bytes: f.bytes }))
      )
      artifact = settleVersion(artifact, version.id, { status: 'succeeded', files: records })
    } else if (next.state === 'failed' || next.state === 'cancelled')
      artifact = settleVersion(artifact, version.id, {
        status: next.state,
        error: next.error ?? (next.state === 'cancelled' ? 'Cancelled.' : 'Failed.')
      })
    if (artifact.versions.find((v) => v.id === version.id)?.status !== 'pending') {
      s.artifacts.save(artifact)
      s.emit({ type: 'artifact', conversationId, artifact })
    }
  }
}

// Provider file names are untrusted: keep a plain name, or number it.
function safeName(name: string, n: number): string {
  const base = name.split(/[\\/]/).pop() ?? ''
  const clean = base
    .replace(/[^A-Za-z0-9_.-]/g, '_')
    .replace(/^[._]+/, '')
    .replace(/[. ]+$/, '')
    .slice(0, 80)
  return clean && /^[A-Za-z0-9_]/.test(clean) ? clean : `file-${n + 1}`
}

async function jobs(s: DesignService, input: unknown, ctx: DesignToolContext): Promise<ToolRun> {
  const i = (input ?? {}) as Record<string, unknown>
  if (i.action !== 'check' && i.action !== 'cancel' && i.action !== 'stop')
    return notRun('Unknown action.')
  try {
    const r = await jobAction(
      s,
      ctx.conversationId,
      i.action,
      String(i.job),
      ctx.signal,
      ctx.approve
    )
    return { content: r.text, isError: false, outcome: 'completed' }
  } catch (err) {
    if (err instanceof JobError) return notRun(err.message)
    if (err instanceof MediaError) return { content: err.message, isError: true, outcome: 'failed' }
    throw err
  }
}

handlers.set('design_media', media)
handlers.set('design_jobs', jobs)

export async function runDesignTool(
  s: DesignService,
  name: string,
  input: unknown,
  ctx: DesignToolContext
): Promise<ToolRun> {
  const h = handlers.get(name as DesignToolName)
  if (!h) return notRun(`${name} isn't available yet, so nothing was done.`)
  return h(s, input, ctx)
}

// Tools offered: only those with a handler.
export const designTools = (): BetaTool[] =>
  designToolSchemas
    .filter((t) => handlers.has(t.name as DesignToolName))
    .map((t) => schemas.get(t.name as DesignToolName) ?? t)
