# Thread 2 requests to the integration owner

From `claude/stab-2-persistence` (stabilization 2.1–2.3).

1. **Amendment 2: no shared interface change.** The earlier
   `MediaProvider.recover?` hook is removed; `src/shared/design.ts` is
   untouched on this branch. Recovery is local: `JobTracker.reconcileLocal(find)`
   takes a local-file lookup (`images/index.ts localImageResult`), wired in
   `design/index.ts` before any handler is registered.
2. **`src/main/design/images/openai.ts`:** only the `results.put` call
   changed (it passes the job id for local correlation). Nothing else.
   **`src/main/design/jobs.ts` `put()` (integration-owned lines):** a job of a
   chat deleted during this run is never saved again (`deletedChats`, filled
   by `forgetChat`). Without it a submission or collection finishing after a
   delete wrote the job back (tests 6 and 7 fail without it).
3. **`src/main/design/images/index.ts` (owned).** `registerImages()` now
   returns the `ResultStore` and no longer prunes; pruning moved to
   `pruneImages()`, called from startup reconciliation in `design/index.ts`
   (Thread 2's wiring section). The old import of `design()` from `..` is gone.
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
