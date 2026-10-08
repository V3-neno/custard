import {
  MediaError,
  type MediaCapability,
  type MediaFile,
  type MediaProvider,
  type MediaProviderInfo,
  type MediaRequest,
  type PluginMediaSpec,
  type RemoteStatus
} from '../../../shared/design'
import type { ApprovalRequest, MediaEntry, MediaRole, ToolOutcome } from '../../plugins/host'
import {
  checkType,
  decodeInline,
  fetchResult,
  RESULT_LIMITS,
  ResultError,
  type BinaryTransport
} from './results'

// Design's view of a plugin's `media` declaration: a MediaProvider whose
// every step is one of the plugin's own declared tools, run by the plugin
// host with its usual checks (enabled, same build, granted permissions,
// input schema, sandbox). This adds no other way to run plugin code.
//
//   submit  the declared write tool, once per job. The only call that can
//           start (and charge for) work.
//   status  the declared read tool. Never submits.
//   result  the declared read tool. Never submits; files are checked here.
//   cancel  the declared tool, only when the user asks to cancel.
//
// Everything a plugin returns is untrusted and checked before use.

export type PluginMediaDeps = {
  catalog: () => MediaEntry[]
  invoke: (
    a: { pluginId: string; providerId: string; operation: string; role: MediaRole; input: unknown },
    o: {
      signal: AbortSignal
      approve: (r: ApprovalRequest) => Promise<boolean>
      preApproved?: boolean
    }
  ) => Promise<ToolOutcome>
  hosts: (pluginId: string) => string[]
  // How the plugin's own write-tool approval relates to Design's card for a
  // submission. 'design-card': Design's card (always asked, never "for this
  // chat") is the approval for that one call. 'pending': not decided yet, so
  // nothing is submitted. See docs/design/MEDIA-PLUGINS.md.
  submitApproval: () => 'design-card' | 'pending'
  transport?: () => BinaryTransport | undefined
}

export const providerIdOf = (pluginId: string, providerId: string): string =>
  `plugin:${pluginId}:${providerId}`

export const MEDIA_INPUT_LIMITS = {
  // Reference bytes handed to the submit tool, all files together.
  referenceBytes: 8 * 1024 * 1024,
  remoteId: 200,
  text: 300
}

// A plugin's job reference: printable, no spaces, bounded.
const REMOTE_ID = /^[\x21-\x7e]{1,200}$/

// Custard's remote id carries the operation, so status and result go to the
// tools declared for it: "<operation>|<plugin's id>".
const wrapId = (op: string, id: string): string => `${op}|${id}`
function unwrapId(remoteId: string): { op: string; id: string } {
  const i = remoteId.indexOf('|')
  if (i <= 0)
    throw new MediaError('rejected', 'That job reference is not from this provider.', false)
  return { op: remoteId.slice(0, i), id: remoteId.slice(i + 1) }
}

// Plugin text shown to the user or model: one line, no control characters.
const short = (s: unknown, max = MEDIA_INPUT_LIMITS.text): string =>
  [...String(s ?? '')]
    .map((ch) => (ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f ? ' ' : ch))
    .join('')
    .replace(/ {2,}/g, ' ')
    .trim()
    .slice(0, max)

// Plugin status data, or null if it isn't one.
export function readStatus(raw: unknown): RemoteStatus | null {
  const s = raw as Record<string, unknown> | null
  if (!s || typeof s !== 'object' || Array.isArray(s)) return null
  switch (s.state) {
    case 'pending':
    case 'running': {
      const p = s.progress
      if (p !== undefined && !(typeof p === 'number' && p >= 0 && p <= 1)) return null
      return { state: s.state, ...(typeof p === 'number' ? { progress: p } : {}) }
    }
    case 'completed':
    case 'cancelled':
      return { state: s.state }
    case 'failed':
      return { state: 'failed', reason: short(s.reason) || 'The provider reported a failure.' }
    default:
      return null
  }
}

const withoutTools = (c: PluginMediaSpec['capabilities'][number]): MediaCapability => {
  const rest: Partial<typeof c> = { ...c }
  delete rest.tools
  return rest as MediaCapability
}

const denyApproval = async (): Promise<boolean> => false

export class PluginMediaProvider implements MediaProvider {
  constructor(
    private entry: MediaEntry,
    private deps: PluginMediaDeps
  ) {}

  private get spec(): PluginMediaSpec {
    return this.entry.spec
  }

  info(): MediaProviderInfo {
    const e = this.entry
    return {
      id: providerIdOf(e.pluginId, e.spec.id),
      name: e.spec.name,
      source: { kind: 'plugin', pluginId: e.pluginId, buildId: e.buildId, providerId: e.spec.id },
      state: e.ready ? 'ready' : 'disabled',
      ...(e.needs ? { needs: e.needs } : {}),
      // Without the tool names: Design only needs what it can do.
      capabilities: e.spec.capabilities.map(withoutTools)
    }
  }

  private cap(op: string): PluginMediaSpec['capabilities'][number] {
    const c = this.spec.capabilities.find((x) => x.operation === op)
    if (!c) throw new MediaError('unsupported', `${this.spec.name} no longer offers ${op}.`, false)
    return c
  }

  private call(
    role: MediaRole,
    op: string,
    input: unknown,
    signal: AbortSignal | undefined,
    preApproved = false
  ): Promise<ToolOutcome> {
    return this.deps.invoke(
      { pluginId: this.entry.pluginId, providerId: this.spec.id, operation: op, role, input },
      // Anything not pre-approved that the host would ask about is refused:
      // Design has no second card to show here.
      { signal: signal ?? new AbortController().signal, approve: denyApproval, preApproved }
    )
  }

