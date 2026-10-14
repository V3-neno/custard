# Workstream A, Phase A2 review: built-in model profiles

Branch `model-profiles-a2`, draft PR into `claude/project-thread-e94hk0`, the A1 branch. Nothing is merged. This phase is a refactor only: requests, prices, limits, capabilities, labels and the picker all come out identical. Everything below was tested against local stand-ins only. Nothing was sent to a live provider.

## Where this differs from the A1 review (and why)

1. **`send` is one of Custard's five level names, not any string.** All built-in models fit. A string would need casts into both SDKs' types. Widening it is a small change, for when a provider needs other names, such as Qwen's `none`.
2. **New: `settingsLabel` on each effort level.** Settings → Default model shows "low effort" for Claude and OpenAI but "Fast" for DeepSeek. Your decision 5 keeps those labels exactly as they are, so each level carries its Settings label as data.
3. **`files` has an `imageTokens` rule** (`claude`, `claude-small` or `patches`), not `images: false | { tokens }`. PDF page estimates use the image rule even on models that refuse images, so the rule has to exist for every model.
4. **No `priceDatedIds` field.** The "dated id priced as its base" rule stays as it was in `pricing.ts`, for every model.
5. **Hosted search moved off the provider.** The Responses provider flag `responses.webSearch` is gone, and each profile's `search` replaces it. The A1 review didn't say so explicitly. It was the only way to make `webTools` read the profile without keeping two sources.
6. **DeepSeek's effort note in Settings** ("DeepSeek's model list also names effort levels…") was a `provider === 'deepseek'` branch. It is now the provider's `effortNote` data, with the same text.

## What changed

- **New `src/shared/models.ts`:** 8 profiles, in picker order. Each holds `id`, `provider`, `label`, `limits`, `compaction`, `prices`, `thinking`, `effort` (levels + `otherwise`, or `null`), `fallbacks`, `files`, `search` and `live`. The helpers are `profileOf`, `providerEffort`, `shownLevel`, `sentLevel` and `hasHostedSearch`. `Effort` and `efforts` now live here, and `chat.ts` re-exports them.
- **Derived tables:** `chatModels` (`chat.ts`), `CONTEXT_LIMITS` (`main/context.ts`) and `PRICES` (`pricing.ts`) are built from the profiles. Call sites didn't change.
- **Name and id branches now read the profile:**
  - `claudeSearchTool` reads `search` (it used id patterns).
  - `takesEffort` in `web/search.ts` reads `effort`.
  - `claudeTier` in `attachments/request.ts` and the per-provider `imageCount` read `files.imageTokens`.
  - `m !== 'deepseek-flash'` reads `files.images`. DeepSeek's PDF refusal now also checks `files.pdf`.
  - `deepseekEffort`, `deepseekEfforts` and the DeepSeek branches in `effortChoices`, `shownEffort`, `responses.ts` and `SettingsDialog.tsx` (three of them) are replaced by `shownLevel`/`sentLevel` over the profile's levels. No code names `'deepseek'` for effort now, and a unit test scans the source for it.
  - `LIVE` in `capabilities.ts` moved into each profile's `live`.
- **Claude adapter:** `thinking` turns adaptive thinking on, and `effort` sets `output_config` through `sentLevel`, which is the identity for Claude's levels. The keys are in the same order, so the request body is byte-identical.
- **`capabilitiesOf`:** same rules, reading the profile. Web search uses `hasHostedSearch`, the same check `webTools` uses. `capabilities.ts` no longer imports `web/`.
- **The circular import:** I read the code. There was no actual import cycle before. Phase 7 avoided one by leaving the search decision in `web/index.ts`. Now the decision lives in `shared/models.ts`, and `webTools`, `capabilities.ts`, `claudeSearchTool` and the Responses adapter all read it, so no cycle can form.
- **Docs:** `providers.md`, `adding-a-provider.md` and `usage.md` now point at profiles instead of the old tables and the removed names.

### Files touched

