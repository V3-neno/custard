# Plugins workspace tooling requests: feasibility

Original commit: 4261aed0b97fde28aed1be3cd22cc815a7c5f845 (branch hostile-text), verified with `git rev-parse HEAD`. Re-checked at 7a23d19 (branch refresh-docs). [C]

Describes Custard code at commit 7a23d19. Written against 4261aed; see 'Changes since 4261aed' below.

## Changes since 4261aed

Status of the six requests, checked against the code at 7a23d19:

- Request 1, patch / replace-text tool: still open. There is no `fs_edit` or `fs_replace`; `FILE_WRITES` is still `fs_write`, `fs_delete`, `fs_rename`.
- Request 2, diff card: still open. The card is still a whole-file diff in one grey `<pre>`, and the two diff modules still order `-` and `+` differently.
- Request 3, type check: done, but inside `plugin_validate`, not as a separate `plugin_typecheck` tool. Code: `src/main/plugins/typecheck.ts`, run in `typecheck.worker.ts`, started from `typecheckInWorker` in `src/main/plugins/index.ts`, called by `validate(id, { typeCheck: true })` in `host.ts`.
- Request 4, single test file or name, timings: done. Report format in `src/main/workspace/report.ts`, runner in `src/plugin-sdk/testing.ts`, sandbox in `runtime.ts`, filter logic in `PluginHost.test()`.
- Request 5, diff against the active build: still open. `devTools` is still only `plugin_validate` and `plugin_test`.
- Request 6, enabling a plugin in the same chat: unchanged behaviour. Still true as described; the code lines quoted from `chat.ts` moved and the line numbers were dropped.

Detail:

