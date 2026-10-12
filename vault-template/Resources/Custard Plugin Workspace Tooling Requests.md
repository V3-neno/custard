# Plugins workspace tooling requests: feasibility

Commit: 4261aed0b97fde28aed1be3cd22cc815a7c5f845 (branch hostile-text), verified with `git rev-parse HEAD`. [C]

Nothing in this document is implemented. Every item below is a feasibility note. Anything labelled PROPOSAL is not built.

Tag legend (every statement carries one):

- [T] verified by a test I ran or an existing test
- [C] read from code (file named)
- [I] inferred
- [NB] not built
- [H] built but only a heuristic
- [U] unverified (needs a real model, Windows, macOS or a live provider)

Probe: `probes/zzws/zzws.test.ts` (copied beside this file; removed from the repo after running). Run with `npx vitest run src/main/plugins/zzws.test.ts`. 10 tests, all passed. Lines in this document that quote output marked "probe" come from that run. It runs on Linux in Node/vitest, not in Electron, so it proves nothing about the real sandbox window. [T]

Effort sizes used here (no time estimates): small = one or two source files plus a test; medium = three to six files, a shared type or a renderer change; large = a new subsystem or a packaging change.

Existing prose not repeated: `docs/plugins/README.md`, `API.md`, `MANIFEST.md`, `SECURITY.md`, `TESTING.md`, `WIDGETS.md`, `docs/vault-tools.md`. Those files describe `plugin_validate` and `plugin_test` in one line each (README.md lines 17-18, API.md line 113) and say that a disabled plugin's tools are gone in the same chat (TESTING.md step 10). They say nothing about the items below. [C]

Background that every item needs. The Plugins workspace is `Workspace = { kind: 'internal', pluginId }`. Its tool list is `[...fileTools, ...referenceTools, ...devTools]` where `devTools` is exactly two tools: `plugin_validate` and `plugin_test` (`src/main/workspace/index.ts`). The six file tools are `fs_list, fs_read, fs_search, fs_write, fs_delete, fs_rename` and the two reference tools are `reference_list, reference_read` (`src/main/workspace/tools.ts`). There is no shell. [C]

---

## 1. A patch / replace-text tool for fs files

### What exists today

- There is no edit-in-place tool for workspace files. `fs_write` takes `path` and the full `content`, "Create or replace a text file in the workspace with the full new content. Missing folders are created." `runFileTool` answers `fs_edit` with `Unknown tool fs_edit` (probe). [C src/main/workspace/tools.ts] [T]
- `fs_write` writes with plain `writeFileSync(full, content)` after path checks. It is not atomic: no temp file, no rename, no fsync. [C tools.ts `write()`]
- Limits: content over 500,000 characters is refused with `Files are limited to 500 KB.` (it counts characters, not bytes). [C tools.ts `MAX_WRITE`]
- Path safety on write comes from `resolveInside(b, rel, { forWrite: true })` in `src/main/workspace/paths.ts`: no absolute paths, no `..`, no symlinks or junctions, hard-linked existing files refused (`This file is hard-linked elsewhere, so it is not changed.`), names matching `DENIED_NAME` refused (`.git`, `node_modules`, `.env*`, `*.pem`, `*.key`, and so on), Windows 8.3 names refused. The race between check and write is a documented, accepted limitation. [C paths.ts header]
- `vault_edit` is the model for what is wanted. `src/main/vault/edit.ts` exports `applyEdits(text, edits)`. Its `replace` case is exactly-once: it finds `old_text` with `indexOf`, then looks for a second match. Verbatim messages (probe): `Edit 1: old_text matches more than once. Include more of the surrounding text so it matches once.`, `Edit 1: old_text was not found in the note. It must match the note's text exactly.`, `Edit 1: old_text can't be empty.` [T] [C]
- `applyEdits` also does: up to 20 edits per call, 20,000 characters per edit string, all edits matched against the original text (not sequentially), overlapping edits refused, all-or-nothing. It also has `insert_after_heading` and `append`, which are Markdown-specific. [C edit.ts `EDIT_LIMITS`, `applyEdits`]
- `vault_edit` additionally requires a `version` from `vault_read` (a hash of the text) and refuses if the note changed since, then re-checks the version immediately before writing, then writes through `writeReplaceSync` (temp file in the same folder, fsync, rename), then keeps an undo record. The frontmatter check there is a heuristic ([H] per its own comment) and is irrelevant to code files. [C edit.ts `planChange`, `changeNote`]
- `writeReplaceSync` is in `src/main/fsafe/index.ts`. It creates `.<name>.<12 hex>.tmp` next to the target with O_EXCL, renames it over the target, and removes the temp file on failure. It takes a `guard(realTarget)` callback. Residual races are listed in that file's header; none of it has run on Windows or macOS. [C] [U]
- Approval for `fs_write` already exists and is per call (see item 2). The tool is classified a write in `CORE_WRITES` in `src/main/chat.ts` line 157 and in `FILE_WRITES` in tools.ts. [C]

