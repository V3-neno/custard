// Design mode contracts (Phase 1): what Design can do and why not, media
// providers, outputs and their versions, generation jobs, and which skills
// informed a version. Nothing here names a particular commercial service;
// providers describe themselves through MediaProviderInfo. See
// docs/design/CONTRACTS.md.

import type { Provider } from './chat'

// ---------------------------------------------------------------- operations

export const mediaOperations = [
  'image.generate',
  'image.edit',
  'image.variation',
  'video.text-to-video',
  'video.image-to-video'
] as const
export type MediaOperation = (typeof mediaOperations)[number]

// HTML, CSS and browser JavaScript come from the chat model; the rest needs
// a media provider.
export type DesignOperation = 'design.html' | MediaOperation

// ---------------------------------------------------------------- sources

// Where a result comes from. A generated image or video always comes from a
// media provider; HTML (and any SVG in it) always from the chat model, so an
// illustration drawn in markup can never be passed off as a generated image.
export type Source =
  | { kind: 'chat-model'; provider: Provider; model: string }
  | { kind: 'image-provider'; provider: string; model: string }
  | { kind: 'plugin'; pluginId: string; buildId: string; providerId: string }

// ---------------------------------------------------------------- capability

// Why something can't be done right now. Kept apart because each needs a
// different answer from the user:
//   unsupported: nothing configured or installed can do it (a missing
//     capability or extension); retrying or configuring changes nothing.
//   unconfigured: something can do it but isn't set up (no key, no image
//     provider chosen, plugin disabled or missing its settings).
//   failed: it was tried and failed this session, with what was reported.
export type UnavailableCause = 'unsupported' | 'unconfigured' | 'failed'

// Where the user fixes it, when they can.
export type SettingsPlace = 'ai-settings' | 'design-settings' | 'plugins'

export type Availability =
  | { status: 'supported'; via: Source; limits: string[] }
  // Supported, with a specific uncertainty the provider itself declares
  // (never a guessed confidence figure).
  | { status: 'quality-uncertain'; via: Source; uncertainty: string; limits: string[] }
  | {
      status: 'unavailable'
      cause: UnavailableCause
      reason: string
      fix?: { place: SettingsPlace; text: string }
      // failed only: whether the provider called it temporary. Never retried
      // automatically.
      temporary?: boolean
      // The source that was asked, when there was one.
      via?: Source
    }

// One answer per operation, for the configured default source only. Other
// sources that could do it are listed for the user to pick; nothing switches
// to them on its own.
export type CapabilityReport = Record<
  DesignOperation,
  { availability: Availability; alternatives: Source[] }
>

// ---------------------------------------------------------------- settings

// Design settings: the default image provider and model, and generation
// defaults. No secrets: credentials live with the provider's own settings
// (AI settings' keys, or the plugin's configuration).
// Video has no built-in provider: its default is a plugin's provider.
export type DesignSettings = {
  image: { provider: string | null; model: string | null }
  video: { provider: string | null }
}
export const defaultDesignSettings: DesignSettings = {
  image: { provider: null, model: null },
  video: { provider: null }
}

// ---------------------------------------------------------------- media providers

export type ReferenceKind = 'image' | 'video'

// What a provider says it can do for one operation. Validated before use
// (see main/design/media.ts); anything it doesn't declare stays unavailable.
export type MediaCapability = {
  operation: MediaOperation
  // Accepted references; none means it takes none.
  references?: { kinds: ReferenceKind[]; maxCount: number; maxBytes: number; formats: string[] }
  // Output MIME types, e.g. image/png, video/mp4.
  formats: string[]
  sizes?: { width: number; height: number }[]
  // Seconds, for video.
  durations?: { min: number; max: number }
  progress: boolean
  cancel: boolean
  // Whether a resubmission with the same key is deduplicated by the provider.
  idempotency: boolean
  // Shown as given, with where it came from. Never computed or guessed.
  pricing?: { text: string; source: string }
  // image.edit: false when unchanged regions may shift.
  preservesUnchanged?: boolean
  // A specific uncertainty the provider declares about this operation.
  uncertainty?: string
  constraints?: string[]
  // Shortest wait between status checks, in seconds.
  minPollSeconds?: number
}

export type MediaProviderState = 'ready' | 'disabled' | 'not-activated' | 'needs-config'

export type MediaProviderInfo = {
  id: string
  name: string
  source: Source
  state: MediaProviderState
  // What the user has to do when it isn't ready.
  needs?: string
  capabilities: MediaCapability[]
}

// A file the user attached in the same chat. Only its record travels;
// the bytes are read (and hash-checked) by Custard at submission and handed
// to the provider, which never gets a path.
export type MediaReference = {
  kind: ReferenceKind
  name: string
  mime: string
  bytes: number
  attachmentId: string
}

export type MediaRequest = {
  operation: MediaOperation
  prompt: string
  references: MediaReference[]
  // Only options the capability declares are accepted.
  size?: { width: number; height: number }
  durationSeconds?: number
  format?: string
}

export type MediaFile = { name: string; mime: string; bytes: Uint8Array }

// Errors a provider reports. `sent` says whether the request may have
// reached the provider: true or unknown makes a failed submission's outcome
// unknown, because it may still run (and be charged).
export type MediaErrorKind = 'unsupported' | 'unconfigured' | 'rejected' | 'temporary'
export class MediaError extends Error {
  constructor(
    readonly kind: MediaErrorKind,
    message: string,
    readonly sent: boolean | 'unknown'
  ) {
    super(message)
  }
}