- `plugin_validate` now type-checks the plugin with the TypeScript compiler in strict mode, in a worker thread so the app stays responsive. Type errors are listed apart from validation errors under "Type errors (the build works, but fix these):", or "Types: no errors." when clean. [C]
- Type errors make the tool result `isError`, but they do not make `validate()` fail: the build, `review()` and activation do not wait on them. `review()` and `plugin_test` call `validate` without the type check. [C]
- If the check cannot run (compiler files missing, 60 s limit hit), validation adds a warning "Types were not checked: ..." and carries on. [C]
- The compiler host reads only the plugin folder, the SDK folder and the compiler's own lib folder; any other path is refused. A test reads a file outside those and gets nothing. [C] [T typecheck.test.ts]
- Plugin code is checked without the DOM lib (a small declared set of globals instead: timers, console, `AbortController`, `URL`, `TextEncoder`). Widget entries, their folders and `tests/` are checked with the DOM. This answers the old "does the SDK compile without the DOM lib" question for the SDK paths the checker uses. [C]
- At most 30 type errors are listed, then a marker with the count. Lines look like `src/index.ts:12: TS2322: message`. [C]
- `typescript` moved from `devDependencies` to `dependencies`. electron-builder drops `.d.ts` files from `node_modules`, so `electron-builder.yml` copies `node_modules/typescript/lib` (`lib*.d.ts`) to the `typescript-lib` resource, which the packaged app passes as `libDir`. [C]
- `plugin_test` takes `file` (exact path of a file in `tests/`) and `name` (text contained in a test name, case-insensitive). The load check is skipped when either is given. An unknown `file` is an error that lists the test files. [C]
- `plugin_test` times every test (`[12 ms]`), stops a test that never settles after 10 s and runs the rest, and keeps the finished tests when the run is stopped (30 s limit or Stop), naming the test that was running. [C] [T]
- `plugin_test` no longer says "All checks passed." for nothing: a name that matches no test is an error, and a run that checked nothing says "No tests ran". The summary is "All N checks passed." or "K of N checks failed.". [C] [T report.test.ts]
- The `plugin_test` report puts failures first, cuts an error at 400 characters with a marker, and lists at most 80 result lines, then "[... N more results left out ...]". [C]
- `fs_write` is now atomic: it uses `writeReplaceSync` (temp file beside the target, rename over it, keeps the file's mode, replaces a link at the name). The hard-link refusal in `resolveInside` still applies. [C]
- A leftover `.<name>.<12 hex>.tmp` file is now skipped by `readSources` (so it no longer changes the build hash), `fs_list` and `fs_search`, via `isAtomicTemp`. The `readSources` probe result in request 1 is out of date. [C]
- `fs_list`, `fs_search` and plugin results now say when they cut something: `fs_search` ends with a note at 30 matches or 5,000 files searched, `fs_list` with "[N more not shown]", and a plugin result over 50,000 characters ends with a "characters are left out" note (redacted first, then cut). [C]
- A widget tool's `data` that is dropped (over 64 KB, not JSON, holds a saved credential) now adds a line to the tool's content, a plugin log entry, and `dataDropped` on the widget call result. [C host.ts]
- Corrected below: the `plugin_test` timeout is for the whole run, 30 s, and 10 s per test; line numbers into `chat.ts` were stale (`CORE_WRITES` is now at line 160) and were dropped or updated.

---

Every item below was first written as a feasibility note. Anything labelled PROPOSAL is not built unless the Changes section above says it is.

Tag legend (every statement carries one):

- [T] verified by a test I ran or an existing test
- [C] read from code (file named)
- [I] inferred
- [NB] not built
- [H] built but only a heuristic
- [U] unverified (needs a real model, Windows, macOS or a live provider)

Probe: `probes/zzws/zzws.test.ts` (copied beside this file; removed from the repo after running). Run with `npx vitest run src/main/plugins/zzws.test.ts`. 10 tests, all passed. Lines in this document that quote output marked "probe" come from that run at 4261aed; it was not re-run at 7a23d19, so a probe line is marked as out of date where the code has changed. It runs on Linux in Node/vitest, not in Electron, so it proves nothing about the real sandbox window. [T]

Effort sizes used here (no time estimates): small = one or two source files plus a test; medium = three to six files, a shared type or a renderer change; large = a new subsystem or a packaging change.

Existing prose not repeated: `docs/plugins/README.md`, `API.md`, `MANIFEST.md`, `SECURITY.md`, `TESTING.md`, `WIDGETS.md`, `docs/vault-tools.md`. Those files describe `plugin_validate` and `plugin_test` in one line each (README.md lines 17-18, API.md line 113) and say that a disabled plugin's tools are gone in the same chat (TESTING.md step 10). They say nothing about the items below. [C]

Background that every item needs. The Plugins workspace is `Workspace = { kind: 'internal', pluginId }`. Its tool list is `[...fileTools, ...referenceTools, ...devTools]` where `devTools` is exactly two tools: `plugin_validate` and `plugin_test` (`src/main/workspace/index.ts`). The six file tools are `fs_list, fs_read, fs_search, fs_write, fs_delete, fs_rename` and the two reference tools are `reference_list, reference_read` (`src/main/workspace/tools.ts`). There is no shell. [C]

---

## 1. A patch / replace-text tool for fs files

### What exists today

- There is no edit-in-place tool for workspace files. `fs_write` takes `path` and the full `content`, "Create or replace a text file in the workspace with the full new content. Missing folders are created." `runFileTool` answers `fs_edit` with `Unknown tool fs_edit` (probe at 4261aed; the default case is unchanged). [C src/main/workspace/tools.ts] [T]
- `fs_write` now writes with `writeReplaceSync(full, content)` after path checks, so it is atomic (temp file beside the target, rename over it, the file's mode kept). At 4261aed it was a plain `writeFileSync`. [C tools.ts `write()`]
- Limits: content over 500,000 characters is refused with `Files are limited to 500 KB.` (it counts characters, not bytes). [C tools.ts `MAX_WRITE`]
- Path safety on write comes from `resolveInside(b, rel, { forWrite: true })` in `src/main/workspace/paths.ts`: no absolute paths, no `..`, no symlinks or junctions, hard-linked existing files refused (`This file is hard-linked elsewhere, so it is not changed.`), names matching `DENIED_NAME` refused (`.git`, `node_modules`, `.env*`, `*.pem`, `*.key`, and so on), Windows 8.3 names refused. The race between check and write is a documented, accepted limitation. [C paths.ts header]
- `vault_edit` is the model for what is wanted. `src/main/vault/edit.ts` exports `applyEdits(text, edits)`. Its `replace` case is exactly-once: it finds `old_text` with `indexOf`, then looks for a second match. Verbatim messages (probe): `Edit 1: old_text matches more than once. Include more of the surrounding text so it matches once.`, `Edit 1: old_text was not found in the note. It must match the note's text exactly.`, `Edit 1: old_text can't be empty.` [T] [C]
- `applyEdits` also does: up to 20 edits per call, 20,000 characters per edit string, all edits matched against the original text (not sequentially), overlapping edits refused, all-or-nothing. It also has `insert_after_heading` and `append`, which are Markdown-specific. [C edit.ts `EDIT_LIMITS`, `applyEdits`]
- `vault_edit` additionally requires a `version` from `vault_read` (a hash of the text) and refuses if the note changed since, then re-checks the version immediately before writing, then writes through `writeReplaceSync` (temp file in the same folder, fsync, rename), then keeps an undo record. The frontmatter check there is a heuristic ([H] per its own comment) and is irrelevant to code files. [C edit.ts `planChange`, `changeNote`]
- `writeReplaceSync` is in `src/main/fsafe/index.ts`. It creates `.<name>.<12 hex>.tmp` next to the target with O_EXCL, renames it over the target, and removes the temp file on failure. It takes a `guard(realTarget)` callback. Residual races are listed in that file's header; none of it has run on Windows or macOS. [C] [U]
- Approval for `fs_write` already exists and is per call (see item 2). The tool is classified a write in `CORE_WRITES` in `src/main/chat.ts` (line 160 at 7a23d19) and in `FILE_WRITES` in tools.ts. [C]

### Status: still open (not built at 7a23d19)

### Feasibility

Feasible. `applyEdits` can be called as is with `[{ type: 'replace', old_text, new_text }]`. [I]

### Effort: small to medium

Files touched (exhaustive list, because a new write tool is named in several places):

1. `src/main/workspace/tools.ts`: add the tool definition to `fileTools`; add its name to `FILE_WRITES`; add a case in `previewFileChange` and `runFileTool`; add a shared "plan" function (read file, apply, check size, return before/after). [C]
2. `src/main/vault/edit.ts` or a new small helper: the error strings say "the note". Reusing `applyEdits` unchanged would tell the model "not found in the note" while it is editing a code file. Either parameterise the noun or copy the replace case (about 15 lines). [C]
3. `src/main/chat.ts` (`CORE_WRITES`, line 160): add the new name to `CORE_WRITES`. If it is missed, `c.write` is false for the call, and the "repeat of an action whose outcome is unknown" warning (`log.unknownRepeat`) and other write handling would not apply to it. [C] [I]
4. `src/shared/vault.ts` (the label switch around lines 39-50): add a label, otherwise the activity line falls to the default branch. [C]
5. `src/main/workspace/preview.test.ts`: has `expect([...FILE_WRITES].sort()).toEqual(['fs_delete', 'fs_rename', 'fs_write'])`, which must be updated. [T] [C]
6. `src/main/workspace/index.ts`: nothing for the tool list, because `names` is derived from `fileTools`; the prompt text could mention the new tool. [C]
7. Optionally the same name in the `CONTENT_TOOLS` regexes in `src/main/handoff.ts` and `src/main/memory/evidence.ts` only if its result should be treated as content. An edit result is a status line, so probably not. [I]

### What exactly would change (PROPOSAL, not built)

- New tool `fs_replace` (name is a choice): `{ path, old_text, new_text }`, optionally `edits: [...]` as in `vault_edit`. Behaviour: read the file (same binary and size checks as `read()`), apply `applyEdits`, refuse if result equals the original, refuse over `MAX_WRITE`. [NB]
- Write path: `fs_write` already uses `writeReplaceSync`, so a replace tool would reuse the same `write()` helper and get the atomic rename. The hard-link and `nlink` check in `resolveInside` must stay, because rename over a hard-linked file breaks the link instead of writing through it. [C] [I]
- The approval card shows a diff of exactly what will be written (see item 2).
- Add a version check: the preview should record a hash of the file it diffed, and the run step should re-read and refuse if the hash differs (`... changed since ...`). Without it, the user approves a diff computed from the file at preview time while the write happens at run time against a file the user could have edited in between. For `fs_write` this gap is harmless because the whole new content is what is approved; for a replace it is not, because the result depends on the current file. [I]

### Risks and security consequences

- Same boundary as `fs_write` (`resolveInside`), so no new reach. [C]
- Atomic rename leaves `.<name>.<hex>.tmp` files if the process dies between create and rename. At 4261aed `readSources()` read such a file as plugin source (probe returned `[".index.ts.a1b2c3d4e5f6.tmp","plugin.json"]`). This is fixed: `readSources` in `src/main/plugins/build.ts`, `fs_list` and `fs_search` now skip names matching `isAtomicTemp` (`src/main/fsafe/index.ts`). The temp file can still sit on disk after a crash, but it no longer changes the build hash. Cleanly finishing writes never leave one. [C] [T]
- Edit tool results are not "outside text" and nothing about them changes the "outside text makes edits ask first" logic, which is for the vault (`roundOutside` in chat.ts). The workspace path does not use it. [C]
- `old_text` containing CRLF vs LF: `indexOf` is exact, so a file with CRLF line endings will not match a model-written LF `old_text`. The model gets "not found". No normalisation exists. [I]

---

## 2. Showing a diff instead of a full-file card for `fs_write`

### Status: still open at 7a23d19 (checked: `workspace/diff.ts`, `tools.ts`, `plugins/diff.ts` and the approval card are unchanged in behaviour)

### What exists today (this is already partly built)

- `fs_write` on an existing text file already shows a line diff, not the full file. `previewFileChange` returns `label: "Replace <path>"` and `detail: "Changes to <path> (+ added, - removed):\n\n<diff>"`. [C tools.ts] [T preview.test.ts "shows a replaced file as a whole-file diff"]
- The diff is a whole-file diff: every line of the new file appears, unchanged lines prefixed with two spaces, removed with `- `, added with `+ ` (`src/main/workspace/diff.ts`). It never collapses unchanged lines, by design: "nothing that will be written is left out of what the user approves". [C diff.ts header] [T preview.test.ts "keeps every line of the new text"]
- Probe: a one-line change in a 300-line, 6,000-character file produced a `detail` of 303 lines and 6,443 characters. First lines: `["Changes to big.ts (+ added, - removed):","","  const line0 = 0","  const line1 = 1"]`. So for a small change the card is still a whole-file listing. [T]
- A new file shows `New file <path>, <n> characters:\n\n<full content>` (probe: `{"label":"Create new.ts","detail":"New file new.ts, 3 characters:\n\na\nb"}`). A diff is not meaningful there. [T]
- Replacing a binary file: `Replaces a binary file with <n> characters of text:\n\n<content>`. [C]
- A file over the cell limit (`a.length * b.length > 4_000_000`, roughly 2,000 by 2,000 lines) falls back to `(Too large to compare line by line: the current file has N lines. Every line of the new content follows.)` plus every new line prefixed `+ `. [C] [T preview.test.ts]
- A second diff implementation exists for the Settings review screen: `src/main/plugins/diff.ts` (`diffSources`), which keeps two lines of context and collapses the rest to `…`. Probe output for the same one-line change: `"  const line148 = 148\n  const line149 = 149\n+ const line150 = 9999\n- const line150 = 150\n  const line151 = 151\n  const line152 = 152\n…"`. Note the `+` line comes before the `-` line there, the opposite of the workspace diff (`- ` then `+ `). The two diffs disagree in ordering. [T] [C]
- Rendering: the card is `ApprovalCard` in `src/renderer/src/components/chat/Working.tsx`. It shows `<plugin> wants to: <label>` (for file changes the plugin name is `Custard`), then `detail` in a single `<pre>` with classes `max-h-72 overflow-auto ... text-[11px] whitespace-pre-wrap break-words text-ash-400`, aria-label "Everything this action will do". There is no per-line colouring, no hunks, no side-by-side, and the same grey colour for `+`, `-` and context lines. Buttons: Allow, Don't allow. "Allow for this chat" is hidden because file changes pass `individual: true`. [C Working.tsx; chat.ts approve call]
- The event carries `detail: string` ("Everything the user approves, never shortened") in `src/shared/chat.ts`. [C]
- The settings review screen shows `f.diff` raw in a `<pre>` as well (`PluginsTab.tsx` line 312), so the app has no coloured diff component anywhere. [C]
- `fs_write` is approved on every call; the preview is computed in the main process in `chat.ts` right before the write, from the file on disk at that moment (the `workspace.preview(c.name, c.input)` call in `chat.ts`). [C]

### Feasibility

Feasible, with a firm rule to decide: the rule in the code today is that the user must see every line that will be written. A hunk-only diff breaks that rule for a full-file replace, unless the unchanged lines are truly unchanged, which a diff by definition guarantees. A diff that shows only changed lines plus context loses nothing the user is approving: the unchanged lines are already on disk. The existing rule is therefore stricter than necessary for existing files. The exception is the "too large to compare" fallback, which needs all new lines. [I]

### Effort: small (card text only) to medium (coloured rendering)

Option A, text only (small): in `src/main/workspace/diff.ts`, add context folding to `lineDiff` (keep N lines around each change, replace runs with a line such as `… 120 unchanged lines`). Files: `diff.ts`, `preview.test.ts`. [I]

Option B, rendered diff (medium): change the approval event's shape so the renderer can colour lines. Files: `src/shared/chat.ts` (event type), `src/main/chat.ts` (approve/emit), `src/main/workspace/tools.ts` (`FilePreview`), `src/main/workspace/index.ts` (`WorkspaceTools.preview` type), `src/renderer/src/components/chat/Working.tsx` and `ChatView.tsx` (`Approval` type and card). Cheapest renderer-only form: keep `detail: string` and colour lines by their first two characters (`+ `, `- `), which works with the current format. [I]

### What exactly would change (PROPOSAL, not built)

- Collapse unchanged runs longer than, say, 6 lines in the card, keep the "Too large" fallback complete. Keep the label and the full-content card for new files. [NB]
- Renderer: wrap each line of `detail` for approvals whose label starts with `Replace` or `Edit` in a span coloured by prefix. Do not use `dangerouslySetInnerHTML`; keep `<pre>` text nodes. [NB]
- Make the two diff implementations agree on `-`/`+` order, or merge them into one module. [NB]
- For the replace tool in item 1, show the diff of old file vs result, not the raw `old_text`/`new_text`. [NB]

### Risks and security consequences

- The card is the only thing standing between a model-written file change and the disk. Folding unchanged lines is safe only if the fold is computed from the same text that is written. The current code computes the diff and the write from the same `i.content` input, so they agree. If a future replace tool writes a result computed at run time, the preview must be the same computation or must be checked by hash (see item 1). [I]
- Whitespace-only and line-ending-only changes are invisible in a coloured diff unless made visible. The current format shows them as `-`/`+` pairs of lines that look identical. [I]
- `max-h-72` plus scrolling means a long diff is not visible without scrolling; a collapsed view makes the full change visible at a glance, which helps real review. [I]
- Rendering untrusted text (model-written code, and file contents that may be attacker-influenced) as React text nodes is safe; HTML rendering of it would not be. [I]

---

## 3. A tsc type-check tool (`plugin_typecheck`)

### Status: done, as part of `plugin_validate` (no separate tool)

`plugin_validate` now type-checks. Code: `src/main/plugins/typecheck.ts` (the check), `typecheck.worker.ts` (runs it in a worker thread), `typecheckInWorker` in `src/main/plugins/index.ts` (starts the worker, 60 s limit, terminates it), `PluginHost.validate(id, { typeCheck: true })` in `host.ts`, report lines in `src/main/workspace/index.ts`. Tests: `src/main/plugins/typecheck.test.ts`. A separate `plugin_typecheck` tool was not built, and the proposal's other points are answered below. [C] [T]

### What the answer was at 4261aed

`plugin_validate` did not type-check: esbuild only strips types (`tsconfigRaw: '{}'`), so a wrong type passed validate, test and activation. Probe at 4261aed: `const n: number = 'not a number'` bundled fine and tsc reported `TS2322`. Nothing in the app imported `typescript`, and it was a devDependency. Probe timings (Node under vitest, not Electron): fresh scaffold 756 ms, `plugin/spotify` 1,687 ms, two-error plugin 417 ms. [T]

### As built

- Strict mode, target ES2022, `moduleResolution: Bundler`, `types: []`, `skipLibCheck`, and `paths` for the three SDK entry points (`custard-plugin-sdk`, `/testing`, `/widget`) mapped to the SDK folder. The plugin's own tsconfig is ignored, as esbuild ignores it. [C]
- Files: every `.ts` file in the plugin folder except hidden names, `node_modules`, symlinks and `.d.ts` files (at most about 500). [C]
- Two programs: plugin code with `lib.es2022` only plus a small declared set of sandbox globals (timers, `console`, `AbortController`/`AbortSignal`, `URL`, `URLSearchParams`, `TextEncoder`/`TextDecoder`), so `document`, `window` and `fetch` do not type-check in plugin code; widget entries, their folders and `tests/` with `lib.dom`. [C]
- A custom compiler host refuses every path that is not in the plugin folder, the SDK folder or the compiler's lib folder, so `../../secret/x` and absolute paths resolve to nothing and nothing from outside is quoted in a diagnostic. Tested with an outside file. [C] [T typecheck.test.ts]
- At most 30 errors are listed, each as `path:line: TS<code>: first line of the message`, then a marker with the count of the rest. [C]
- The worker keeps the main process responsive. A missing lib folder gives "the TypeScript library files aren't installed", which `validate` turns into a "Types were not checked" warning. [C]
- Result: `plugin_validate` lists type errors under "Type errors (the build works, but fix these):" and the tool result is `isError`; `validate()` itself stays `ok`, so `review()`, `plugin_test` and activation do not depend on type errors. Making them block activation was not done. [C]
- Packaging: `typescript` is now in `dependencies`; `electron-builder.yml` ships `node_modules/typescript/lib` (`lib*.d.ts`) as the `typescript-lib` resource because electron-builder drops `.d.ts` files from `node_modules`; the packaged app passes it as `libDir`. The compiler runs from `app.asar` with the lib files outside it. [C]
- Checked: Spotify type-checks clean in a dev build and in the packaged Linux worker (about 2.7 s). Not checked: the whole packaged-app UI path for `plugin_validate`, Windows and macOS packaging of the lib resource, and other plugins than Spotify, which may now show type errors. [U]

### Still open for this item

- No separate `plugin_typecheck` tool, and no option to fail validation on type errors. [NB]
- The host checks path text, not real paths: it does not call `realpath` or `isDeniedName`. The source walk skips symlinks, but an import of a symlink inside the plugin folder is not covered by a test. [C] [U]
- The 30-error cap hides the rest until the first ones are fixed (by design, the marker says so). [C]

---

## 4. Running a single test file or test name, with timings

### Status: done (with two small leftovers below)

Code: input schema and `testReport` call in `src/main/workspace/index.ts`; report format in `src/main/workspace/report.ts` (tests in `report.test.ts`); filter, file choice, partial results and the "nothing ran" rule in `PluginHost.test()` (`src/main/plugins/host.ts`); per-test timing, 10 s limit and skipped tests in `runRegisteredTests` (`src/plugin-sdk/testing.ts`); progress lines, partial results and the 30 s limit in `runTestsInSandbox` (`src/main/plugins/runtime.ts`); `TestReport` in `src/shared/plugins.ts` now has `ms`, `ran` and `skipped`. [C]

### As built

- Input: `{ file?, name? }`. `file` must equal a path in `tests/*.test.ts|js` from `readSources` (so the model's string is never used as a path; `\` and a leading `./` are normalised), and only that file is bundled. An unknown file is an error listing the real test files. `name` is a case-insensitive substring of the test name (the proposal said case-sensitive), applied inside `runRegisteredTests`; other tests come back as skipped and are counted in the "did not match the filter" line. [C]
- The load check runs only on an unfiltered run. [C]
- Timings: each result carries `ms` from `Date.now()` and prints as `[12 ms]`. [C]
- A test that never settles fails after 10 s (`Took longer than 10 seconds.`) and the rest still run. [C]
- Partial results: the runner prints a line as each test starts and finishes; the sandbox host reads them. When the 30 s limit or Stop ends the run, the finished tests are kept and the error names the test that was running. [C] [T real sandbox suite per the PR notes]
- A name that matches nothing is an error (`No test name contains "x".`). A run with no results says "No tests ran. Add tests in tests/*.test.ts; nothing was checked." instead of "All checks passed." [C] [T report.test.ts]
- Output is capped: failures first, an error cut at 400 characters with a marker, at most 80 result lines, then a count of what was left out. [C]
- Report format now: header (`All N checks passed.` / `K of N checks failed.` / `Tests did not finish cleanly.`), then `- pass: <name> [12 ms]` and `- FAIL: <name> [12 ms] (<error>)`, then an optional skipped line and `Error: ...`. `isError` is true when `!r.ok`. [C]
- Unchanged: the registry is still one global array (`globalThis.__custardTests`) for the whole bundle; `src/plugin-sdk/plugin-tests.test.ts` still runs every plugin test file under vitest; the sandbox still has no bridge, no network and no capabilities; `testing.ts` is still not part of the build hash. [C]
- Spotify has 114 tests (115 checks with the load check). The 114-case probe at 4261aed was a vm stand-in, not the Electron sandbox. [T] [U]

### Still open for this item

- A plugin with no test files still reports "All 1 checks passed." on an unfiltered run, because the load check counts as a result; only `plugin_validate` warns "There are no tests in tests/*.test.ts." The "No tests ran" line appears when nothing at all produced a result. [C] [I]
- A test stuck in a busy loop is named by its start. A test that loops after its last progress line cannot be told apart from one that hung earlier. The 30 s limit is one limit for the whole run. [C]
- Per-test timing precision in the sandbox window (timers may be coarsened) was not checked. [U]

---

## 5. Reading the active (built/installed) plugin's source to diff against the workspace copy

### Status: still open at 7a23d19 (no `plugin_diff` or `plugin_read_active`; `devTools` has two tools; `review()` and `diffSources` are still reachable only from Settings)

### Where installed plugins live, and whether the workspace is a copy

- The workspace is not a copy. The Plugins workspace boundary root is `join(pluginsRoot(), pluginId)`, i.e. the live source folder. `pluginsRoot()` is `CUSTARD_PLUGIN_DIR` if set, else `<resources>/plugin` when packaged, else `<app path>/plugin` (the repo's `plugin/` in development). The host reads the same folder (`sourceRoot: pluginsRoot`). Edits happen in place. [C src/main/plugins/index.ts, workspace/index.ts]
- The "installed" form is a build in the app data folder, separate from source. Layout from `src/main/plugins/store.ts` header: [C]
  ```
  plugins/<id>/state.json    enabled, active/previous build, granted permissions
  plugins/<id>/config.json   non-secret configuration
  plugins/<id>/secrets.bin   secret config and account tokens, OS-encrypted
  plugins/<id>/data.json     the plugin's own storage
  plugins/<id>/builds/<id>/  bundle.js, manifest.json, sources.json
  ```
  Probe of `saveBuild` produced a build folder with `["bundle.js","instructions.md","manifest.json","sources.json"]` (plus `widgets/` when there are widgets). `sources.json` is a JSON array of `{ path, content }` for every source file at build time, and `store.buildSources(id, buildId)` returns it (probe: `[{"path":"a.ts","content":"x"}]`). So the installed plugin does include a full source snapshot. [T] [C]
- Build ID: first 16 hex characters of a SHA-256 over all source files plus selected SDK files. `status().sourceChanged` is true when the current source hash differs from the active build ID. [C host.ts `sourceHash`, `status`]
- Builds are kept per source hash: `validate()` saves a build whenever the hash is new, active or not (staged). `pruneBuilds` is called only from `activate()`, keeping the new active and the previous one. So repeated `plugin_validate` runs on changed source accumulate builds in the app data folder until the next activation. [C host.ts `validate` and `activate`] [I] (no cap was found)

### Can the model read the installed copy today? No.

- `fs_*` tools: the workspace boundary is `{ root: <plugin source folder>, deny: [app.getPath('userData')] }`, and the store lives under `join(app.getPath('userData'), 'plugins')`. Probe: a symlink from the workspace to the store is refused with `Symbolic links and junctions are not followed.`; `../../userData/plugins/mine/state.json` is refused with `".." is not allowed in workspace paths.` [T] [C]
- `reference_read` / `reference_list` read only fixed virtual roots: `docs` (the `docs/plugins` folder), `sdk` (the SDK source) and `examples/spotify` (the spotify plugin's source folder, only offered when the plugin being developed is not spotify). Probe: `reference_list` → `docs/\nsdk/\nexamples/spotify/`; `reference_list examples` → `spotify/`; `reference_read examples/spotify/plugin.json` works; `reference_read builds/x` → `Not found in the reference material.`; a `..` path → `".." is not allowed in workspace paths.` [T]
  - `examples/spotify` is the live source folder, not the installed build. It shows the working tree, not what is activated. [C index.ts: `refs['examples/spotify'] = join(pluginsRoot(), 'spotify')`]
  - Other plugins in `plugin/` besides spotify are not readable by the model from another plugin's workspace. [C]
  - `reference_read` uses the same `read()` as `fs_read`: binary files refused, text over 200,000 characters truncated with `[truncated at 200000 characters]`. [C]
- The Settings review screen already computes the diff: `PluginHost.review(id)` calls `diffSources(store.buildSources(id, active.buildId), readSources(sourceDir))` and returns `files: FileChange[]` (`{ path, change: 'added'|'changed'|'removed', diff? }`), shown in `PluginsTab.tsx`. It is reachable by IPC `plugins:review` only. The model gets neither `review` nor `diffSources`; `devTools` has only `plugin_validate` and `plugin_test`. [C host.ts `review`, plugins/index.ts, workspace/index.ts]
- `review()` calls `validate()` first (without the type check), which may save a staged build. A diff tool built on `review()` would carry that side effect. [C]

### Feasibility

Feasible and cheap. The data (`sources.json`) and the diff function (`diffSources`) both exist. [C]

### Effort: small

Files touched: `src/main/workspace/index.ts` (tool def, run branch, prompt line), `src/main/plugins/host.ts` (a small method that returns `diffSources(buildSources(active), readSources(dir))` without calling `validate`, plus a way to read one file of the active build), `src/shared/vault.ts` (label), `src/main/handoff.ts` and `src/main/memory/evidence.ts` (`CONTENT_TOOLS` regexes, since the result is file content, so that only its status is carried into summaries and memory), tests. [I]

### What exactly would change (PROPOSAL, not built)

- `plugin_diff`: no input, read-only. Compares the active build's `sources.json` with the current source folder. Output: per file `added` / `changed` / `removed` and the hunk diff from `diffSources`, with a total size cap. If no active build exists: say "Not activated yet; every file is new." rather than listing everything as added. [NB]
- Optional `plugin_read_active { path }`: returns one file's text from the active (or previous) build. [NB]
- Do not route through `review()`, to avoid staging a build. [NB]
- Fix the `+`/`-` ordering mismatch with the workspace diff (item 2) first, or the model sees two different diff styles in one session. [NB]

### Risks and security consequences

- Content leaves `userData`, but only what `readSources` captured, which already excludes `isDeniedName` names (`.env*`, keys, `.git`, `node_modules`) and symlinks. A secret that was in a file at build time and removed since would be returned from the old snapshot. Source files must not hold secrets anyway (workspace prompt: "Never put secrets in files"). The risk is that the model sees an old leaked value; it would already have seen it if it wrote it. [C] [I]
- Never give the model a path into `userData`. The tool must take no path or only a path validated against the snapshot's own file list, never joined onto the store directory. [I]
- `diffSources` output for a large change is unbounded text (a diff string per file); `lineDiff` in `plugins/diff.ts` returns `undefined` above 4,000,000 cells and the UI then prints "(too large to show)". A tool result needs its own cap. [C diff.ts] [I]

---

## 6. How a plugin enabled in Settings becomes callable in Code mode in the same chat

### Status: a question, not a request; the answer still holds at 7a23d19 (re-read in `chat.ts` and `host.ts`, the host probe was not re-run)

### Short answer

A chat can use a plugin enabled in Settings on its very next message. No new chat is needed for enabling, disabling or updating a plugin. A new chat is needed only to change workspace kind (General vs Plugins) or which Plugins workspace. [C] [T for the host half, see probe below] [U for a real model run]

### As built

- The tool list is built once per user message, not once per chat and not once per model round. `chat:send` calls `send(sender, req)` (`src/main/chat.ts`, line 1104 for the handler and line 252 for `send` at 7a23d19), and `send` builds the list once: [C]
  ```ts
  const policy = modePolicy(conversation.mode, conversation.workspace)
  ...
  const pluginsAllowed = policy.tools.has('plugin')
  const plugins = pluginsAllowed
    ? pluginHost().toolSet(conversation.mode)
    : { tools: [], snapshot: new Map(), instructions: [] }
  ...
  const tools: BetaTool[] = [
    ...(vaultReady ? vaultTools : []),
    ...
    ...(workspace?.tools ?? []),
    ...
    ...plugins.tools,
    ...
  ].filter((t) => policy.tools.has(kindOf(t.name)))
  const available = new Set(tools.map((t) => t.name))
  ```
  The same `tools` and `available` are used for every model round in that reply (the tool loop passes `tools` to each request), so a plugin enabled while a reply is already running is not offered until the next message. [C] [I]
- `toolSet(mode)` reads current state each call: for every id in the store, skip unless `st.enabled && st.active`; tools are `<id>__<tool>` with description `[<plugin name> plugin] <description>`. In `code` mode the per-mode "Chat design" opt-in is not required (`needsChatDesign = (mode) => mode !== 'code'`). [C host.ts `toolSet`, `needsChatDesign`]
- Which Code chats get plugin tools at all: `modePolicy('code', workspace)` adds `'plugin'` and `'widget'` only when `workspace.kind === 'internal'`. A General Code chat never gets plugin tools. [C policy.ts] [T policy.test.ts: `general.tools.has('plugin')` is false, `internal.tools.has('plugin')` is true]
- The workspace is fixed per chat: `conversation.workspace = verifyWorkspace(req.workspace)` runs only when the conversation is new (`if (!existing && req.mode === 'code')`), the renderer passes `workspace` only for a new Code chat (`mode === 'code' && !current && workspace`), and the picker is shown as `fixed={current ? current.workspace : null}`. A General chat cannot become a Plugins chat, and a Plugins chat for plugin A stays on A (although it sees the tools of every enabled plugin, not just A). [C chat.ts around line 278, ChatView.tsx]
- The system prompt is also rebuilt per message. Enabled plugins' `instructions.md` text goes in as `<plugin name="..." tools="<id>__*">`. The paragraph introducing the `<plugin>__<tool>` naming ("Plugins the user enabled add the tools named <plugin>__<tool>...") is added only `if (plugins.instructions.length)`, so a plugin with empty instructions would add tools with no explanatory paragraph. The scaffold writes a non-empty placeholder instructions file, so this only bites if it is emptied. [C chat.ts, where the system prompt is built; scaffold.ts] [I]
- History: calls in earlier turns to tools no longer offered are converted to text (`withoutUnavailableTools(history, available)`), so disabling does not break the transcript. [C chat.ts; src/main/history.ts] [T history.test.ts]
- Every call is checked again when it runs: `if (!available.has(c.name))` → `<name> isn't available in this chat, so nothing was done.`; and in `PluginHost.invoke` (re-checked at call time) state, build and permissions are compared with the snapshot taken in `toolSet`. [C]
- Messages (verbatim): `The <id> plugin is disabled, so this call was not run.` and `The plugin was updated or rolled back after this reply started, so this call was not run. Ask again to use the current version.` and `This tool is not available right now.` [C host.ts `invoke`] [T host.test.ts "unregisters tools on disable and rejects stale calls without running them", "rejects calls offered by an older build after an update", "rejects tools the model was never offered"]
- The model cannot enable anything. `activate`, `enable`, `disable` are IPC handlers for Settings (`plugins:activate`, `plugins:enable`, `plugins:disable` in `src/main/plugins/index.ts`) and are not in the workspace tool list. `plugin_validate` stages a build only; activation needs the user and approval of every permission. [C]

### Probe (host level)

`PluginHost` with a Node vm stand-in runtime and a scaffolded plugin `zzdemo`: [T]

```
Q6 before activation code/chat => [] []
Q6 review ok true newPermissions []
Q6 after activate code/chat => ["zzdemo__hello"] []
Q6 after disable => []
Q6 stale call => {"content":"The zzdemo plugin is disabled, so this call was not run.","isError":true,"outcome":"not-run"}
Q6 after enable => ["zzdemo__hello"]
```

- `chat` mode returned `[]` after activation because the plugin has not been opted in to Chat design; `code` mode returned the tool. [T]
- What the probe does not cover: `chat.ts` itself. It imports Electron and cannot be loaded in vitest in this repo's setup, and no existing test runs `send`. The statement "the list is rebuilt per message" is from reading the code at the lines quoted above. [C] [U]
- Not verified with a real model, a real Electron window, or on Windows or macOS. [U]

### What this means for the plugin-authoring workflow

- After `plugin_validate` and `plugin_test` pass, the user activates in Settings → Plugins; the next message in the same Plugins chat already sees `<id>__<tool>`. [C] [U]
- If the user activates a new build while a reply is in progress, a plugin call in that reply is refused with the "updated or rolled back after this reply started" message. The model must be asked again in a new message. [C] [T]
- Plugin tools with `effect: "write"` still ask the user for approval per call unless the user turned asking off for that tool. [C docs/plugins; not repeated]
- Gap: nothing tells the model, in the Plugins workspace prompt, that an activated plugin's tools show up in the next message. The prompt only says "tell the user to open Settings → Plugins, review the changes and permissions, and activate it." [C workspace/index.ts]

---

## Remaining known gaps

Shared gaps (same wording in every refreshed reference doc):

1. Memory: Memory.md is edited by the user only. Nothing in Custard writes or corrects a stored UTC offset in it; a stale "UTC+2" there stays. The chat is told the time zone by name with its current offset and to trust that over a note's offset, and docs/vault-tools.md says Memory should record a zone name, not an offset. Accepted by design (Neno, 2026-10-12).
2. Type check (plugin_validate): type errors are reported but do not block review or activation; other plugins than Spotify may now show type errors. Verified in a dev build and in the packaged Linux worker; the full packaged-app UI path and Windows/macOS packaging of the TypeScript lib resource are unverified.
3. plugin_test: a test stuck in a busy loop is named by its start, not its progress; the 30 s global limit is a single limit for the whole run.
4. A widget must handle `dataDropped` itself; the Spotify widget does not yet show that its view is out of date. A widget's input over its limit is still refused rather than reported (not changed).
5. Docs errors not fixed in code: docs/plugins/TESTING.md says 23 Spotify tests (there are 114; 115 checks with the load check). `docs/plugins/README.md` and `API.md` still describe `plugin_validate` and `plugin_test` in one line each and do not mention type errors, `file`, `name` or timings.
6. Not verified anywhere: Windows, macOS, live providers, a running Obsidian, real OS clock changes, rename-over-open-file behaviour with antivirus or Obsidian holding the file (`fs_write` now relies on it).

Request-specific leftovers:

7. No patch / replace-text tool (request 1) and no coloured or folded diff card (request 2). The two diff modules (`workspace/diff.ts`, `plugins/diff.ts`) still order `-` and `+` differently.
8. The model cannot see the active build or any diff against it (request 5). Each distinct `plugin_validate` still stages a build in app data; `pruneBuilds` runs only on activation and no cap was found.
9. An unfiltered `plugin_test` on a plugin with no test files reports "All 1 checks passed." (the load check). The type-check host compares path text and does not resolve symlinks; no test covers a symlink inside the plugin folder.
10. The "Plugins the user enabled add the tools named..." paragraph in the system prompt is still added only when some plugin has instructions text, and the Plugins workspace prompt still does not say that an activated plugin shows up on the next message.
11. `chat.ts` `send` is still not covered by a test, so the per-message tool list in request 6 rests on code reading. Timer precision for per-test timings in the sandbox window, and any real model use of these tools, were not checked.
