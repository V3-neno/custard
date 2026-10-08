import { randomUUID } from 'crypto'
import {
  MediaError,
  type Job,
  type MediaCapability,
  type MediaFile,
  type MediaProvider,
  type MediaReference,
  type MediaRequest,
  type RemoteStatus
} from '../../shared/design'
import { checkRequest } from './media'

// Generation jobs: one per user request, tracked only while Custard is open
// and only when asked. Nothing here runs on a timer, schedules anything,
// retries, or resubmits: every step is a call made because the user (or the
// turn answering them) asked for it. Each job is saved before anything is
// sent, so a crash mid-submission is known on restart and reported as
// outcome unknown, never quietly sent again.

export class JobError extends Error {}
// A resubmission that could run (and be charged) twice needs the user's
// informed go-ahead.
export class DuplicateRiskError extends JobError {}

export const JOB_LIMITS = {
  // Status checks per tracking session, so a stuck job can't be polled forever.
  checks: 120,
  // Seconds between checks when the provider doesn't say.
  minPollSeconds: 5
}

export type JobDeps = {
  provider: (id: string) => MediaProvider | null
  // Durable: called before every outside step and after every change.
  save: (job: Job) => void
  // A reference's bytes, read by Custard for the job's own chat.
  read?: (job: Job, ref: MediaReference) => Promise<Uint8Array>
  now?: () => number
  newId?: () => string
}

const TERMINAL = new Set<Job['state']>(['completed', 'failed', 'cancelled'])

export class JobTracker {
  private jobs = new Map<string, Job>()
  private now: () => number
  private newId: () => string

  constructor(
    private deps: JobDeps,
    saved: Job[] = []
  ) {
    this.now = deps.now ?? Date.now
    this.newId = deps.newId ?? randomUUID
    // Restoring tracks nothing; the user is offered a check instead. A job
    // that was being sent when Custard stopped may have been submitted.
    for (const j of saved) {
      const job: Job = { ...j, tracking: false }
      if (job.state === 'not-submitted' && job.attemptedAt && !job.remoteId) {
        job.state = 'unknown'
        job.error = 'Custard stopped while sending this request, so it may have been submitted.'
      }
      this.jobs.set(job.id, job)
      if (job.state !== j.state || j.tracking) deps.save(job)
    }
  }

  get(id: string): Job | undefined {
    const j = this.jobs.get(id)
    return j && { ...j }
  }

  list(conversationId?: string): Job[] {
    return [...this.jobs.values()]
      .filter((j) => !conversationId || j.requestedBy.conversationId === conversationId)
      .map((j) => ({ ...j }))
  }

  private put(job: Job): Job {
    job.updatedAt = this.now()
    this.jobs.set(job.id, job)
    this.deps.save({ ...job })
    return { ...job }
  }

  private need(id: string): { job: Job; provider: MediaProvider; cap: MediaCapability } {
    const job = this.jobs.get(id)
    if (!job) throw new JobError('There is no such job.')
    const provider = this.deps.provider(job.providerId)
    if (!provider) throw new JobError("The provider for this job isn't available now.")
    const info = provider.info()
    if (info.state !== 'ready')
      throw new JobError(`${info.name} isn't ready${info.needs ? `: ${info.needs}` : '.'}`)
    const cap = info.capabilities.find((c) => c.operation === job.request.operation)
    if (!cap) throw new JobError(`${info.name} no longer offers this.`)
    return { job: { ...job }, provider, cap }
  }

  // A job for a user's request. Nothing is sent yet.
  create(a: {
    providerId: string
    request: MediaRequest
    requestedBy: Job['requestedBy']
    target: Job['target']
  }): Job {
    const provider = this.deps.provider(a.providerId)
    if (!provider) throw new JobError("That provider isn't available.")
    const cap = provider.info().capabilities.find((c) => c.operation === a.request.operation)
    if (!cap) throw new JobError(`${provider.info().name} can't do ${a.request.operation}.`)
    const wrong = checkRequest(a.request, cap)
    if (wrong) throw new JobError(wrong)
    const id = this.newId()
    const t = this.now()
    return this.put({
      id,
      idempotencyKey: id,
      providerId: a.providerId,
      request: a.request,
      requestedBy: a.requestedBy,
      target: a.target,
      state: 'not-submitted',
      tracking: false,
      checks: 0,
      createdAt: t,
      updatedAt: t
    })
  }

  // Sends a job once. After any doubt about whether it reached the provider,
  // its state is unknown and only resubmit() can send it again.
  async submit(id: string, signal?: AbortSignal): Promise<Job> {
    const { job, provider } = this.need(id)
    if (job.state !== 'not-submitted' || job.attemptedAt)
      throw new JobError('This job was already sent.')
    job.attemptedAt = this.now()
    this.put(job)
    try {
      const read = this.deps.read
      const r = await provider.submit(job.request, {
        idempotencyKey: job.idempotencyKey,
        signal,
        read: (ref) => {
          if (!read || !job.request.references.some((x) => x.attachmentId === ref.attachmentId))
            return Promise.reject(new Error('That file is not part of this request.'))
          return read(job, ref)
        }
      })
      job.remoteId = r.remoteId
      job.tracking = true
      this.apply(job, r.status)
    } catch (err) {
      const definitelyNotSent = err instanceof MediaError && err.sent === false
      job.state = definitelyNotSent ? 'failed' : 'unknown'
      job.error = definitelyNotSent
        ? (err as Error).message
        : `It's not known whether this reached the provider (${err instanceof Error ? err.message : String(err)}).`
    }
    return this.put(job)
  }

