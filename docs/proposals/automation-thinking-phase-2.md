# Automations that think: Phase 2 review (the request path)

**Base branch: `automation-thinking` (4e342e6), the head of draft PR #56.** I checked the repo again on 2026-10-14 at 13:10 UTC and nothing has changed since Phase 1. `main` is still a2c934b. None of `claude/project-thread-e94hk0`, `model-profiles-a2`, `model-profiles-a3`, `model-profiles-a4` or `automation-thinking` is in `main`. The chain is unchanged: A1 → A2 → A3 → A4 → `automation-thinking`, with all PRs open drafts. `automation-thinking` is the tip and the only branch with both A4 and the Phase 1 file. This work is on `automation-thinking-p2`, in a draft PR into `automation-thinking`. Nothing was merged.

**Where your message and the Phase 1 review differ.** They differ in one place, and I followed your message:

- **Haiku 4.5's step limit.** Phase 1 said 64,000 is "below every built-in Claude maxOutput". It isn't: Haiku 4.5's maxOutput is exactly 64,000, so the limit is equal there, not below. I kept 64,000 as the cap. A model whose limit is lower than that (only possible through models.json) gets its own limit.

## 1. What changed

- `Automation` gains an optional `effort` (`shared/automations.ts`). `checkAutomation` keeps it only when it is one of `low`, `medium`, `high`, `xhigh` or `max`. Any other value is dropped, and the automation still loads. Old automations have no effort.
- `stepFor(model, effort)` (`automations/model.ts`) passes the effort to the adapter only when it is set. For Claude models it also asks for `min(64,000, the model's maxOutput)` tokens. `run.ts` calls `d.step(a.model, a.effort)`.
- Claude's `sendMessage` (`adapters/anthropic.ts`) now sends `thinking: {type: 'adaptive'}` when the profile says `thinking: true`. It sends `output_config.effort = sentLevel(profile.effort, effort)` only when the caller passes an effort and the profile takes effort. This works the same way on the streamed path (automation steps) and the plain path (summaries). On the plain path the effort is merged with a schema's `format`.
- The Responses adapter is unchanged. It already sends `reasoning.effort` through `sentLevel`; automations simply pass an effort to it now.
- Each run record gains optional `model` and `effort` fields, written when the run starts (`scheduler.ts`).
- In models.json, a customisation of `claude-haiku-4-5` that gives it `effort` is rejected (`modelsFile.ts`).
- Docs and comments are fixed: `docs/providers.md`, `docs/automations.md` (the model row, a new effort row, a new "Effort and thinking" section and the record fields), `docs/models-file.md` (the Haiku rule), and the comments in `adapters/types.ts` and `adapters/anthropic.ts`.

**Files touched:** `src/shared/automations.ts`, `src/main/automations/{model,run,scheduler}.ts`, `src/main/adapters/{anthropic,types}.ts`, `src/main/modelsFile.ts`, the three docs above, and `test/e2e/provider-requests.mjs` with its golden file. New tests are in `adapters/oneShot.test.ts` and `automations/docs.test.ts`. Tests were added to `automations/{model,run,scheduler}.test.ts` and `modelsFile.test.ts`.

## 2. Each request, before and after (from `provider-requests.golden.json`)

Each automation run below makes two steps: one with a `vault_list` call, then the end. Both steps change the same way.

