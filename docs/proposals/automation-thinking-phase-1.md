# Automations that think: Phase 1 review (investigation only)

**Base branch: `model-profiles-a4` (9d75982), the head of draft PR #55.** Nothing in the A1-A4 stack is merged: `main` is a2c934b (PR #35), and none of `claude/project-thread-e94hk0` (#52), `model-profiles-a2` (#53), `model-profiles-a3` (#54) or `model-profiles-a4` (#55) is an ancestor of it (`git merge-base --is-ancestor`). The four are a clean chain (each contains the one before), all four PRs are open drafts, and A4 is the tip. So the branch closest to the tip that has A4 is A4 itself. This review is on branch `automation-thinking`, in a draft PR into `model-profiles-a4`, and contains only this file (a copy is in the project folder as `custard/automations/thinking-phase-1-review.md`).

No code was changed. No live provider call was made.

## 1. What I read

- **In full:** `automations/model.ts`, `automations/run.ts`, `automations/index.ts`, `shared/automations.ts`, `adapters/anthropic.ts`, `adapters/responses.ts`, `adapters/types.ts`, `shared/models.ts`, `automations/records.ts` (load/save), `test/e2e/provider-requests.golden.json` (request bodies, read with a script).
- **In part:** `renderer/.../settings/Automations.tsx` (form, open, save, model select, run list), `store.ts` (config read/write), `openai.ts` (`toBlocks`, the turn request's `include`), `memory/summarize.ts` and `handoff.ts` (the `sendMessage` calls), `shared/providers.ts` (summary models, Responses flags), `docs/providers.md`, `docs/automations.md`.
- **Only grepped:** `scheduler.ts`, `context.ts`, `chatTool.ts`, `questions.ts`, `modelsFile.ts` (effort checks), `web/search.ts`, the skill hubs, `chat.ts`, the vault-template automation skill and its Resources note.
- **Claude API facts** (thinking defaults, effort defaults, replaying thinking blocks) come from Anthropic's API reference bundled with my tools, cached 2026-10-06. I did not check them live.

## 2. What happens today, per provider

Every automation step goes through `stepFor` (`automations/model.ts:22-55`), which calls `adapter.sendMessage` with `model, apiKey, system, messages, tools, stream: true, retries: 0, signal` (`model.ts:33-42`). **No `effort` and no `maxTokens` are passed, for any provider.** The recorded requests in `provider-requests.golden.json` confirm it: no `thinking`, no `output_config`, no `reasoning` in any automation request.

| | Claude (`anthropic.ts:171-231`) | OpenAI / DeepSeek (`responses.ts:61-114`) |
|---|---|---|
| Fields sent | `model, max_tokens: 16000, system, messages, tools`, streamed | `model, instructions, input, store: false, tools` |
| Effort | Never sent. The comment (`anthropic.ts:169`) assumes the only one-shot model is Haiku 4.5. | Sent as `reasoning.effort` only if `req.effort` is set, which automations never do |
| Thinking param | Never sent (only `streamMessage` sets it, `anthropic.ts:73`) | Nothing turns reasoning on or off; these models always reason |
| Output limit | 16,000 tokens, and it covers thinking plus text | None |
| Reasoning between steps | `run.ts:390-397` rebuilds each assistant turn from `text` + `tool_use` only, so any thinking block is dropped | `toBlocks` (`openai.ts:150-168`) keeps only messages and function calls; no `include: reasoning.encrypted_content` (the chat turn sends it, `openai.ts:204`), so reasoning is dropped |
| Run log | Thinking is never recorded or shown | Same |

### Where the background notes are wrong or incomplete

1. **"A Claude automation on Opus runs without thinking" is very likely wrong for the built-in models.** Per Anthropic's reference, Opus 5.5 and Sonnet 5.5 run adaptive thinking when `thinking` is omitted, and Opus 5.5 can't turn it off at all. So today a Claude automation on Opus 5.5 or Sonnet 5.5 probably *does* think, at the API's default effort (Opus 5.5: `medium`; Sonnet 5.5: `high`), with thinking text omitted from the reply. It is uncontrolled rather than off. A1's reading would be right for a Claude model where omission means no thinking (Opus 4.8/4.7, which a models.json entry could add). **Not verified live.**
2. **Haiku 4.5 can't think through Custard.** It needs `budget_tokens` thinking, which Custard never sends, and its profile says `thinking: false, effort: null` (`models.ts`). Correct as A1 said.
3. **"Claude's one-shot path never sends effort": correct** (`anthropic.ts:169-231`). `docs/providers.md:53` ("goes into every request (`streamMessage` and `sendMessage`)") is wrong for Claude's `sendMessage` and for automation steps on every provider. The type comment `types.ts:64` and `anthropic.ts:169` say the one-shot model is Haiku 4.5; automation steps break that.
4. **"Summaries pass `low`": correct** (`summarize.ts:161`, `handoff.ts:308`). For Claude it is dropped, which is harmless today because Claude's summary model is Haiku 4.5 (`providers.ts:52`). OpenAI (Luna) and DeepSeek (Flash) summaries do send `low`.
5. **OpenAI and DeepSeek automations already reason**, at whatever the provider uses when no effort is sent. I could not find that default in the repo for GPT-6 Astra/Sol/Luna; DeepSeek's sizing notes say thinking is on by default. **Not verified.**
6. Not in the notes: the Claude automation request also sets no prompt caching and no server-side fallback (chat sets both, `anthropic.ts:69,75-80`). A decline ends the run. I'm noting it, not proposing to change it.

## 3. Thinking for Claude in a run, and what it would take

- **On or off:** for Opus 5.5 and Sonnet 5.5 the only real control is effort. Sending `thinking: {type: 'adaptive'}` explicitly when the profile says `thinking: true` changes nothing for them, but makes a models.json Claude model (e.g. Opus 4.8) think too. Recommended.
- **Effort:** send `output_config.effort = sentLevel(profile.effort, automation.effort)` when the profile takes effort, exactly as chat does (`anthropic.ts:74`). Haiku 4.5 gets none.
- **Output limit:** 16,000 tokens is a cap on thinking plus text. At `high` and above a step can hit it. A step cut off while calling a tool ends the run (`model.ts:51-52`); with text only it ends early (`CUT_OFF_REASON`). Chat uses 64,000 (`anthropic.ts:66`), and the request is already streamed. Raising the step limit to 64,000 (below every built-in Claude `maxOutput`) costs nothing by itself: you pay for tokens used, not the limit.
- **Thinking blocks between steps:** today they are stripped from every assistant turn. Anthropic's reference says to pass them back unchanged within the same model's conversation, and that removing them "can trigger ordering/signature 400s"; it also gives stripping *every* thinking block as the accepted recovery path. So today's requests should be accepted (the golden mock can't tell), but the model loses its reasoning between tool steps. Keeping them means `StepResult` carries the raw assistant blocks for Claude, and `run.ts` pushes those instead of rebuilding. Replayed blocks probably count as input on later steps (inferred from "dropped blocks aren't billed"). **Not verified.**
- **Display and the run log:** a run has nobody watching, so `display: omitted` (the default) is enough. If you want reasoning in the run log, `display: summarized` plus a capped `thinking` excerpt in the record would do it. I'd leave this out of the first build.