### Feasibility

Feasible. `applyEdits` can be called as is with `[{ type: 'replace', old_text, new_text }]`. [I]

### Effort: small to medium

Files touched (exhaustive list, because a new write tool is named in several places):

1. `src/main/workspace/tools.ts`: add the tool definition to `fileTools`; add its name to `FILE_WRITES`; add a case in `previewFileChange` and `runFileTool`; add a shared "plan" function (read file, apply, check size, return before/after). [C]
2. `src/main/vault/edit.ts` or a new small helper: the error strings say "the note". Reusing `applyEdits` unchanged would tell the model "not found in the note" while it is editing a code file. Either parameterise the noun or copy the replace case (about 15 lines). [C]
3. `src/main/chat.ts` line 157: add the new name to `CORE_WRITES`. If it is missed, `c.write` is false for the call, and the "repeat of an action whose outcome is unknown" warning (`log.unknownRepeat`) and other write handling would not apply to it. [C] [I]
4. `src/shared/vault.ts` (the label switch around lines 39-50): add a label, otherwise the activity line falls to the default branch. [C]
5. `src/main/workspace/preview.test.ts`: has `expect([...FILE_WRITES].sort()).toEqual(['fs_delete', 'fs_rename', 'fs_write'])`, which must be updated. [T] [C]
6. `src/main/workspace/index.ts`: nothing for the tool list, because `names` is derived from `fileTools`; the prompt text could mention the new tool. [C]
7. Optionally the same name in the `CONTENT_TOOLS` regexes in `src/main/handoff.ts` and `src/main/memory/evidence.ts` only if its result should be treated as content. An edit result is a status line, so probably not. [I]

### What exactly would change (PROPOSAL, not built)

- New tool `fs_replace` (name is a choice): `{ path, old_text, new_text }`, optionally `edits: [...]` as in `vault_edit`. Behaviour: read the file (same binary and size checks as `read()`), apply `applyEdits`, refuse if result equals the original, refuse over `MAX_WRITE`. [NB]
- Write path: use `writeReplaceSync` instead of `writeFileSync`, so the change is one atomic rename. The guard would be `() => null` or a re-run of `resolveInside`. Hard-link and `nlink` check must stay, because rename over a hard-linked file breaks the link instead of refusing (this differs from `writeFileSync`, which writes through). [I]
- The approval card shows a diff of exactly what will be written (see item 2).
- Add a version check: the preview should record a hash of the file it diffed, and the run step should re-read and refuse if the hash differs (`... changed since ...`). Without it, the user approves a diff computed from the file at preview time while the write happens at run time against a file the user could have edited in between. For `fs_write` this gap is harmless because the whole new content is what is approved; for a replace it is not, because the result depends on the current file. [I]

### Risks and security consequences

