import { createHash, randomBytes } from 'crypto'
import type { AuthorizationToken, MediaRequest, Source } from '../../shared/design'

// Host-issued, single-use authorizations (stabilization contract S3).
//
// After the user approves a submission on Design's card, or asks to cancel a
// job, the trusted main process mints a token here. The token is an opaque
// random string; what it authorizes (its binding) stays in this module's
// memory. Nothing a model or plugin returns can create one, and a token's
// fields can't be forged because it has none. Tokens are never saved: a
// restart drops them all, so nothing can be dispatched automatically after
// one.
//
// The code at the dispatch boundary consumes the token with the binding it
// computes from what it is actually about to send (the active plugin build,
// the canonical arguments, the hashes of the reference bytes it read). The
// token is deleted before the comparison, so it can be used once at most,
// whatever the outcome; an uncertain result never makes it usable again.

export type Binding = {
  action: 'submit' | 'cancel'
  jobId: string
  conversationId: string
  // The provider's own source as approved: for a plugin, its id, build and
  // provider id. A plugin update between approval and dispatch changes it.
  source: Source
  operation: string
  // submit: sha256 of the canonical request (see requestSha256). cancel: of
  // { remoteId }.
  argsSha256: string
  // The reference files by content, in request order.
  references: { attachmentId: string; sha256: string }[]
}

export class AuthorizationError extends Error {}

// Unused tokens expire, so a card left open long ago can't authorize later.
export const AUTHORIZATION_TTL_MS = 10 * 60 * 1000

// Stable JSON: object keys sorted, undefined members dropped.
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null'
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
  const o = v as Record<string, unknown>
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(',')}}`
}

export const sha256 = (data: string | Uint8Array): string =>
  createHash('sha256').update(data).digest('hex')

// What a submission's arguments are, for binding: everything sent except
// the reference bytes, which are bound by their hashes.
export function requestSha256(r: MediaRequest): string {
  return sha256(
    canonicalJson({
      operation: r.operation,
      prompt: r.prompt,
      size: r.size,
      durationSeconds: r.durationSeconds,
      format: r.format,
      references: r.references.map((x) => ({ attachmentId: x.attachmentId, sha256: x.sha256 }))
    })
  )
}

export function bindingFor(
  action: Binding['action'],
  a: {
    jobId: string
    conversationId: string
    source: Source
    request: MediaRequest
    // cancel only.
    remoteId?: string
  }
): Binding {
  return {
    action,
    jobId: a.jobId,
    conversationId: a.conversationId,
    source: a.source,
    operation: a.request.operation,
    argsSha256:
      action === 'cancel'
        ? sha256(canonicalJson({ remoteId: a.remoteId ?? null }))
        : requestSha256(a.request),
    references: a.request.references.map((x) => ({
      attachmentId: x.attachmentId,
      sha256: x.sha256
    }))
  }
}

export class Authorizations {
  private live = new Map<string, { binding: Binding; expires: number }>()

  constructor(private now: () => number = Date.now) {}

  // Called only by trusted main-process code right after the user approved.
  mint(binding: Binding): AuthorizationToken {
    const token = randomBytes(32).toString('base64url')
    this.live.set(token, {
      binding: structuredClone(binding),
      expires: this.now() + AUTHORIZATION_TTL_MS
    })
    return token as AuthorizationToken
  }

  // Whether a token would currently authorize `actual`, without using it.
  // For early refusal only; dispatch must call consume().
  check(token: AuthorizationToken | undefined, actual: Binding): string | null {
    const e = token ? this.live.get(token) : undefined
    if (!e) return 'This action has no valid approval.'
    if (e.expires <= this.now()) return 'The approval for this action has expired.'
    return mismatch(e.binding, actual)
  }

  // At the dispatch boundary: uses the token up (whatever happens next) and
  // throws unless it authorizes exactly `actual`.
  consume(token: AuthorizationToken | undefined, actual: Binding): void {
    const e = token ? this.live.get(token) : undefined
    if (token) this.live.delete(token)
    if (!e) throw new AuthorizationError('This action has no valid approval, so nothing was sent.')
    if (e.expires <= this.now())
      throw new AuthorizationError('The approval for this action expired, so nothing was sent.')
    const why = mismatch(e.binding, actual)
    if (why) throw new AuthorizationError(`${why} Nothing was sent.`)
  }

  // A deleted chat's unused approvals go with it.
  forgetChat(conversationId: string): void {
    for (const [t, e] of this.live)
      if (e.binding.conversationId === conversationId) this.live.delete(t)
  }
}

function mismatch(approved: Binding, actual: Binding): string | null {
  if (approved.action !== actual.action) return 'The approval was for a different action.'
  if (approved.jobId !== actual.jobId || approved.conversationId !== actual.conversationId)
    return 'The approval was for a different job.'
  if (canonicalJson(approved.source) !== canonicalJson(actual.source))
    return 'The provider changed (for a plugin, its build) since this was approved.'
  if (approved.operation !== actual.operation) return 'The operation changed since it was approved.'
  if (approved.argsSha256 !== actual.argsSha256) return 'The request changed since it was approved.'
  if (canonicalJson(approved.references) !== canonicalJson(actual.references))
    return 'The files to send changed since they were approved.'
  return null
}

// The process's one registry. Main-process only; never exposed over IPC.
export const authorizations = new Authorizations()
