# Thread 2 requests to the integration owner

From `claude/stab-2-persistence` (stabilization 2.1–2.3).

1. **Contracts S1–S3 (ce41cd5) merged; no shared file changed.**
   `src/shared/design.ts` and `src/main/design/recovery.ts` are as you
   published them. The withdrawn `MediaProvider.recover` hook is gone.
2. **Integration-owned lines I touched, please review:**
   - `jobs.ts`: `linkLocal()` (called by the constructor's restore) and, in
     `put()`, a job of a chat deleted during this run is never saved again
     (`deletedChats`, filled by `forgetChat`). Without it a submission or a
     check finishing after a delete wrote the job back (tests 6 and 7 fail
     without it).
   - `tools.ts`: the version-settling block of `jobAction` moved, unchanged,
     into exported `settleJobVersion`, so startup reconciliation saves
     recovered results through the same path.
   - `design/index.ts`: startup wiring now calls `reconcile.ts` (my new file;
     your `recovery.ts` stays the registry), and `designChatDeleted` removes
     the chat's stored OpenAI images.
   - `images/openai.ts`: `results.put` records `options.correlationId`;
     the provider's own options type gains `correlationId?` (optional only so
     Thread 3's direct test calls still compile).
3. **`src/main/design/images/index.ts` (owned).** `registerImages()` also
   registers the OpenAI `LocalResultIndex` and returns the `ResultStore`;
   `pruneImages()` (with the 30-day window for unlinked results) and
   `forgetImageJobs()` live there.
4. **Not done, please apply: `src/main/memory/plugins.ts`
   `ensurePluginFolder`.** It still uses `mkdirSync(..., { recursive: true })`
   and `writeFileSync(overview, ..., { flag: 'wx' })`. Suggested change: use
   the same helper as captures. `memory/write.ts` can export `createNote`
   (currently module-private) and the call becomes
   `createNote(vault, overview, text)`, catching `FsafeExistsError` where it
   now catches `EEXIST`.
5. **Not done, for your call: `src/main/settingsFile.ts` `writeSettingsFile`**
   writes the temp file without `fsync` before the rename. A process crash is
   fine; a power cut can lose the last change (e.g. a job's `remoteId`) on
   some filesystems. Adding `fsync` of the temp file is cheap. It is shared
   by all settings, so it's yours.
6. **`src/main/vault/vault.test.ts`**: one assertion changed. A protected
   folder is now refused before it is made, so the test checks that no
   `Custard/Skills/x` folder is created at all (it used to expect an empty
   one).
