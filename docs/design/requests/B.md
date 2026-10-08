# Requests from Workstream B (OpenAI images)

## B1. A submission that completes at once never saves its files

OpenAI's Image API is synchronous: `images.generate` / `images.edit` return
the finished image in the response. B's provider therefore answers
`submit()` with `{ state: 'completed' }` (it keeps the bytes in its own
durable store until `result()` is called).

In the current contract that result is never collected:

1. `JobTracker.submit` applies `completed`, sets `tracking = false`, returns.
2. `tools.ts` `media()` reports "Submitted…" and leaves the version `pending`.
3. `JobTracker.check` returns early for any terminal state (`TERMINAL.has`),
   so `provider.result()` is never called and the version stays pending
   forever, although the image was made and paid for.

The same happens after a restart if Custard stopped between a completed
status and writing the files.

Suggested fix (integration's choice):

- Add `JobTracker.collect(id, signal)`: for a `completed` job with a
  `remoteId`, call `provider.result()` once and return the files (the same
  "no files" / "couldn't fetch" handling as `check`). No status call, no
  submission, so it can never charge anything.
- `media()`: when `submit` returns `completed`, run the same settle path as
  `jobAction` (write files, settle the version as succeeded) using `collect`.
- `jobAction('check')`: when the job is `completed` but its target version
  is still `pending`, use `collect` instead of returning early.

Test: a provider whose `submit` resolves `completed` produces a succeeded
version in the same `design_media` call, and a restart between submit and
file writing recovers on the next check without another `submit`.

Until this lands, B's e2e (`test/e2e/design-images.mjs`) expects the
version to be filled by the `design_media` call and will fail at that step.

## B2. The Design settings tab needs a provider list

The Design tab (B) lets the user pick the default image provider and model,
and the default video provider. The renderer can't get that list today:
`design:capabilities` only names the configured default and `Source`s of
ready alternatives (no provider id, no models, nothing for providers that
aren't ready yet).

Suggested addition (integration's choice of shape):

- `registry.ts`: an optional per-provider model list, e.g.
  `MediaProvider.models?(): { id: string; name: string; note?: string }[]`
  (B's provider returns the OpenAI image models it supports).
- IPC `design:providers` → for every registered provider:
  `{ id, name, source, state, needs, operations: MediaOperation[], models? }`.
- Preload: `window.custard.design.providers()`.

Until it lands, B's DesignTab reads the list through that preload call
behind a type guard and shows "Provider list unavailable" if it is missing.

## B3. One refused prompt blocks the operation for the whole session

`tools.ts` `media()` pushes every `failed` job onto `s.failures`
(`temporary: false`), and `discoverCapabilities` then answers that operation
`unavailable / failed` for that provider until Custard restarts.

For OpenAI that includes a content-policy refusal of one prompt (HTTP 400,
`moderation_blocked`). Seen in `test/e2e/design-images.mjs` (mock): after
"b refuse test", the next, unrelated generate request is refused with
"Generate an image isn't available (failed): OpenAI refused the request…"
without an approval card. The user can't make any image until a restart.

Suggested fix: keep the provider's error kind on the job (for example
`Job.errorKind?: MediaErrorKind`, set from `MediaError.kind` in
`JobTracker.submit`), and in `media()` record a session failure only for
provider-level kinds (`unconfigured`, `unsupported`, and `temporary` with
`temporary: true`), never for `rejected` (that request only). B's provider
already maps a 4xx refusal to `rejected`, 401/403 to `unconfigured`, 404 to
`unsupported` and 429 to `temporary`.

The e2e check "after a refused prompt, a new one still asks instead of being
blocked" fails until this lands.
