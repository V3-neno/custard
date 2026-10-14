# Workstream A, Phase A4 review: the models file

## Base branch

**Chosen: `model-profiles-a3`, the branch of draft PR #54 (6862b3f).** I branched `model-profiles-a4` from it, and a draft PR goes into it. Nothing is merged.

What the repository showed on 2026-10-14: `main` is still a2c934b. A1 (#52), A2 (#53) and A3 (#54) are open drafts, and none of their commits is in `main`. A4 needs A3's registry (`loadModelRegistry(...sources)`), so the tip of the chain, `model-profiles-a3`, is the only base that has it.

## Where your brief and the earlier reviews differ

- **Id length.** A1 said up to 100 characters. I used **80**, because automations already refuse a model id longer than 80 (`shared/automations.ts:86`). With 100, a file model with an 81-character id could be picked in chat but never saved in an automation.
- **Effort levels.** A1 only asked that `otherwise` be one of the levels. The code adds a second constraint: the picker shows one set of effort buttons per provider, and A2 pinned that a provider's models share their levels. So an `effort` object must be the provider's own levels. The simple form is `"effort": true`.
- **Workspace tools.** A1 cited `workspace/index.ts:59` for the deny on the data folder. It is still there, and it is the **only** workspace boundary today: General Code was removed, so the file tools exist only in the Internal plugin workspace (see "Who can write the file").
- **Starter profile.** A1 said it could be filled from "id, name, context, output". Your brief made it optional and said not to build it unless every field is read today. It isn't built (see "Chosen not to do").
- Everything else in the A1 validation list matches what was built.

## What changed

- **New: `src/main/modelsFile.ts`.** Reads and checks models.json, and returns the profiles and a report for Settings.
- **`src/main/modelRegistry.ts`.** `loadModelRegistry(...sources)` now uses its sources. A source profile with a built-in id replaces that built-in in place, so picker order stays. Any other is added after the built-ins.
- **`src/main/index.ts`.**
  - Reads `<userData>/models.json` at startup, before any window opens.
  - Two new handlers. `models:file` returns the last report. `models:reload` reads the file again, rebuilds the registry and returns the new list. It refuses while a chat or an automation is running.
- **Busy checks.** These are new small helpers: `anyChatBusy` (`chat.ts`), `automationRunning` (`automations/index.ts`) and `Scheduler.busy()`.
- **`src/shared/models.ts`.**
  - A profile can carry `origin` (`file` or `customised`) and `changed` (the fields a customisation changed).
  - New type `ModelsFileReport`.
- **`src/main/adapters/capabilities.ts`.** Cells the file decides are `docs`, with the note "From your models file." (see "Evidence").
- **`src/shared/pricing.ts`.** A model with a profile is priced from its profile only, so a profile with no prices is unpriced. Before, an unpriced file model whose id starts with a built-in id plus `-` (say `claude-haiku-4-5-test`) would have been priced as Haiku 4.5. Dated ids with no profile are still priced as their base model, as before.
- **Preload.** `models.file()` and `models.reload()`.
- **New: `src/renderer/src/components/settings/ModelsFile.tsx`, and `SettingsDialog.tsx`.**
  - A "Models file" section in Settings → General, after Default model.
  - Reload copies the new list into the renderer (`setProfiles`) and redraws Default model.
- **Docs.** New `docs/models-file.md` (format, fields, checks, failures). `providers.md` and `adding-a-provider.md` point to it.
- **Tests.**
  - New `src/main/modelsFile.test.ts`, 17 tests.
  - New e2e suite `test/e2e/models-file.mjs`, 27 checks.
  - One A3 test was changed: `chat.test` had expected the old silent move to the default model, and now expects the chat to keep its model.

## The file format

`models.json` in Electron's `userData` folder, next to `settings.json`. On Windows that should be `%APPDATA%\Custard` (not verified on Windows). Settings shows the exact path.

```json
{
  "version": 1,
  "models": [
    {
      "id": "deepseek-v5-preview",
      "provider": "deepseek",
      "label": "DeepSeek V5 Preview",
      "limits": { "window": 1000000, "maxOutput": 384000 },
      "prices": { "input": 1.5, "cacheWrite": 1.5, "cacheRead": 0.05, "output": 4.5 },
      "effort": true,
      "files": { "images": true }
    },
    {
      "id": "claude-haiku-4-5",
      "provider": "claude",
      "label": "Haiku 4.5 (cheap notes)",
      "limits": { "maxOutput": 32000 }
    }
  ]
}
```

- **The first entry adds a model.** It takes DeepSeek's three effort levels and images. It has no PDFs, search, compaction or thinking (it has no fallbacks either, since those are Claude only).
- **The second customises the built-in Haiku 4.5.** It changes the label and the output limit, and keeps everything else. Settings marks it "customised".

| Field | Required | Values | Left out (new model) |
| --- | --- | --- | --- |
| `id` | yes | 1 to 80 of `a-z 0-9 . _ : / -` | |
| `provider` | yes | `claude`, `openai`, `deepseek` | |
| `label` | new model | 1 to 60 characters | |
| `limits` | new model | `window` 1,000 to 10,000,000; `maxOutput` 1 to the window, whole numbers | |
| `prices` | no | `input`, `cacheWrite`, `cacheRead`, `output`, each 0 to 1,000 $/M; optional `long` (the same four plus `over`, whole tokens within the window); `null` = unpriced | unpriced |
| `effort` | no | `true` (the provider's levels), `false`/`null`, or `{ levels, otherwise }` equal to the provider's | none |
| `files` | no | `images`, `pdf` (true/false), `imageTokens` (`claude`/`claude-small` for Claude, `patches` otherwise) | text only |
| `search` | no | Claude `claude-20260209`/`claude-20250305`; OpenAI and DeepSeek `responses`; or `false` | off |
| `compaction`, `thinking` | no | true/false | off |
| `fallbacks` | no | true/false, Claude only | off |

The file can't hold a key, an address, a provider or code. There is no field for any of them, and an unknown field rejects the entry.

## Validation as built

The checks are in `checkEntry` and `parseModelsFile`. An entry is rejected for the **first** problem found.

- **Strict fields at every level.** These are checked in the entry, `limits`, `prices`, `prices.long`, `effort`, each effort level and `files`. An unknown field rejects the entry, for example `contextWindo`, `apiKey` or `baseURL`.
- **`live`** has its own message: "only tests Custard ran itself mark a capability live".
- **Required fields.** `id` and `provider` are always required. `label` and `limits` are required for a new model only, because a customisation inherits them.
- **Bounds:**
  - `window` is a whole number from 1,000 to 10,000,000.
  - `maxOutput` is a whole number from 1 up to the window.
  - Each rate is finite and between 0 and 1,000.
  - `long.over` is a whole number within the window.
  - `id` matches the pattern above.
  - `label` is 1 to 60 characters once trimmed.
  - Effort labels are 1 to 20 characters.
- **Effort.**
  - `value` and `send` must each be one of the five names: `low`, `medium`, `high`, `xhigh`, `max`.
  - `otherwise` must be the value of one of its levels.
  - The whole set must equal the provider's own. If it doesn't, the message lists the provider's levels and suggests `"effort": true`.
  - A provider with no effort levels, which is none today, would reject `true`.
- **`search` and `files.imageTokens`** must belong to the provider's API (Messages or Responses).
- **`fallbacks: true`** is accepted on Claude only.
- **Ids.**
  - An id that appears twice in the file rejects every entry with that id.
  - An id that is another provider's built-in model is rejected.
  - An id that is the same provider's built-in model is a customisation. The entry is laid over the built-in, and `limits`, `files`, `prices` and `prices.long` are merged field by field. The whole result is then checked like a new model, so a merge can't produce something a new entry couldn't.
- **The whole file.** It must be an object with `version: 1` and `models` as a list, with no other top-level field. It can hold at most 200 models and be at most 1 MB.

## Failure cases

| Case | What happens | Tested |
| --- | --- | --- |
| No file | Built-ins only. Settings: "No models file yet. Custard offers its built-in models." | unit, e2e |
| Empty file | Built-ins only. Status `empty`. | unit |
| Not JSON, not an object, wrong version, unknown top-level field, `models` not a list, over 200 models, over 1 MB, unreadable | **No entry loads.** Settings shows the reason. Built-ins are unaffected. | unit (each); e2e (bad JSON) |
| A bad entry | It is skipped and listed under "Not loaded" with its index, id and reason. The others load. | unit, e2e |
| A customisation that breaks a rule | It is rejected, and the built-in stays as it was. | unit |
| Something unexpected while checking one entry | That entry is skipped ("It couldn't be checked"), not the whole file. Nothing is thrown out of the reader. | not reachable from any input I found, so it has no test |
| Reload while a chat answers or an automation runs | Refused with "A chat or an automation is running. Reload when it has finished." The running turn keeps its model. | e2e (chat) |
| After Reload, a chat's model has gone or became invalid | A3's notice: "*id* can't be used right now. Its profile is missing." with Pick a different model. Main refuses a send forced from the page. | e2e |
| After Reload, the default model has gone | It stays stored, and Settings → Default model shows the notice (your decision 6). Default model is redrawn on Reload. | unit (A3); e2e redraw only |

## Who can write the file

I checked each path in the code that writes files for a model or a plugin.

- **Workspace `fs_` tools** exist only in the Internal plugin workspace. They are rooted at `plugin/<id>` and deny `userData` (`workspace/index.ts:59`, `paths.ts:89`, and `tools.ts:145` for search).
- **Vault tools** write only `.md` notes inside the vault: `resolveInVault`, with `mustBeNote` on by default, refuses `..`, absolute paths and hidden folders (`memory/paths.ts:79`).
- **Design** stores outputs under `<userData>/design/<chat>/<output>/…`. The chat and output ids are checked against an id pattern and file paths through `safeFilePath`, so it can't reach `<userData>/models.json`.
- **Plugins** run sandboxed and have no file access of their own.
- Automations act through the vault tools.

So only the user, outside Custard, writes models.json. This is checked by reading the code, not by an attack test.

## What protects you from a wrong profile

- **No key or address can come from the file.** Every field is on the whitelist above, and none of them is a key, a URL or a provider definition. A file model goes through its built-in provider's adapter, saved key and pinned address. The e2e test checks that a file DeepSeek model's request went to DeepSeek's stand-in address with its own id.
- **Prices and limits are bounded.** Silly values are rejected. A wrong but in-range window means the provider answers "too long" sooner or later than Custard expects, and that error is shown as today.
- **Capabilities can't be forged as tested.** `live` is refused, and cells the file decides are `docs`, noted "From your models file".
- **Request fields the provider doesn't support.** If the file turns on search, compaction, thinking or images for a model that lacks them, the provider is sent a field it may refuse. Custard shows the provider's error. Compaction already retries without it on refusal. Search must at least match the provider's API: DeepSeek with `responses` search would send OpenAI's tool to DeepSeek's own address, which would refuse it (not verified live).
- **The label is your own text.** It goes into the system prompt ("You are *label*"), so a misleading label only misleads the model about its name.
- **Nothing changes under a running turn.** Reload waits.

## Evidence

- A model the file adds has `docs` on every cell, with the note.
- **A customised built-in keeps its `live` evidence except where the file changed a field that decides that cell.** Images and PDF are decided by `files`, reasoning and reasoning summary by `thinking`, and the others by `effort`, `search`, `compaction` and `fallbacks`. Those cells become `docs` with the note. Changing only the label, limits or prices keeps every live cell, because none of them decides a capability.
- `changed` compares the merged value with the built-in's, so a field the file repeats unchanged keeps its evidence.

## Settings section

- **What it shows.**
  - The file's path.
  - A status line, for example "2 loaded, 2 not loaded."
  - "Loaded", with each model's label, id and provider, and "customised" where it applies.
  - "Not loaded", with the entry number, id and reason.
  - A Reload button.
- **The text says what the file can't do.** It explains that effort uses only Custard's five level names, and that the file can't add a provider, an address or a key.
- **Style.** It uses the existing Settings rows, buttons and text styles. There is no new dropdown.

## Tests against the baselines

| | Base (A3, measured on 6862b3f) | A4 |
| --- | --- | --- |
| Unit | 1,245 pass | **1,262 pass** (+17 in `modelsFile.test.ts`; 79 files) |
| e2e | 46 suites, 1,449 checks, 0 fail | **47 suites, 1,476 checks, 0 fail**: every old suite has the same count as on the base, plus `models-file` with 27 |
| Typecheck, eslint | clean | clean |
| Prettier (`src`, `test/e2e`) | 5 golden JSON files flagged | the same 5, unchanged; nothing new |

**Goldens.** No golden file changed (`git diff model-profiles-a3` on `*.golden.json` and `src/main/__golden__` is empty), and every suite that compares against them passed: Claude Opus, Sonnet and Haiku turns (48 golden checks each, 61 checks per suite), Responses (64 of 98), requests (5 of 21) and the four A2 unit goldens.

**With no models.json, is it identical to A3?** Yes, as far as the tests show. No old suite writes a models.json, so all 46 ran with no file and kept their counts, and the goldens are unchanged. In the code, with no file the registry gets no extra profiles; no built-in has `origin`, so capabilities are unchanged; and every built-in is priced, so the `priceOf` change gives the same prices. Nothing else had to differ.

## Surprises

- **The prefix pricing rule would have priced an unpriced file model.** An id such as `claude-haiku-4-5-test` with no prices would have been costed as Haiku 4.5. This is fixed in `priceOf`, and it changes nothing for the built-ins.
- **The effort buttons are per provider, not per model.** So a file model can't have its own effort levels. It either has its provider's levels or none.
- **The only workspace boundary left is the Internal plugin one.**

## Chosen not to do

- **"Copy a starter profile": not built.** The code reads only `id`, `display_name` or `name`, `context_window` and `max_output_tokens` from a provider's list (`parseModelList`, `adapters/common.ts`). It doesn't read DeepSeek's `input_modalities` or `effort`, so a starter profile would have to guess files and effort. Your brief says not to build it in that case.
- **Not done here:** widening `send`, user providers or addresses, adapter code, file watching, the hard-wired Claude adapter, one key string per provider, `runOpenAI` flags, the dropdown redesign, and the A1 effort findings.
- **No Reload queue.** A Reload refused while busy isn't retried later. You press it again.

## Not verified

- The real `userData` path on Windows, and the whole flow on Windows.
- Any live provider. Only the local stand-ins were used. In particular, it isn't verified what a provider does with a file model whose limits or capabilities are wrong.
- **Carried over from earlier phases:**
  - Claude accepting its own thinking blocks back after other providers' turns.
  - OpenAI refusal parts in one-shot calls.
  - DeepSeek's "too long" wording.
- Reload refused during an automation. The check is the same code as for a chat, but no e2e test starts an automation run for it.
