# Design mode contracts

Types in `src/shared/design.ts`; rules in `src/main/design/`. Tests in
`src/main/design/design.test.ts` and `src/main/modes/policy.test.ts`. Nothing
here names a commercial service: providers describe themselves.

## Capabilities (`capabilities.ts`)

`discoverCapabilities(input)` answers, for each operation (`design.html`,
`image.generate`, `image.edit`, `image.variation`, `video.text-to-video`,
`video.image-to-video`), from configuration and provider declarations only:

| Status                         | Meaning                                                                                                     | Example                                                                  |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `supported`                    | Go ahead; `limits` lists what to disclose.                                                                  | HTML via the chat model.                                                 |
| `quality-uncertain`            | Supported, with an uncertainty the provider itself declares. No percentages.                                | An edit that may change untouched regions.                               |
| `unavailable` / `unsupported`  | Nothing installed or chosen can do it. Configuring won't help.                                              | Video with no video plugin; editing with a provider that only generates. |
| `unavailable` / `unconfigured` | Something can do it but isn't set up; `fix.place` says where (`ai-settings`, `design-settings`, `plugins`). | No API key; no default image provider; plugin turned off.                |
| `unavailable` / `failed`       | It was tried this session and failed; `temporary` as the provider said. Never retried automatically.        | A timeout.                                                               |

Only the configured default is answered. Other capable, ready sources are
listed in `alternatives` for the user to pick; nothing switches on its own,
including when the default is missing, broken or slow. Video defaults to the
single enabled plugin that offers it; with several, the user chooses.

Chat models never produce images in Custard today: Claude's Messages API
returns text, and Custard's OpenAI connection handles text output only. So
images always come from an image provider, and HTML (including any SVG in
it) is recorded as chat-model output, never as a generated image.

## Settings

| Place                              | Holds                                                                              |
| ---------------------------------- | ---------------------------------------------------------------------------------- |
| AI settings (existing)             | Chat provider, model, effort, API keys.                                            |
| Design settings (`DesignSettings`) | Default image provider and model; default video provider (a plugin's). No secrets. |
| Plugin configuration (existing)    | A plugin provider's credentials and options.                                       |
| Skills                             | Instructions only. They can't hold or grant anything.                              |

## Media providers (`media.ts`)

`MediaProvider` is the one interface Design talks to, built-in or plugin:
`info()`, `submit(request, { idempotencyKey })`, `status(remoteId)`,
optional `cancel(remoteId)`, `result(remoteId)`. `info().capabilities` is a
list of `MediaCapability`, one per operation: accepted references (kinds,
count, size, formats), output formats, sizes, durations, progress, cancel,
idempotency, pricing (text plus its source, shown as given), whether
unchanged regions are preserved, a declared uncertainty, constraints, and the
shortest wait between status checks.

`validateCapabilities(raw)` accepts a declaration only if every field is
well formed; a capability with any error is dropped, so an operation is
either fully declared or unavailable. `checkRequest(request, capability)`
refuses requests outside the declaration before anything is sent.

Errors are `MediaError(kind, message, sent)`. `sent: false` means it surely
didn't reach the provider; `true` or `'unknown'` makes the outcome unknown.

## Jobs (`jobs.ts`)

States: `not-submitted`, `pending`, `running`, `completed`, `failed`,
`cancelled` (only when the provider confirms), `unknown`.

- A job is created for a user message (`requestedBy`) and a target version,
  with a durable id and an idempotency key, and saved before anything is sent.
- `submit` sends once. It records the attempt first, so a crash mid-send is
  `unknown` on restart, never resent.
- `check` is one status check when asked: never on a timer, at most once per
  the provider's minimum interval, at most 120 per tracking session. A
  completed job returns its files once.
- `cancel` asks the provider; `stopTracking` only stops watching and says the
  job still runs.
- `resubmitJob` makes a new job for a new user message. If the earlier one
  may still run and the provider doesn't deduplicate, it throws
  `DuplicateRiskError` unless the user acknowledged the duplicate-charge
  risk. Where the provider deduplicates, it reuses the key.
- On restart every job is restored untracked; the UI offers to check.
- A disabled or removed provider makes new work and checks unavailable; the
  records and finished outputs stay.

## Outputs and versions (`versions.ts`)

An `Artifact` (html, image or video) belongs to a conversation and holds
`Version`s. Versions are only added. A revision or variation of any finished
version, old or new, is a new version with `parent` set. Settled versions
never change. Only a success becomes selected, so a failed or cancelled
attempt leaves the last good version shown. `checkSource` refuses an image
or video version from the chat model and an HTML version from a media
provider. Each version records its source, its files (path, MIME, SHA-256,
size), its job and the skills it used.

## The development fixture

`test/fixtures/media/slow-video.ts` is a `MediaProvider` that steps through
scripted statuses, can lose or reject a submission, deduplicates when told
to, and returns a few bytes as `clip.mp4`. It exists only for tests; it is not
a plugin, isn't bundled, and a test fails if app source imports it.