- **New:**
  - `src/shared/models.ts`
  - `src/main/modelProfiles.test.ts`
  - `src/main/modelTables.golden.test.ts`
  - `src/main/__golden__/*.json` (4 fixtures)
- **Changed:**
  - Shared: `src/shared/{chat,pricing,providers}.ts`
  - Main: `src/main/context.ts`, `src/main/adapters/{anthropic,capabilities,responses,template}.ts`, `src/main/attachments/request.ts`, `src/main/web/{index,search}.ts`
  - Renderer: `src/renderer/src/components/SettingsDialog.tsx`
  - Tests: `src/shared/{chat,providers}.test.ts`
  - Docs: `docs/{providers,adding-a-provider,usage}.md`

## Derived tables: before and after

Every value is the same before and after. `modelProfiles.test.ts` compares each table with a literal copy of the old one, taken from a8ec2e7.

| Model | Window / max out | Compaction | Prices in / cache write / cache read / out ($/M) | Effort | Thinking | Fallbacks | Images / PDF / image rule | Search | Live |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Opus 5.5 | 1M / 128K | yes | 4 / 5 / 0.2 / 20 | 5 levels | yes | yes | yes / yes / claude | 20260209 | none |
| Sonnet 5.5 | 1M / 128K | yes | 2 / 2.5 / 0.1 / 10 | 5 levels | yes | yes | yes / yes / claude | 20260209 | none |
| Haiku 4.5 | 200K / 64K | no | 1 / 1.25 / 0.1 / 5 | none | no | no | yes / yes / claude-small | 20250305 | none |
| GPT-6 Astra | 1.05M / 128K | yes | 10 / 10 / 1 / 50; over 270K: 20 / 20 / 2 / 75 | 5 levels | yes | no | yes / yes / patches | responses | none |
| GPT-6.1 Sol | 1.05M / 128K | yes | 2 / 2 / 0.1 / 10; over 270K: 4 / 4 / 0.2 / 15 | 5 levels | yes | no | yes / yes / patches | responses | none |
| GPT-6 Luna | 1.05M / 128K | yes | 0.1 / 0.1 / 0.01 / 0.5; over 270K: 0.2 / 0.2 / 0.02 / 0.75 | 5 levels | yes | no | yes / yes / patches | responses | none |
| DeepSeek V4 Pro | 1M / 384K | no | 1.32 / 1.32 / 0.044 / 3.96 | Fast/Balanced/Thorough = low/high/max, otherwise high | yes | no | no / no / patches | none | none |
| DeepSeek Flash | 1M / 384K | no | 0.3 / 0.3 / 0.006 / 1.2 | same as V4 Pro | yes | no | yes / no / patches | none | vision, json_schema |

**Effort labels:**
- Picker: Low, Medium, High, X-High, Max for Claude and OpenAI; Fast, Balanced, Thorough for DeepSeek.
- Settings: "low effort" … "max effort" for Claude and OpenAI; Fast, Balanced, Thorough for DeepSeek.

Both are unchanged.

## Goldens and tests against the baselines

**Before any code change** (base a8ec2e7 + the A1 docs commit, same app code):

- **e2e: 43 suites, 1,305 pass, 0 fail.** That's 10 more than the 1,295 in your brief: a8ec2e7 added 10 checks to `model-picker`, which now has 63.
- **Goldens:** Claude 48/48, Responses 64/64, automation and web-search requests 5/5, all identical.
- **New capability golden**, recorded as JSON fixtures in `src/main/__golden__/`:
  - `capabilitiesOf` and `modelInfo` for all 8 models, plus one unknown id (`deepseek-v5-preview`).
  - Every derived value: `chatModels`; limits, budget, compaction trigger and result cap; costs, including long-context and dated ids; search tool; `webTools`; file refusals; image and PDF token estimates; effort buttons and shown levels; summary and handoff models.
  - The Claude search call's tool and effort.
  - The Responses `reasoning.effort` on the wire, for each model and level.

**After the refactor:**