  async submit(
    request: MediaRequest,
    o: {
      idempotencyKey: string
      signal?: AbortSignal
      read: (ref: MediaRequest['references'][number]) => Promise<Uint8Array>
    }
  ): Promise<{ remoteId: string; status: RemoteStatus }> {
    const cap = this.cap(request.operation)
    if (this.deps.submitApproval() !== 'design-card')
      throw new MediaError(
        'unconfigured',
        'Plugin media submissions are waiting on a decision about approval cards, so nothing was sent.',
        false
      )
    // References: read and hash-checked by Custard, sent as bytes.
    let total = 0
    const references: { name: string; mime: string; base64: string }[] = []
    for (const ref of request.references) {
      const bytes = await o.read(ref)
      total += bytes.length
      if (
        total > MEDIA_INPUT_LIMITS.referenceBytes ||
        bytes.length > (cap.references?.maxBytes ?? 0)
      )
        throw new MediaError(
          'rejected',
          `${ref.name} is too large to send to ${this.spec.name}.`,
          false
        )
      references.push({
        name: ref.name,
        mime: ref.mime,
        base64: Buffer.from(bytes).toString('base64')
      })
    }
    const input = {
      operation: request.operation,
      prompt: request.prompt,
      idempotencyKey: o.idempotencyKey,
      ...(cap.references ? { references } : {}),
      ...(request.size ? { size: request.size } : {}),
      ...(request.durationSeconds !== undefined
        ? { durationSeconds: request.durationSeconds }
        : {}),
      ...(request.format ? { format: request.format } : {})
    }
    const r = await this.call('submit', request.operation, input, o.signal, true)
    if (r.outcome === 'not-run') throw new MediaError('unconfigured', short(r.content), false)
    if (r.outcome === 'unknown' || r.interrupted)
      throw new MediaError('temporary', short(r.content) || 'The plugin was cut off.', 'unknown')
    if (r.isError) {
      // Only the plugin can say its service never got the request.
      const sent = (r.data as { sent?: unknown } | undefined)?.sent === false ? false : 'unknown'
      throw new MediaError('rejected', short(r.content) || 'The plugin reported an error.', sent)
    }
    const d = r.data as Record<string, unknown> | undefined
    const status = readStatus(d?.status)
    if (!d || typeof d.remoteId !== 'string' || !REMOTE_ID.test(d.remoteId) || !status)
      // It answered, so it may well have started something.
      throw new MediaError(
        'rejected',
        `${this.spec.name} answered without a job reference Custard can use.`,
        'unknown'
      )
    return { remoteId: wrapId(request.operation, d.remoteId), status }
  }

  async status(remoteId: string, signal?: AbortSignal): Promise<RemoteStatus> {
    const { op, id } = unwrapId(remoteId)
    this.cap(op)
    const r = await this.call('status', op, { remoteId: id }, signal)
    if (r.isError || r.outcome !== 'completed')
      throw new Error(short(r.content) || 'The status check failed.')
    const s = readStatus(r.data)
    if (!s) throw new Error(`${this.spec.name} returned a status Custard can't read.`)
    return s
  }

  async cancel(remoteId: string): Promise<'cancelled' | 'not-cancelled'> {
    const { op, id } = unwrapId(remoteId)
    if (!this.cap(op).tools.cancel) return 'not-cancelled'
    // The user asked for this cancel; it can't start or charge for anything.
    const r = await this.call('cancel', op, { remoteId: id }, undefined, true)
    if (r.isError || r.outcome !== 'completed') return 'not-cancelled'
    return readStatus(r.data)?.state === 'cancelled' ? 'cancelled' : 'not-cancelled'
  }

  async result(remoteId: string, signal?: AbortSignal): Promise<MediaFile[]> {
    const { op, id } = unwrapId(remoteId)
    const cap = this.cap(op)
    const r = await this.call('result', op, { remoteId: id }, signal)
    if (r.isError || r.outcome !== 'completed')
      throw new ResultError(short(r.content) || 'Getting the result failed.')
    const files = (r.data as { files?: unknown } | undefined)?.files
    if (!Array.isArray(files) || !files.length || files.length > RESULT_LIMITS.files)
      throw new ResultError(`${this.spec.name} returned a result Custard can't read.`)
    const out: MediaFile[] = []
    for (const raw of files) {
      const f = raw as Record<string, unknown>
      if (!f || typeof f !== 'object' || typeof f.mime !== 'string' || typeof f.name !== 'string')
        throw new ResultError(`${this.spec.name} returned a file Custard can't read.`)
      let bytes: Uint8Array
      if (typeof f.base64 === 'string' && f.url === undefined) bytes = decodeInline(f.base64)
      else if (typeof f.url === 'string' && f.base64 === undefined)
        bytes = await fetchResult(f.url, {
          allowedHosts: this.deps.hosts(this.entry.pluginId),
          signal,
          transport: this.deps.transport?.()
        })
      else throw new ResultError(`${this.spec.name} returned a file with no content.`)
      out.push({
        name: short(f.name, RESULT_LIMITS.name) || 'result',
        mime: checkType(bytes, f.mime, cap.formats),
        bytes
      })
    }
    return out
  }
}

export const pluginMediaProviders = (deps: PluginMediaDeps): MediaProvider[] =>
  deps.catalog().map((e) => new PluginMediaProvider(e, deps))