  private apply(job: Job, s: RemoteStatus): void {
    job.state = s.state
    if (s.state === 'pending' || s.state === 'running') job.progress = s.progress
    if (s.state === 'failed') job.error = s.reason
    if (TERMINAL.has(job.state)) job.tracking = false
  }

  // One status check, when asked. Bounded by the provider's shortest wait
  // and a cap per tracking session. A completed job's files come back once.
  async check(id: string, signal?: AbortSignal): Promise<{ job: Job; files?: MediaFile[] }> {
    const { job, provider, cap } = this.need(id)
    if (!job.remoteId) throw new JobError('This job has no provider reference to check.')
    if (TERMINAL.has(job.state)) return { job }
    const wait = (cap.minPollSeconds ?? JOB_LIMITS.minPollSeconds) * 1000
    if (job.lastCheckAt && this.now() - job.lastCheckAt < wait)
      throw new JobError('Checked too recently; wait a little before checking again.')
    if (job.checks >= JOB_LIMITS.checks) {
      job.tracking = false
      this.put(job)
      throw new JobError('Stopped checking this job after many checks. Check it again later.')
    }
    job.checks++
    job.lastCheckAt = this.now()
    let status: RemoteStatus
    try {
      status = await provider.status(job.remoteId, signal)
    } catch (err) {
      // A failed check changes nothing about the job itself.
      job.error = `Couldn't check the job: ${err instanceof Error ? err.message : String(err)}`
      return { job: this.put(job) }
    }
    job.error = undefined
    if (status.state !== 'completed') {
      this.apply(job, status)
      return { job: this.put(job) }
    }
    let files: MediaFile[]
    try {
      files = await provider.result(job.remoteId, signal)
    } catch (err) {
      // Done at the provider; fetching the result can be tried again.
      job.state = 'running'
      job.error = `The result couldn't be fetched yet: ${err instanceof Error ? err.message : String(err)}`
      return { job: this.put(job) }
    }
    if (!files.length) {
      job.state = 'failed'
      job.error = 'The provider finished but returned no files.'
      job.tracking = false
      return { job: this.put(job) }
    }
    this.apply(job, status)
    return { job: this.put(job), files }
  }

  // Asks the provider to cancel. Cancelled only when it confirms.
  async cancel(id: string): Promise<Job> {
    const { job, provider, cap } = this.need(id)
    if (!job.remoteId || TERMINAL.has(job.state)) throw new JobError('There is nothing to cancel.')
    if (!cap.cancel || !provider.cancel)
      throw new JobError(
        "This provider can't cancel a job. You can stop tracking it, but it will still run."
      )
    const r = await provider.cancel(job.remoteId)
    if (r === 'cancelled') {
      job.state = 'cancelled'
      job.tracking = false
    } else job.error = 'The provider did not confirm the cancellation.'
    return this.put(job)
  }

  // A deleted chat's jobs leave the list (they keep running at the provider).
  forgetChat(conversationId: string): void {
    for (const [id, j] of this.jobs)
      if (j.requestedBy.conversationId === conversationId) this.jobs.delete(id)
  }

  // Stops watching locally. The job carries on at the provider.
  stopTracking(id: string): Job {
    const job = this.jobs.get(id)
    if (!job) throw new JobError('There is no such job.')
    return this.put({ ...job, tracking: false })
  }

  // Sends a failed, cancelled or unknown job's request again, as a new job.
  // Where it may already be running (unknown, or a failure the provider may
  // have received) and the provider doesn't deduplicate, the user must have
  // been told it could run and be charged twice.
  // The new job answers a new user message and fills a new version.
  resubmitJob(
    id: string,
    a: {
      acknowledgeDuplicateRisk: boolean
      requestedBy: Job['requestedBy']
      target: Job['target']
    }
  ): Job {
    const { job, cap } = this.need(id)
    if (!['failed', 'cancelled', 'unknown'].includes(job.state))
      throw new JobError('Only a failed, cancelled or unknown job can be sent again.')
    const mayExist = job.state === 'unknown' || (job.state === 'failed' && !!job.remoteId)
    const dedupes = mayExist && cap.idempotency && job.state === 'unknown'
    if (mayExist && !dedupes && !a.acknowledgeDuplicateRisk)
      throw new DuplicateRiskError(
        'The earlier request may still run and be charged. Sending it again could make a second one.'
      )
    const fresh = this.create({
      providerId: job.providerId,
      request: job.request,
      requestedBy: a.requestedBy,
      target: a.target
    })
    // The provider deduplicates by key, so the same key makes it the same job.
    return dedupes ? this.put({ ...fresh, idempotencyKey: job.idempotencyKey }) : fresh
  }
}