| Check | Base | A2 |
| --- | --- | --- |
| Unit tests | 1,222 pass | **1,236 pass**, 0 fail (+4 golden, +10 profile tests) |
| Capability and model-table goldens | recorded | **identical** (4/4) |
| e2e | 43 suites, 1,305 pass, 0 fail | **43 suites, 1,305 pass, 0 fail** (each suite the same count as before) |
| Claude golden | 48/48 | **48/48 identical** |
| Responses golden | 64/64 | **64/64 identical** |
| Automation and web-search requests | 5/5 | **5/5 identical** |
| `npm run typecheck` | clean | clean |
| `npx eslint src` | clean | clean |
| `npx prettier --check src` | clean | clean |

**Tests I changed:**

- `chat.test.ts`: two tests imported `deepseekEfforts` and `deepseekEffort`, which no longer exist. They now check the same values through `effortChoices('deepseek')` and `shownEffort('deepseek', …)`. Same count.
- `providers.test.ts`: the `responses` flag checks no longer expect `webSearch`, which moved to the profiles. `modelProfiles.test.ts` now checks the profiles' `search` against the old values.

**New unit tests (`modelProfiles.test.ts`):**

- Every built-in model has exactly one profile.
- The summary models, handoff models, default model and the fallback model (`chatModels[0]`) all resolve to a profile.
- `chatModels`, `CONTEXT_LIMITS` and `PRICES` equal the old tables.
- Search, image rules, thinking and live evidence equal what the code used to decide.
- `files` agrees with the attachment rules.
- A provider's models share their effort levels.
- DeepSeek's mapping comes from its profiles, and a made-up level set maps by data alone.
- Claude and OpenAI keep their labels.
- No source file branches on DeepSeek by name for effort.

## Things that surprised me

- **Hosted search was a provider flag for Responses providers but per model for Claude.** It is per model for everyone now.
- **The image rule is used for PDFs too.** That's why every profile has one, even DeepSeek V4 Pro, which takes no images.
- **The Settings effort labels differ from the picker's** ("low effort" against "Low"). They are kept as data, as you decided.
- **My first baseline run had 3 failures in `design-security`.** My test runner didn't start the stand-in that suite needs. Re-run correctly on the same build, it passed 43/43. The app was not at fault.

## Behaviour that differs only for ids with no profile (please confirm)

For the 8 built-in models, and for the unknown id in the golden, everything is identical. Some functions used to match ids **without a profile** by pattern, and now return the "no profile" answer:

- `claudeSearchTool` for `claude-fable-*`, `claude-mythos-*`, `claude-opus-4-6`… and similar: was a search tool, now none.
- Search effort for an unknown Claude id: was low effort, now none.
- An unknown OpenAI id: hosted search was on, now off.
- The image tier for a dated Haiku id such as `claude-haiku-4-5-2026…`: was the small tier, now the large one.

**I believe none of these can happen today.** A chat or automation only reaches these functions with a model that has a profile: `send()` replaces an unknown id with Opus 5.5 (the A3 issue), and automations stop on an unknown model. That is from reading the code, **not verified** by a test that tries every path. If you want, A3 can make an unknown id fail loudly in these functions too.

## What I chose not to do (out of scope, as you said)

The runtime registry, `ChatModel` as a string, `models.json`, the no-profile notice, the unknown-id fallback to Opus 5.5, the hard-wired Claude adapter, one key string per provider and the `runOpenAI` flags are all untouched. The A1 effort findings are left as they are too: no effort on Claude's one-shot calls, and none on automation steps.

## Not verified

- **No live provider calls in this phase.** Every request went to local stand-ins.
- Still unverified live from earlier phases: Claude accepting its own thinking blocks back after other providers' turns, OpenAI refusal parts in one-shot calls, DeepSeek's too-long wording.
- **Windows:** not tested. Everything ran on Linux under xvfb.
- **Chat turns on Sonnet and Haiku:** the Claude golden runs on Opus, so these turns aren't covered by a golden. Their effort and thinking flags are checked against the old values by unit tests only.
- **The renderer** (picker, Settings) is covered by the e2e suites (`model-picker`, `model-check`, `deepseek`). I didn't look at screenshots by eye.