- Same boundary as `fs_write` (`resolveInside`), so no new reach. [C]
- Atomic rename leaves `.<name>.<hex>.tmp` files if the process dies between create and rename. `readSources()` in `src/main/plugins/build.ts` skips only `isDeniedName` names and symlinks, so a stray temp file in the plugin folder is read as a source file and goes into the build hash and the review diff. Probe: `readSources` of a folder with `.index.ts.a1b2c3d4e5f6.tmp` and `plugin.json` returned `[".index.ts.a1b2c3d4e5f6.tmp","plugin.json"]`. [T] The fix would be to make `isDeniedName` or `readSources` skip `*.tmp` dotfiles, or to put temp files outside the plugin folder. Cleanly finishing writes never leave one. [I]
- Edit tool results are not "outside text" and nothing about them changes the "outside text makes edits ask first" logic, which is for the vault (`roundOutside` in chat.ts). The workspace path does not use it. [C]
- `old_text` containing CRLF vs LF: `indexOf` is exact, so a file with CRLF line endings will not match a model-written LF `old_text`. The model gets "not found". No normalisation exists. [I]

---

## 2. Showing a diff instead of a full-file card for `fs_write`

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
- `fs_write` is approved on every call; the preview is computed in the main process in `chat.ts` right before the write, from the file on disk at that moment. [C chat.ts around line 581]

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

### Does `plugin_validate` type-check today? No.

- `plugin_validate` calls `pluginHost().validate(pluginId)`. That reads `plugin.json` through `readSource` (manifest, schema and permission checks), hashes the sources, and runs `bundle()` (esbuild). `bundle()` states: "esbuild only parses and transforms files; it never runs plugin code" and passes `tsconfigRaw: '{}'` with a comment "Ignore any tsconfig in the plugin folder." esbuild strips types without checking them. [C src/main/plugins/host.ts `validate`, build.ts]
- Probe: a plugin containing `const n: number = 'not a number'` and `name.nope` on a string bundled successfully (`bundle ok => true`), and tsc reported `TS2322 Type 'string' is not assignable to type 'number'.` and `TS2339 Property 'nope' does not exist on type 'string'.` So type errors pass `plugin_validate` and `plugin_test` today. [T]
- In the Custard repository, `npm run typecheck:node` (`tsc --noEmit -p tsconfig.node.json --composite false`) includes `plugin/**/*.ts` and maps `custard-plugin-sdk` paths to `src/plugin-sdk`. So the repo's own plugin (spotify) is type-checked by the developer's `npm run build`, but that is outside the app and unavailable to the model (there is no shell). [C package.json, tsconfig.node.json]
- Nothing in the app imports the `typescript` package. [C: grep of src found no `from 'typescript'` outside my probe] [I] `package.json` lists `"typescript": "^5.9.3"` under `devDependencies`; `esbuild` is under `dependencies`. Installed version in this checkout: 5.9.3. [C]

### Where tsc would come from

- Dev checkout: `node_modules/typescript` is present (5.9.3), `lib` folder is 23 MB (`du -sh`). [C]
- Packaged build: `typescript` is a devDependency, and electron-builder does not package devDependencies [I, standard electron-builder behaviour; not checked against a packaged build] [U]. `electron-builder.yml` also excludes `src/*`, `plugin/**` and the tsconfig files from the asar, and puts plugin sources, `src/plugin-sdk/*.ts` (minus tests) and `docs/plugins` in `extraResources` (`resources/plugin`, `resources/plugin-sdk`, `resources/docs/plugins`). [C]
- Offline: `typescript`'s compiler API needs only its own `lib.*.d.ts` files, read from disk next to the package. No network call is made. [I] Inside an asar archive the `lib` files would be read through Electron's patched `fs`; whether `ts.createProgram` works that way has not been tested. [U] The esbuild precedent: esbuild needed `asarUnpack` because it spawns a binary (`electron-builder.yml`, `build.ts` `unpackedBinary`); typescript spawns nothing, so it probably does not. [C] [I]
- Alternatives: `@typescript/native-preview` (a native binary, would also need `asarUnpack`); a check bundled by esbuild into the app. Neither is installed. [NB]