| Case                                              | Before                                                      | After                                                                                   |
| ------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Claude Opus 5.5, effort not set                   | `model, max_tokens: 16000, system, messages, tools, stream` | `max_tokens: 64000` and `thinking: {type: "adaptive"}` added. **Nothing else changed.** |
| Claude Opus 5.5, effort `high` (new case)         | n/a                                                         | As above, plus `output_config: {effort: "high"}`                                        |
| Claude Haiku 4.5, effort `high` stored (new case) | n/a                                                         | `max_tokens: 64000` (Haiku's own limit), with **no `thinking` and no `output_config`**  |
| OpenAI GPT-6 Astra, effort not set                | `model, instructions, input, store, tools`                  | **Identical**, still with no output limit                                               |
| OpenAI, effort `xhigh` (new case)                 | n/a                                                         | `reasoning: {effort: "xhigh"}` added                                                    |
| DeepSeek Flash, effort not set                    | `model, instructions, input, store, tools`                  | **Identical**, still with no output limit                                               |
| DeepSeek, effort `medium` stored (new case)       | n/a                                                         | `reasoning: {effort: "high"}` (Balanced) added                                          |
| Web search, Claude and OpenAI                     |                                                             | **Identical**                                                                           |

These are the golden diff fields: `automation:claude.requests[0..1].body.max_tokens` goes from 16000 to 64000, and `.thinking` goes from absent to `{type: "adaptive"}`. Those are the only changes to existing keys. The four `automation-effort:*` keys are new. Compared with the matching no-effort case, each one differs only in `output_config` (Claude) or `reasoning` (OpenAI and DeepSeek). For Haiku the differences are the model name and the missing `thinking`. Headers did not change. The golden check now also fails on keys that are in the recording but not in the golden file (before, it only compared keys already in the golden file).

**The Claude chat request compared with the automation request.** Both send `thinking.type: adaptive` when the profile thinks and `sentLevel` for effort. These differences remain, all deliberate or out of scope:

- Chat adds `display: "summarized"` because it shows thinking. The step leaves `display` out, so it stays at the API's default of omitted.
- Chat always sends an effort. A step sends one only when it is set.
- Chat also sends `cache_control`, fallbacks and compaction. Steps don't (out of scope).

The `max_tokens` is now 64,000 in both.

**Can the two changes for "effort not set" change behaviour?** Per Anthropic's reference (not verified): Opus 5.5 and Sonnet 5.5 already run adaptive thinking when `thinking` is omitted, so sending it explicitly should change nothing for them. The model can't see `max_tokens`, so the 64,000 limit should only matter when a step would have passed 16,000 tokens. Before, such a step was cut off (or the run ended, if it was cut off while calling a tool). Now it can finish, and those extra tokens are billed. I don't see another way either change could alter behaviour, but neither is verified live.

## 3. The models.json Haiku rule

A customisation of `claude-haiku-4-5` is rejected if its `effort` is `true` or a levels object. The reason shown is: _Haiku 4.5 takes no effort level: Anthropic's API rejects one. Leave "effort" out._ An entry with `effort: false` or `null`, or one that changes only other fields, still loads.

**How Haiku 4.5 is identified:** by the id `claude-haiku-4-5` with provider `claude`. In models.json, that id with that provider is always the built-in or a customisation of it; a new model can't take the id, and another provider can't use it. No other field identifies the model. The same model added under a different id (for example a dated id) is not recognised and keeps whatever effort the file gives it. Nothing can be done about that.

## 4. Tests and baselines

All runs were on Linux, against local stand-ins only.

|                                                            | Base (4e342e6)                                                   | After                                     |
| ---------------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------- |
| Unit tests                                                 | 1,262 pass, 0 fail (79 files)                                    | **1,284 pass, 0 fail** (81 files): 22 new |
| Typecheck (node and web)                                   | clean                                                            | clean                                     |
| ESLint, `src` and `test`                                   | clean                                                            | clean                                     |
| ESLint, whole repo                                         | 545 problems, all in `plugin/spotify/` (left alone, as you said) | not changed                               |
| Unit goldens (`modelTables.golden`, `src/main/__golden__`) | pass                                                             | pass, unchanged                           |
| e2e                                                        | 47 suites, 1,450 checks, 0 fail (see note)                       | **47 suites, 1,480 checks, 0 fail**       |

The new tests cover:

- `checkAutomation` with each of the five levels, eight bad values and no value.
- The adapter request for each provider, with effort set and not set: Opus, Sonnet, Haiku with a stored effort, OpenAI, and DeepSeek `medium` sending `high`.
- The Claude summary request, whose body is checked field by field and is unchanged.
- The 64,000 step limit, its being at most every built-in Claude limit, and a lower-limit model getting its own limit.
- `run.ts` passing model and effort to the step.
- Run records with and without the new fields, and an old record loading unchanged.
- The Haiku rule, in rejected and accepted cases.
- The docs and comments no longer naming the 16,000 limit, "every request" or "the one-shot calls use Haiku".

**Note on the e2e baseline:** I count lines that start with ✓ or ✕. That gives 1,450 checks for the 47 suites, not the 1,476 the A4 review reported. Per-suite counts that I can compare (`models-file` 27, `model-profile` 22, and 61 each for the `claude-turn` suites) match. I couldn't find the A4 per-suite list to locate the 26-check difference, so I compare before and after with the same counter. On the first base run, one check failed in `media-sizes`: "the app window never stalled for a second (2,080 ms)", a timing check that ran while unit tests were also running. It passed (41/41) when run alone. A unit test also failed once while the e2e suite ran alongside it, and passed on the rerun; I didn't capture its name.

### 4a. e2e after

The suite counts are the same as on the base except `provider-requests`, which went from 21 to 51 checks:

- Each automation case now checks that its stored effort survives saving and that its run record has the model and effort. That adds 2 checks to each of the 3 old cases.
- The 4 new effort cases have 5 checks each, plus 1 golden check each.

Every other suite's count is identical. That includes the chat goldens (`claude-turn` and the Sonnet and Haiku variants at 61 each, `responses-turn`, `round-trip`, `provider-matrix`, `capabilities`, `model-picker`), so chat requests, prices, limits, capabilities, labels and the picker come out the same. The golden file was rewritten with `--update` once, after I checked the diff (section 2). The full run after that compared against it and passed.

## 5. A live check for you

This needs a Claude key and costs a few cents. It was not run here.

1. Build this branch on your machine. In the vault, make a skill `thinking-probe` whose SKILL.md says: "List the vault, read the newest note in Notes, then write three sentences about it." Create an automation on **Opus 5.5** that uses it, with no folders.
2. **No effort set:** note the month's Claude total in the cost meter, press **Run now**, and wait for the run to finish. Note the new total. Do this twice.
3. **Effort set:** the form can't set an effort yet. Close Custard and open `settings.json`, which is next to `models.json` (Settings → Models file shows that folder). In the automation's entry, add `"effort": "low"`. Open Custard, press **Run now** twice, and note the totals. Repeat with `"effort": "high"`.
4. **Compare:**
   - The cost per run at not set, low and high. If not set falls between low and high, that agrees with Opus 5.5 defaulting to medium.
   - The output tokens per run, from the Anthropic Console usage page for the key, filtered to Opus 5.5. If the output tokens are far above the length of the run's visible text, the model is thinking. If the output tokens rise from low to high, effort is reaching the model.
5. Optional: repeat step 2 on **Sonnet 5.5**, whose documented default effort is high.
6. Check the run record in `automation-runs/<id>.json`, in the same folder. It should hold `"model": "claude-opus-5-5"` and the effort for the runs from step 3.

## 6. What surprised me

- **Haiku 4.5's limit is exactly 64,000**, not above it (see the top of this file).
- **`thinking: true` on Haiku 4.5 is still allowed in models.json.** With this change, Claude summaries and Continue (which use Haiku) would then send `thinking: adaptive` to it. Anthropic's reference says Haiku 4.5 takes only budget-based thinking, so that request would probably be rejected. Before this change only a chat on a customised Haiku broke. I didn't build anything for this because it isn't in the brief. The same id rule would fix it if you want it.
- **The form keeps a stored effort when you edit an automation:** `save()` spreads the stored automation before the form fields (`Automations.tsx`). So an effort set by hand survives editing in the form. The e2e test checks that the effort survives the save IPC.

## 7. What I chose not to do

- Skipped slots (past the daily limit) get no `model` or `effort`. They aren't runs, and nothing is sent for them.
- No `display` on the step's thinking. Nobody reads it, and thinking blocks are still dropped between steps, as you decided.
- No form control, no run list display, no prompt caching or fallbacks for steps, no change to summaries or web search, nothing in `plugin/spotify`.

## 8. Not verified

- That Opus 5.5 and Sonnet 5.5 think in automation requests today or after this change, and at what effort when none is set.
- That the explicit `thinking: adaptive` and the 64,000 limit change nothing else on the real API.
- What thinking costs in a real run, at any level, on any provider.
- What OpenAI and DeepSeek do when no effort is sent.
- That stripping thinking between steps is always accepted on the real API. Nothing about that changed in this phase.
- Windows, and the packaged build.
