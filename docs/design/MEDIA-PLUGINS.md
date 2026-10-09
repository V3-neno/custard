# Media plugins (Design Phase 4)

Custard has no video generator of its own. Video, and any image provider
other than the built-in one, comes from a plugin that declares `media` in
its `plugin.json` ([MANIFEST.md](../plugins/MANIFEST.md#media)). Design talks
to it through the same `MediaProvider` interface as the built-in image
provider ([CONTRACTS.md](CONTRACTS.md)), so Design has no plugin-specific
code.

Code: `src/main/plugins/manifest.ts` (validation), `src/main/plugins/host.ts`
(`mediaCatalog`, `invokeMedia`, `mediaHosts`), `src/main/design/plugin-media/`
(adapter and result checks), `src/renderer/src/components/design/viewers/VideoViewer.tsx`.

## How a job runs

1. The user asks in Design. The model calls `design_media`.
2. Design checks the capability report, the references (files attached in
   this chat only) and the request against what the provider declared.
3. Design shows one approval card: provider, operation, prompt, files sent,
   the price only if the plugin declares one with its source, and whether it
   can be cancelled. It is asked every time; there is no "for this chat".
4. Custard saves the job, then calls the plugin's **submit** tool once.
5. The user (or the model, when the user asks) checks the job. Each check
   calls the **status** tool once. When it reports `completed`, the
   **result** tool is called and the files are checked and stored as a new
   version.
6. Cancel calls the **cancel** tool, and the job is cancelled only when the
   plugin confirms it.

Every call goes through `PluginHost.invoke`: the plugin must be enabled, on
the same build that declares this provider, with every permission granted,
including `media:<id>`; the input must match the tool's schema; the code runs
in the plugin's sandbox. `invokeMedia` can only reach the tool the active
build declares for that provider, operation and role. These tools are not
offered to the model as plain tools, and the manifest refuses them as
widget tools, so Design's job flow is the only way to call them.

Nothing runs on a timer. There are no schedules, automatic checks,
automatic retries or follow-up submissions.

## Approval: one card

Decided by Neno (2026-10-09): Design's card is the only card for a plugin
submission. `SUBMIT_APPROVAL` in `plugin-media/index.ts` is `'design-card'`:
the submit call runs with `preApproved` for that one call only. Design's card
is asked every time, never "for this chat", and the plugin's "ask every time"
setting can't remove it. Every other host check still runs. (`'pending'`,
used before the decision, sent nothing; the adapter still supports it.)

Cancel is the user's own request and can't start or charge for anything, so
it runs without the plugin's card. Any other card the host would raise for
these calls is refused, because the adapter has no way to show one.

## What the tools get and return

The submit tool receives:

```ts
{
  operation: MediaOperation
  prompt: string
  idempotencyKey: string // the same for a deduplicated resubmission
  references?: { name: string; mime: string; base64: string }[] // only if declared
  size?: { width: number; height: number }
  durationSeconds?: number
  format?: string
}
```

References are files attached in this chat. Custard reads them, checks them
against the hash taken when they were attached, and sends the bytes. The
plugin never gets a path. At most 8 MB in total, and no more than the
capability's `maxBytes` each.

It returns `data: { remoteId, status }` (`PluginMediaSubmitData`). On a
failure it returns an error. It may add `data: { sent: false }` only when its
service certainly never received the request. Without that, a failure counts
as **outcome unknown**, because the request may still run and be charged.

Status, result and cancel tools receive `{ remoteId }`.

- Status returns `data` as a `RemoteStatus`.
- Result returns `data: { files }` (`PluginMediaResultData`).
- Cancel returns `data: { state: 'cancelled' }` when the job is really
  cancelled. Anything else counts as not cancelled.

## Untrusted output

Everything a plugin returns is checked before use:

- **Job references.** These are printable, with no spaces and at most 200
  characters. Custard stores them as `<operation>|<remoteId>`, so status
  and result go to the tools declared for that operation.
- **Status.** It must be one of the five states. Progress must be between 0
  and 1. A failure reason becomes one line of at most 300 characters.
- **Files.** At most 4 per result and 200 MB each. Each file's MIME type
  must be one the capability declares, and its bytes must really be that
  type (PNG, JPEG, GIF, WebP, MP4 or WebM signatures). Names are cleaned
  before they are stored.
- **Inline files** must be valid base64. Media `data` is capped at 48 MB of
  JSON. That bound applies to the media route only; widgets keep 64 KB.
- **Linked files.** Custard fetches each one itself. It must be https, on a
  host the plugin's approved `network:` permission reaches now, and checked
  at connect time like every plugin request. Private and local addresses are
  refused. Each redirect hop is checked again, with at most 3. A link that
  answers 404, 410, 401 or 403 is reported as expired or refused.
- A submit answer Custard can't read counts as outcome unknown, because the
  plugin may have started something.

A result that fails these checks permanently (a type it didn't declare,
bytes that aren't that type, bad base64, too large, a host the plugin may
not reach) fails the job, and its version settles as failed. An expired or
refused link, an HTTP error or a network error leaves the job running with
the reason shown, so a later check can fetch it again (the plugin may
return a fresh link). Checks are capped per job (see `JOB_LIMITS`).

## Restarts, disabling and removal

- **Restart.** Jobs are saved before anything is sent. On restart nothing is
  tracked automatically; the user can check again. A job that was being sent
  when Custard stopped is marked unknown. Sending an unknown job again needs
  the user to accept a possible second charge, unless the provider
  deduplicates by key.
- **Disabled plugin.** Saved videos stay viewable. Checks and new jobs say
  the plugin is turned off.
- **Removed or uninstalled plugin.** Saved videos stay viewable. Checks say
  the plugin was removed or turned off, and new jobs say video needs a plugin.
- **Updated plugin.** Checks use the new build only if it still declares
  the same provider and operation.

## Video viewer

`VideoViewer` plays the stored file with the native controls, from
`custard-media://`, which serves only recorded files. It shows the type,
size and source plugin, plus a "Save a copy" button through `design.export`,
which Workstream A provides. While the job runs it shows the last reported
state and progress, with Check now, Cancel job and Stop tracking. It never
checks on its own.

Plugin-specific controls are limited to what the capability declares: a
listed size, a duration within the declared range, and a listed format.
Custard checks each against the declaration before anything is sent. A
plugin can't add its own fields to the request.

## Limits Custard can't enforce

- **What a read tool does on the network.** Custard calls submit only once
  per approved job, and status and result are declared read tools. But
  plugin code inside a read tool could still send a request its network
  permission allows, including a paid one. Custard can't see the plugin's
  intent. That rests on the plugin's review at activation, not on the host.
- **`sent: false`.** Only the plugin knows whether its service got the
  request. A plugin that wrongly reports `sent: false` makes a failure look
  safe to resend.

## Testing

- **Unit and flow tests:** `src/main/design/plugin-media/plugin-media.test.ts`.
  They use the real host, real esbuild builds and Design's job flow, with a
  vm stand-in for the sandbox.
- **Fixture:** `test/fixtures/media-plugins/slowmo`. It is development-only,
  never in `plugin/`, and contacts no service. Words in the prompt script
  its failures.
- **End to end:** `test/e2e/design-media.mjs`, run against the mock, with
  `test/e2e/mocks/c-media.mjs`.
- **Not verified:** any real video service, Windows, macOS, packaged
  builds, and large real files through the sandbox's IPC.