### Does the plugin type-check cleanly with a plausible config?

- Probe config: `strict`, `target ES2022`, `module ESNext`, `moduleResolution Bundler`, `lib: ['lib.es2023.d.ts','lib.dom.d.ts']`, `types: []`, `skipLibCheck`, `paths` for the three SDK entry points mapped to the SDK folder. All `.ts` files under the plugin folder (sources, widget, tests).
  - Fresh scaffold plugin: 0 diagnostics, 756 ms. [T]
  - `plugin/spotify` (src, widget and tests, 11 test files): 0 diagnostics, 1,687 ms. [T]
  - Two-error plugin: 2 diagnostics, 417 ms (after the first program had warmed the module). [T]
  - Timings are in Node under vitest on this machine; Electron's main process would add its own cost. [U]
- The probe includes the DOM lib. Plugin code runs in a sandbox "with no Node.js and no direct network" (workspace prompt), and the DOM lib would let `document` or `window` type-check even though they would fail at run time. Whether the SDK's own types compile without the DOM lib (e.g. `AbortSignal`, `URL`) was not tested. [U]

### Effort: medium (large if tsc must be packaged and unpacked)

Files touched: `src/main/plugins/host.ts` (new `typecheck(id)` method, or a separate `typecheck.ts` module), `src/main/workspace/index.ts` (tool def in `devTools`, run branch, prompt line), `src/shared/vault.ts` (label), `package.json` (move `typescript` to `dependencies`), `electron-builder.yml` (decide on `asarUnpack` for the compiler's lib folder), tests. [I]

### What exactly would change (PROPOSAL, not built)

- New tool `plugin_typecheck`, no input, read-only, no side effects, result format like `plugin_validate`: lines `- src/index.ts:2 TS2322 Type 'string' is not assignable to type 'number'.`, capped (say 50 diagnostics) with a count of the rest. `isError` true when any error. [NB]
- Program built from `readSources()` file list (so it sees exactly the files that are hashed), `paths` mapped to `sdkDir()`, `types: []`, config fixed in code and not read from a plugin tsconfig (esbuild already ignores tsconfig on purpose). [NB]
- Run it off the main thread (utility process or worker), because `ts.createProgram` is synchronous and CPU-heavy: 0.4 to 1.7 s measured blocks the main process event loop, including IPC, the chat stream and plugin runtime messages. [T for the timing] [I for the consequence]
- Decide whether `plugin_validate` should run it and fail on type errors. That would change behaviour for plugins that bundle and activate fine today. [NB]

### Risks and security consequences

- The type checker reads files only; it never runs plugin code. Module resolution must not follow `import` out of the plugin folder: `moduleResolution: Bundler` with `paths` could resolve `../../x` or a symlink to anywhere on disk. The existing esbuild guard in `build.ts` refuses symlinks and imports outside the plugin folder and SDK. A tsc program would need an equivalent `CompilerHost` (custom `fileExists`/`readFile`) that applies `isInside`/`isDeniedName`, or it could read `.env`-named files into diagnostics text. Without that guard, diagnostics can quote lines from files the model must not read (error messages quote source text). [I]
- A malicious or pathological plugin source can make type-checking very slow (deep conditional types). Needs a timeout and abort signal like `runTestsInSandbox` has (30 s, Stop button). [I]
- Adds ~23 MB (lib folder) plus the compiler to the packaged app, if packaged. [I]

---

## 4. Running a single test file or test name, with timings

### What exists today

`plugin_test` takes no input (`input_schema: { type: 'object', properties: {} }`). Flow in `PluginHost.test()` (`src/main/plugins/host.ts`): [C]

1. `validate(id)` (bundles, stages a build). If it fails, returns `{ ok: false, results: [], error: v.errors.join('\n') }`.
2. A load check: starts the built bundle in a fresh runtime with no capabilities (`onCap` returns `No capabilities during the load check.`) and checks every tool in `plugin.json` has a handler. It is reported as a result named `Plugin loads and handles every tool in plugin.json`.
3. Finds all files matching `/^tests\/.+\.test\.(ts|js)$/`, bundles them all into one script (`bundle(..., { kind: 'tests', files })`), checks the source hash did not change meanwhile, then runs the script with `runTestsInSandbox`.
4. `runTestsInSandbox` (`src/main/plugins/runtime.ts`) loads the code in a hidden window in the session `custard-plugin-tests` with no preload bridge, calls `globalThis.__custardRunTests()`, and maps each result to `{ name, ok, error }`. Timeout: 30,000 ms for the whole run (`TEST_TIMEOUT_MS`); Stop aborts it.

Runner: `runRegisteredTests()` in `src/plugin-sdk/testing.ts` runs the registered cases one after another, each in try/catch, so one failing test does not stop the rest. Result per case is `{ name, ok }` plus `error` (the error's `message`) on failure. No stack, no file, no duration. [C] Probe (vm stand-in, all 11 spotify test files): 114 cases, 0 failed, first result `{"name":"native Previous explicitly excludes listening-history Back and retains approval","ok":true}`, keys `["name","ok"]`, bundle 72 ms, run 62 ms, 0 duplicate test names. [T] (vm timing, not the Electron sandbox) [U]

Output the model sees (from the `plugin_test` branch in `workspace/index.ts`): [C]

```
All checks passed.            (or: Some checks failed.)
- pass: <name>
- FAIL: <name> (<error>)
Error: <r.error>              (only when the run itself failed)
```

`isError` is true when `!r.ok`.

- `plugin_test` lists a line for every passing test, so output grows with the suite (114 lines for spotify). There is no cap. [C] [I]
- If one test never finishes, the 30 s timeout rejects the whole run: `test()` catches it and returns `{ ok: false, results, error }` where `results` holds only the load-check result. The names and outcomes of the tests that already passed are lost. Error text: `Tests took longer than 30 seconds, so they were stopped.` [C]
- The registry is a global array (`globalThis.__custardTests`), so the whole bundle is one registry; test files do not know their own name. [C testing.ts]
- Under repo vitest, `src/plugin-sdk/plugin-tests.test.ts` runs every `plugin/*/tests/*.test.ts` by loading each file separately and registering its cases. That is a developer path, not available to the model. [C]
- Existing host test of the output: `host.test.ts` ("echo greets", "fails on purpose") expects `['Plugin loads and handles every tool in plugin.json', true], ['echo greets', true], ['fails on purpose', false]`. [T]

No filter by file or name, and no timings: [NB]

### Feasibility

Feasible and mostly mechanical. The bundler already takes a list of test files. [C]

### Effort: small to medium

Files touched: `src/main/workspace/index.ts` (input schema, parse, output lines), `src/main/plugins/host.ts` (`test(id, signal, filter?)`; choose files), `src/plugin-sdk/testing.ts` (`runRegisteredTests(filter?)` and timing), `src/main/plugins/runtime.ts` (call with the filter; copy `ms` through the result mapping, which today keeps only `name`, `ok`, `error`), `src/shared/plugins.ts` (`TestReport` adds `ms?`), `src/main/plugins/host.ts` `TestRunner` type, the test stand-ins in `host.test.ts` and `src/plugin-sdk/plugin-tests.test.ts`, docs `API.md` line 113 and `TESTING.md`. [I]

### What exactly would change (PROPOSAL, not built)

- Input: `{ file?: string, name?: string }`. [NB]
  - `file`: matched by exact equality against the list from `readSources` that already passes the `tests/*.test.ts` regex, so the model's string is never used as a path. Bundle only that file.
  - `name`: case-sensitive substring on the test name, applied inside `runRegisteredTests`. Report `No tests matched <name>.` as an error, not as "All checks passed" with zero results; today an empty suite also passes silently (`ok: results.every(...)` on the load check alone). [I]
- Timings: wrap each case with `Date.now()` before and after, return `ms`, print `- pass: <name> (12 ms)` and a total line. `performance.now()` precision in the sandbox window is [U]; Electron may coarsen timers. A per-test timeout (so one hanging test fails only itself) is a separate item and would need `Promise.race` inside the runner. [NB]
- Return partial results when the global timeout hits, by streaming or by having the runner post results as they finish. [NB]
- Cap the output (print failures in full, passes as a count or only names, with a flag for verbose). [NB]
- Keep the load check on every run (cheap) or skip it when a filter is given. [NB]

### Risks and security consequences

- No new reach: the test sandbox has "no bridge at all" (`runtime.ts` comment) and no network. A filter changes only which cases run. [C]
- `testing.ts` is not part of the build hash: `sourceHash` hashes `index.ts`, `runtime.ts` (and the widget files for widget plugins) from the SDK, not `testing.ts`. A change to `testing.ts` therefore does not make a new build ID for existing plugins, which is fine for tests (they are not shipped in the build). [C host.ts `sourceHash`]
- Test code is plugin code the model wrote, running in the sandbox window; the existing 30 s kill and `forcefullyCrashRenderer` path covers a busy loop. [C]

---

## 5. Reading the active (built/installed) plugin's source to diff against the workspace copy

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
- Builds are kept per source hash: `validate()` saves a build whenever the hash is new, active or not (staged). `pruneBuilds` is called only from `activate()`, keeping the new active and the previous one. So repeated `plugin_validate` runs on changed source accumulate builds in the app data folder until the next activation. [C host.ts lines 459-520, 721] [I] (no cap was found)

### Can the model read the installed copy today? No.

- `fs_*` tools: the workspace boundary is `{ root: <plugin source folder>, deny: [app.getPath('userData')] }`, and the store lives under `join(app.getPath('userData'), 'plugins')`. Probe: a symlink from the workspace to the store is refused with `Symbolic links and junctions are not followed.`; `../../userData/plugins/mine/state.json` is refused with `".." is not allowed in workspace paths.` [T] [C]
- `reference_read` / `reference_list` read only fixed virtual roots: `docs` (the `docs/plugins` folder), `sdk` (the SDK source) and `examples/spotify` (the spotify plugin's source folder, only offered when the plugin being developed is not spotify). Probe: `reference_list` → `docs/\nsdk/\nexamples/spotify/`; `reference_list examples` → `spotify/`; `reference_read examples/spotify/plugin.json` works; `reference_read builds/x` → `Not found in the reference material.`; a `..` path → `".." is not allowed in workspace paths.` [T]
  - `examples/spotify` is the live source folder, not the installed build. It shows the working tree, not what is activated. [C index.ts: `refs['examples/spotify'] = join(pluginsRoot(), 'spotify')`]
  - Other plugins in `plugin/` besides spotify are not readable by the model from another plugin's workspace. [C]
  - `reference_read` uses the same `read()` as `fs_read`: binary files refused, text over 200,000 characters truncated with `[truncated at 200000 characters]`. [C]
- The Settings review screen already computes the diff: `PluginHost.review(id)` calls `diffSources(store.buildSources(id, active.buildId), readSources(sourceDir))` and returns `files: FileChange[]` (`{ path, change: 'added'|'changed'|'removed', diff? }`), shown in `PluginsTab.tsx`. It is reachable by IPC `plugins:review` only. The model gets neither `review` nor `diffSources`; `devTools` has only `plugin_validate` and `plugin_test`. [C host.ts `review`, plugins/index.ts, workspace/index.ts]
- `review()` calls `validate()` first, which may save a staged build. A diff tool built on `review()` would carry that side effect. [C]

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
- `diffSources` output for a large change is unbounded text (a diff string per file); `lineDiff` returns `undefined` above 4,000,000 cells and the UI then prints "(too large to show)". A tool result needs its own cap. [C diff.ts] [I]

---

## 6. How a plugin enabled in Settings becomes callable in Code mode in the same chat

### Short answer

A chat can use a plugin enabled in Settings on its very next message. No new chat is needed for enabling, disabling or updating a plugin. A new chat is needed only to change workspace kind (General vs Plugins) or which Plugins workspace. [C] [T for the host half, see probe below] [U for a real model run]

### As built

- The tool list is built once per user message, not once per chat and not once per model round. `chat:send` calls `send(sender, req)` (`src/main/chat.ts` line 1083), and `send` builds the list once: [C]
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
  The same `tools` and `available` are used for every model round in that reply (the tool loop passes `tools` to each request, line 926), so a plugin enabled while a reply is already running is not offered until the next message. [C] [I]
- `toolSet(mode)` reads current state each call: for every id in the store, skip unless `st.enabled && st.active`; tools are `<id>__<tool>` with description `[<plugin name> plugin] <description>`. In `code` mode the per-mode "Chat design" opt-in is not required (`needsChatDesign = (mode) => mode !== 'code'`). [C host.ts lines 156, 881-910]
- Which Code chats get plugin tools at all: `modePolicy('code', workspace)` adds `'plugin'` and `'widget'` only when `workspace.kind === 'internal'`. A General Code chat never gets plugin tools. [C policy.ts] [T policy.test.ts lines 59-65: `general.tools.has('plugin')` is false, `internal.tools.has('plugin')` is true]
- The workspace is fixed per chat: `conversation.workspace = verifyWorkspace(req.workspace)` runs only when the conversation is new (`if (!existing && req.mode === 'code')`), the renderer passes `workspace` only for a new Code chat (`mode === 'code' && !current && workspace`), and the picker is shown as `fixed={current ? current.workspace : null}`. A General chat cannot become a Plugins chat, and a Plugins chat for plugin A stays on A (although it sees the tools of every enabled plugin, not just A). [C chat.ts line 273, ChatView.tsx lines 391 and 642]
- The system prompt is also rebuilt per message. Enabled plugins' `instructions.md` text goes in as `<plugin name="..." tools="<id>__*">`. The paragraph introducing the `<plugin>__<tool>` naming ("Plugins the user enabled add the tools named <plugin>__<tool>...") is added only `if (plugins.instructions.length)`, so a plugin with empty instructions would add tools with no explanatory paragraph. The scaffold writes a non-empty placeholder instructions file, so this only bites if it is emptied. [C chat.ts lines 366-373; scaffold.ts] [I]
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

## Defects and gaps collected (decisions for Neno)

1. `fs_write` is not atomic (plain `writeFileSync`); `vault_edit` writes atomically with `writeReplaceSync`. [C]
2. A leftover atomic-write temp file inside a plugin folder would be read as plugin source and change the build hash, because `readSources` filters only `isDeniedName` and symlinks. [T]
3. Two diff styles disagree on `-`/`+` order (`workspace/diff.ts` vs `plugins/diff.ts`). [T]
4. Approval card shows diffs uncoloured and unfolded in one grey `<pre>`. [C]
5. `plugin_validate` does not type-check; type errors pass validate, test and activation. [T]
6. `typescript` is a devDependency, so a packaged app cannot type-check without packaging changes. [C] [U]
7. `plugin_test` has no filter, no timings, no cap on output, and loses all passing results when the 30 s global timeout hits. [C]
8. An empty test suite reports "All checks passed." (load check alone). [C]
9. Each distinct `plugin_validate` stages a build in app data; `pruneBuilds` runs only on activation, and no cap was found. [C] [I]
10. The model cannot see the active build or any diff against it, though `review()`/`diffSources` already exist for Settings. [C]
11. The generic "Plugins the user enabled add the tools named..." paragraph in the system prompt depends on plugin instructions being non-empty. [C]
12. `chat.ts` `send` is not covered by any test, so the per-message tool list behaviour in item 6 rests on code reading. [U]

## Could not verify

- Behaviour in the real Electron sandbox, packaged builds, Windows and macOS.
- Whether `typescript` works from inside an asar archive.
- Whether SDK types compile without the DOM lib.
- Timer precision for per-test timings in the sandbox window.
- Any real model use of the tools above.
