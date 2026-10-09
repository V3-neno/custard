import { createHash } from 'crypto'
import type { MediaRequest, Source, SubmissionApproval } from '../../shared/design'

// What one Design approval card covers, as a digest. The card shows the
// provider, the operation, the prompt, the options and the files sent; the
// approval saved with the job is a digest of exactly that, down to the
// plugin build and each file's SHA-256. Before anything is sent the job
// tracker checks it against the job's request and the provider as it is
// now, and for a plugin the host checks it again against the input the
// plugin would receive (plugins/host.ts invokeMedia). Anything changed in
// between (an argument, a file, the plugin build, the image model) refuses
// the send. A job is sent at most once, so an approval can't be replayed.

export type ApprovedContent = {
  source: Source
  operation: string
  prompt: string
  references: { name: string; mime: string; sha256: string }[]
  size?: { width: number; height: number }
  durationSeconds?: number
  format?: string
}

// JSON with keys in a fixed order, so equal content has one digest.
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (v && typeof v === 'object')
    return `{${Object.keys(v)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(',')}}`
  return JSON.stringify(v)
}

export const sha256 = (data: string | Uint8Array): string =>
  createHash('sha256').update(data).digest('hex')

export const digestOf = (v: unknown): string => sha256(canonical(v))
export const approvalDigest = (c: ApprovedContent): string => digestOf(c)

export function approvedContent(source: Source, request: MediaRequest): ApprovedContent {
  return {
    source,
    operation: request.operation,
    prompt: request.prompt,
    references: request.references.map((r) => {
      if (!r.sha256) throw new Error(`${r.name} has no fingerprint, so it can't be approved.`)
      return { name: r.name, mime: r.mime, sha256: r.sha256 }
    }),
    ...(request.size ? { size: { width: request.size.width, height: request.size.height } } : {}),
    ...(request.durationSeconds !== undefined ? { durationSeconds: request.durationSeconds } : {}),
    ...(request.format !== undefined ? { format: request.format } : {})
  }
}

export function approveSubmission(
  source: Source,
  request: MediaRequest,
  now: number
): SubmissionApproval {
  return {
    source,
    operation: request.operation,
    requestSha256: approvalDigest(approvedContent(source, request)),
    approvedAt: now
  }
}

const sameSource = (a: Source, b: Source): boolean => canonical(a) === canonical(b)

// Why a job's approval doesn't cover sending its request to this provider
// now, or null when it does.
export function approvalMismatch(
  approval: SubmissionApproval | undefined,
  request: MediaRequest,
  current: Source
): string | null {
  if (!approval) return "This request wasn't approved, so nothing was sent."
  if (!sameSource(approval.source, current))
    return approval.source.kind === 'plugin'
      ? 'The plugin changed after you approved this request, so nothing was sent. Ask again to approve the current version.'
      : 'The provider or model changed after you approved this request, so nothing was sent. Ask again to approve it.'
  let digest: string
  try {
    digest = approvalDigest(approvedContent(approval.source, request))
  } catch (err) {
    return `${err instanceof Error ? err.message : String(err)} Nothing was sent.`
  }
  if (approval.operation !== request.operation || digest !== approval.requestSha256)
    return 'The request changed after you approved it, so nothing was sent.'
  return null
}