## 4. Where the setting lives

- **Definition:** `Automation` in `shared/automations.ts:18-39`; cleaned by `checkAutomation` (`:77-132`) and `normalizeAutomations` (`:134-145`).
- **Storage:** `automations` in the app settings file, through `store.ts` (`readConfig` `:186`, `setAutomations` `:237-238`).
- **Creation and editing UI:** one form for both in `settings/Automations.tsx` (`Form` `:36-48`, `open` `:115-139`, `save` `:145-170`, model select `:370-389`).
- **Save:** IPC `automations:save` (`automations/index.ts:133-158`).
- **Scheduler and run:** `scheduler.ts` reads times, days, zone, limits and enabled; it never reads the model. The model is read by `run.ts:186` (`d.step(a.model)`), `run.ts:132` (the system prompt) and `run.ts:457` (`capResult`).
- **Run log:** `RunRecord` (`shared/automations.ts:151-176`), stored per automation by `records.ts`.

**Proposed field:** `effort?: Effort` on `Automation`, optional. `checkAutomation` keeps it only if it is one of the five values; anything else is dropped (not repaired). Existing automations have none.

## 5. Effort choices per model

- **Show the model's levels from its profile**, under the model select: the same labels as the picker (Low…Max for Claude and OpenAI, Fast/Balanced/Thorough for DeepSeek), from `profile.effort.levels`.
- **A model with no effort (Haiku 4.5):** show the control greyed out with "Haiku 4.5 takes no effort level", as the picker does, and save no `effort`.
- **Model changed in the form:** show the stored level as `shownLevel(newSpec, stored)` (e.g. a stored `medium` shows as Balanced on DeepSeek) so the user sees what will be sent, and save that value. Switching to Haiku clears it.
- **Profile changes in models.json:** at run time the step sends `sentLevel(profile.effort, stored)`, so a level the profile no longer lists goes as its `otherwise`, the same rule as chats. If the profile now takes no effort, none is sent. Nothing is rewritten in the stored automation.
- **Profile gone:** the run already fails before any call: "The model X isn't one Custard offers any more. Pick another." (`model.ts:24`). The stored effort is kept for when the profile returns. (That sentence differs from A3's "its profile is missing" wording; small, separate.)
- **One risk to know:** models.json can give Haiku 4.5 `"effort": true` (Claude's own levels), and Haiku 4.5 rejects effort per Anthropic's reference. Once Claude's `sendMessage` sends effort, a customised Haiku would break Claude summaries too (they pass `low`). Today it already breaks chats on that model. Options: refuse `effort` for Haiku 4.5 in models.json, or accept the risk. I'd refuse it.

## 6. The default when none is set

Prices are from the profiles (dollars per million output tokens; thinking is billed as output).

| Option | What existing automations get | What it means in cost |
|---|---|---|
| **A. None (today)** | Nothing sent: Opus 5.5 `medium`, Sonnet 5.5 `high` (API defaults), OpenAI/DeepSeek their own defaults | No change from today, but you can't see what it is |
| **B. A fixed level (e.g. Medium)** | Medium for all; DeepSeek shows Balanced (`high`) | Opus 5.5: same as today. Sonnet 5.5: likely cheaper (`high` → `medium`). OpenAI/DeepSeek: unknown change, as their default isn't known |
| **C. The profile's own default** | There isn't one in the profile. `otherwise` (Claude/OpenAI `medium`, DeepSeek `high`) is a fallback, not the provider's default, so this is B in practice | As B |

**Recommendation:** existing automations stay at A (no field, no behaviour change, no migration), shown in the form as "Not set (the provider's default)". The creation form pre-selects the model's `otherwise` level (Medium, or Balanced on DeepSeek) and saves it, so every new automation has an explicit level, as you decided. Editing an old automation saves whatever the form shows, so it gets a level then.

## 7. Cost of thinking per scheduled run

What I can compute: the price of thinking tokens. What I can't: how many tokens a model thinks at a level for a given skill, which depends on the model and the skill and isn't measured anywhere in the repo.

| Model | Output $/M | Per 1,000 thinking tokens | × 720 runs a month (24 a day, the default cap) |
|---|---|---|---|
| Opus 5.5 | 20 | $0.020 | $14.40 |
| Sonnet 5.5 | 10 | $0.010 | $7.20 |
| Haiku 4.5 | n/a (doesn't think here) | | |
| GPT-6 Astra | 50 (75 past 270K input) | $0.050 | $36.00 |
| GPT-6.1 Sol | 10 (15) | $0.010 | $7.20 |
| GPT-6 Luna | 0.5 (0.75) | $0.0005 | $0.36 |
| DeepSeek V4 Pro | 3.96 (peak) | $0.0040 | $2.85 |
| DeepSeek Flash | 1.2 (peak) | $0.0012 | $0.86 |

Read the last column as "for every 1,000 thinking tokens a run uses". A run is several steps (one per tool round), each thinking again. The cap is up to 96 runs a day. If thinking blocks are passed back (section 3), each later step also pays for them as input ($4/M on Opus 5.5, uncached on this path; inferred). The cost meter already counts thinking, because it is inside the provider's output count (`claudeParts`, `fromOpenAI`).

## 8. Summaries and Claude's one-shot path

- **Claude's `sendMessage`: change it in the same work.** Automation steps go through it, so effort can't reach a Claude run without it. Send effort only when the profile takes effort. Summaries are unaffected: their Claude model is Haiku 4.5, which takes none (unless customised, section 5).
- **Summaries: leave as they are.** `low` is right for them, and changing the summary model or level is a separate decision.
- **Web search** already sends `low` per profile (`web/search.ts:71,97,180`). No change.

## 9. Skills, run log and docs

- **Run log:** I'd add optional `model` and `effort` to each `RunRecord`, so a run says what it ran with even after the automation is edited. `loadRuns` keeps run objects whole (`records.ts:29`), so older builds keep the fields.
- **Docs to fix:** `docs/providers.md:13,53` (the 16,000 limit, "every request"), `docs/automations.md:13` (the model row says "Claude or OpenAI"; DeepSeek too, and add effort), comments at `types.ts:64` and `anthropic.ts:169`.
- **Skills:** the `automation-skill-authoring` skill doesn't mention model or effort; no change needed. Its Resources note ("Custard Automation Skill Authoring") is pinned to commit 4261aed; one line on effort and the output limit would be enough, done when that note is next refreshed.
- **Golden requests:** `provider-requests.golden.json` will change (automation requests gain `thinking`, `output_config` and a larger `max_tokens` for Claude, `reasoning` for the others). That diff is the check that only the intended fields moved.

## 10. Every reader and writer of an automation's stored data

| Who | Reads | Writes |
|---|---|---|
| `shared/automations.ts` `checkAutomation`, `normalizeAutomations` | every field | rebuilds the object field by field |
| `store.ts` `readConfig` (`:186`), `writeConfig` (`:192-195`), `get/setAutomations` (`:236-238`) | the list | the whole list, normalized |
| `automations/index.ts` save, delete, setEnabled, list, runNow (`:120-184`) | all | all (save, setEnabled, delete) |
| `scheduler.ts` | times, days, timezone, limits, enabled | nothing in settings; run records and state via `records.ts` |
| `context.ts`, `schedule.ts` | times, days, timezone | nothing |
| `run.ts`, `model.ts` | model, skill, folders, plugins, limits, name, id | run records only |
| `questions.ts`, `chatTool.ts`, `chat.ts` | id, name (question records) | question records |
| Renderer: `settings/Automations.tsx` | all | sends the whole object to save |
| Renderer: `SkillsHub.tsx`, `SkillWorkspace.tsx`, `SkillPanel.tsx` | skill, name, enabled | nothing |
| Tests: `run.test.ts`, `scheduler.test.ts`, `model.test.ts`, `schedule.test.ts`, e2e `automations`, `catchup`, `hostile`, `questions`, `provider-requests` | build automations | n/a |

**Older builds:** a new `effort` field survives being *read* by an older build, but **not a save**. `writeConfig` replaces the `automations` key with the older build's normalized list, and its `checkAutomation` doesn't know `effort`, so any settings save in an older build (even the budget) silently drops every automation's effort. They then run as "not set" (option A). That is safe (no wrong level is sent), just lost. Fixing it would mean keeping unknown fields in `checkAutomation`, which goes against "whole entries only". I'd accept the loss.

## 11. Proposed design and phases

1. **Phase 2, Claude and the shared path:** `effort?` on `Automation`; `stepFor` passes it; Claude's `sendMessage` sends `thinking: adaptive` when the profile thinks and `output_config.effort` when it takes effort; step `maxTokens` 64,000; the golden updated; docs and comments fixed. Unit tests for `checkAutomation` and the request.
2. **Phase 3, the form:** the effort control in the create/edit form (levels from the profile, greyed for Haiku, re-mapped on model change, "Not set" for old ones); `model` and `effort` in each run record and shown in the run list; e2e for create, edit, model change and an old automation.
3. **Phase 4, optional:** keep Claude thinking blocks between steps (and encrypted reasoning for OpenAI); the Haiku models.json rule. Needs your call on cost.
4. **Live check on your machine:** one Opus 5.5 run with a tool call at Medium and one at High, reading the usage, to replace "inferred" with numbers.

## 12. Risks

- Higher spend per run at `high` and above, multiplied by the schedule. The form should say levels above Medium cost more.
- Cut-off steps at high effort if the 16,000 limit stays.
- Effort lost when an older build saves settings (section 10).
- Customised Haiku with effort breaking summaries once Claude's `sendMessage` sends effort (section 5).
- Dropping thinking between steps is accepted per the reference but untested here; keeping it changes requests and cost.

## 13. Baselines on `model-profiles-a4` (9d75982)

Container set up with `npm ci --ignore-scripts`, then `node node_modules/electron/install.js`.

- **Unit tests:** 1,262 pass, 0 fail (79 files). Same as A4's review.
- **Typecheck:** `npm run typecheck` (node and web) passes, 0 errors.
- **ESLint:** `src` and `test` are clean (0 problems). `npx eslint .` over the whole repo reports 545 problems (14 errors, 531 prettier warnings), **all in `plugin/spotify/`** (its tests and `widget-support.ts`: missing return types and formatting). A4's review said "clean"; it probably linted the app only. Not touched here.
- e2e not run (not asked; A4's review has 47 suites / 1,476 / 0).

## 14. Not verified

- That Opus 5.5 and Sonnet 5.5 think in today's automation requests, and at which effort (from Anthropic's reference, not seen).
- What OpenAI's GPT-6 models and DeepSeek use when no effort is sent.
- That requests with all thinking blocks stripped are always accepted on Opus 5.5 / Sonnet 5.5 in a tool loop.
- Whether replayed thinking blocks are billed as input, and how many thinking tokens any level uses for a real skill.
- How the 16,000 limit behaves at high effort in a real run.
- Anything on Windows.