export type RemoteStatus =
  | { state: 'pending' | 'running'; progress?: number }
  | { state: 'completed' }
  | { state: 'failed'; reason: string }
  | { state: 'cancelled' }

// The common interface Design talks to. Built-in image providers and plugin
// providers implement the same one, so Design has no provider-specific code.
export interface MediaProvider {
  info(): MediaProviderInfo
  submit(
    request: MediaRequest,
    options: {
      idempotencyKey: string
      signal?: AbortSignal
      read: (ref: MediaReference) => Promise<Uint8Array>
    }
  ): Promise<{ remoteId: string; status: RemoteStatus }>
  status(remoteId: string, signal?: AbortSignal): Promise<RemoteStatus>
  // Resolves 'cancelled' only when the provider confirms it.
  cancel?(remoteId: string): Promise<'cancelled' | 'not-cancelled'>
  result(remoteId: string, signal?: AbortSignal): Promise<MediaFile[]>
}

// ---------------------------------------------------------------- jobs

export type JobState =
  'not-submitted' | 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown'

export type Job = {
  // Durable, made by Custard before anything is sent.
  id: string
  // Offered to the provider with every submission of this request. A
  // resubmission keeps it only where the provider deduplicates by it.
  idempotencyKey: string
  providerId: string
  request: MediaRequest
  // Only a user's message starts a job.
  requestedBy: { conversationId: string; messageIndex: number }
  // The output version the result goes into.
  target: { artifactId: string; versionId: string }
  state: JobState
  // Set just before the request goes out, so a crash in between is known.
  attemptedAt?: number
  remoteId?: string
  progress?: number
  error?: string
  // Custard is watching it now. Stopping that never cancels the job.
  tracking: boolean
  checks: number
  lastCheckAt?: number
  createdAt: number
  updatedAt: number
}

// ---------------------------------------------------------------- outputs

export type ArtifactKind = 'html' | 'image' | 'video'

// Which skills informed a version, by content fingerprint (SHA-256 of the
// SKILL.md read). The fingerprint shows whether a skill changed; it can't
// bring back instructions that are gone, so the guidance relied on is kept
// with the version, bounded.
export type SkillUse = {
  path: string
  name: string
  fingerprint: string
  how: 'explicit' | 'matched'
  guidance: string
}

export type VersionStatus = 'pending' | 'succeeded' | 'failed' | 'cancelled'

export type ArtifactFile = { path: string; mime: string; sha256: string; size: number }

export type Version = {
  id: string
  // Counting from 1 within its output.
  n: number
  // first: the output's first version; revision: a change to `parent`;
  // variation: another option alongside `parent`.
  relation: 'first' | 'revision' | 'variation'
  parent: string | null
  status: VersionStatus
  source: Source
  skills: SkillUse[]
  files: ArtifactFile[]
  jobId?: string
  error?: string
  createdAt: number
}

export type Artifact = {
  id: string
  conversationId: string
  name: string
  kind: ArtifactKind
  versions: Version[]
  // The version shown; "change this" means this one.
  selected: string
  createdAt: number
}

// ---------------------------------------------------------------- plugin media
// (Batch contract. Validation lives in main/plugins/manifest.ts, Workstream C.)

// One provider a plugin offers. Each capability names the plugin's own
// declared tools that do the work; they run through the plugin host like any
// other tool call (permissions, approvals, sandbox). No other route exists.
export type PluginMediaSpec = {
  // Unique within the plugin, like its tools: [a-z][a-z0-9-]{0,30}.
  id: string
  name: string
  capabilities: (MediaCapability & {
    tools: {
      // A write tool: the only one that can start (and charge for) work.
      submit: string
      // Read tools: they must never submit anything.
      status: string
      result: string
      cancel?: string
    }
  })[]
}

// What those tools return in their result `data` (validated by the host;
// anything else is an error). Plugin output is untrusted.
export type PluginMediaSubmitData = { remoteId: string; status: RemoteStatus }
export type PluginMediaStatusData = RemoteStatus
// Files come back inline (base64) or as an https URL on a host the plugin's
// network permission already allows; sizes and types are capped by the host.
export type PluginMediaResultData = {
  files: (
    { name: string; mime: string; base64: string } | { name: string; mime: string; url: string }
  )[]
}

// ---------------------------------------------------------------- tools

// Design-only tools the model is offered (see main/design/tools.ts). Only
// Design mode allows the 'design' tool kind (main/modes/policy.ts).
export const DESIGN_TOOLS = ['design_html', 'design_media', 'design_jobs'] as const
export type DesignToolName = (typeof DESIGN_TOOLS)[number]

// ---------------------------------------------------------------- workspace IPC

export type ArtifactSummary = {
  id: string
  name: string
  kind: ArtifactKind
  selected: string
  versions: number
  // The newest version's status, for the tab badge.
  latest: VersionStatus
  updatedAt: number
}

// Pushed to the app window on 'design:event' as outputs and jobs change.
export type DesignEvent =
  | { type: 'artifact'; conversationId: string; artifact: Artifact }
  | { type: 'job'; conversationId: string; job: Job }

export type ExportResult =
  | { ok: true; path: string; files: number }
  | { ok: false; canceled: true }
  | { ok: false; canceled?: false; error: string }

// URL scheme the app window uses to show stored images and video
// (custard-media://<conversation>/<artifact>/<version>/<file>). Read-only,
// serves only files recorded on a version. Never used by the HTML preview,
// which has its own scheme and session (docs/design/SANDBOX.md).
export const MEDIA_SCHEME = 'custard-media'
