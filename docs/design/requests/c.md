# Workstream C: requests for shared files

For the integration owner ("Build Custard app"). Items 1, 2, 3, 5 and 6 were
applied on `design-batch` (2b11675) and merged into C's branch. Item 4 waits
on Neno's answer about approval cards.

1. **`describePermission` for `media:`** (`src/shared/plugins.ts`). Add
   `case 'media': return \`Offer its "${v}" image or video generation to Design (each job asks first)\``.
Until then the activation screen shows the raw `media:video` string.

2. **One refused prompt turns the provider off for the session**
   (`src/main/design/tools.ts`, `media`). Every `failed` submission is pushed
   to `s.failures` with `temporary: false`, and `discoverCapabilities` then
   reports the operation as failed. Later `design_media` calls are refused
   until restart. That fits a broken configuration, but not a provider that
   refused one prompt (`MediaError` kind `rejected`). Suggestion: record a
   failure only for kinds `unconfigured` and `unsupported`. That needs the
   error kind on the job, or tools.ts catching it from `submit`. The C tests
   clear `failures` between submissions to work around it.

3. **Contract types for the media tool inputs** (`src/shared/design.ts`).
   docs/design/MEDIA-PLUGINS.md defines what the submit, status, result and
   cancel tools receive, the cancel result (`{ state: 'cancelled' }`) and
   `data.sent: false` on a submit error. If you want these as shared types
   next to `PluginMediaSubmitData`, they are:
   `PluginMediaSubmitInput = { operation; prompt; idempotencyKey; references?: { name; mime; base64 }[]; size?; durationSeconds?; format? }`
   and `PluginMediaJobInput = { remoteId: string }`.

4. **Only if Neno chooses "Both cards"**: `MediaProvider.submit` needs an
   `approve` option (the plugin card), passed from `ctx.approve` in tools.ts
   through `JobTracker.submit`. For "Design card only", nothing changes in
   shared files: C flips `SUBMIT_APPROVAL` in `plugin-media/index.ts`.

5. **Clearer reason for a removed plugin's job** (`src/main/design/jobs.ts`,
   `need`). Today the message is "The provider for this job isn't available
   now." For a `plugin:` provider id, it could say the plugin was removed or
   turned off, and that saved outputs stay. This is low priority.

6. **A permanent result error is retried until the check cap**
   (`jobs.ts`, `check`). A result that fails C's checks (wrong type, refused
   link) keeps the job `running`. That's right for an expired link, which may
   come back fresh, but not for a type mismatch. The bounded check cap stops
   it. This is low priority.
