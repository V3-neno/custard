# Workstream A, Phase A3 review: runtime registry and the no-profile notice

## Base branch

**Chosen: `model-profiles-a2`, the branch of draft PR #53.** I branched `model-profiles-a3` from it, and a draft PR goes into it. Nothing is merged.

What the repository showed on 2026-10-14:

- `main` (a2c934b) holds the whole provider stack: #51 through #35. Its tree is identical to `claude/project-thread-q985ap`, the tip of a8ec2e7.
- **A1 (#52, `claude/project-thread-e94hk0`) and A2 (#53, `model-profiles-a2`) are still open drafts, not merged.** Neither commit is in `main`.
- So `model-profiles-a2` is the only branch with the A2 work, and it is the tip of the chain (main → A1 → A2). This matches what I expected, so nothing in the repo contradicted it.

## Where your brief and my earlier reviews differ

- **Seven renderer importers.** The list is right: ModelPicker, modelText, UsageMeter, ModelNotice, LongChat, Settings → Automations and SettingsDialog.
- **`models:list` isn't the registry.** It returns each model's `ModelInfo`: label, limits, prices and capabilities. It leaves out the effort levels, Settings labels and fallbacks that the picker and Settings need. Its only caller is Settings → Automations. I kept it and added `models:profiles`, which returns the profiles themselves.
- **A third silent fallback, found in the code.** `chatSettingsOf` (shared/chat.ts) moved a chat whose model it didn't know onto the **default model**, without a word. A unit test pinned that behaviour. This was in neither review, and I replaced it too (see the table below).
- **A fourth one.** "Continue in a new chat" picked its summary provider with `providerOf`. For an unknown id that returned Claude, so the chat would have been sent to Haiku 4.5 for the summary.

## What changed

- **Registry.**
  - `shared/models.ts` now holds a registry: `allProfiles`, `setProfiles`, `profileOf`, `hasProfile`, `requireProfile` and `NoProfileError`. The built-ins are `builtInProfiles`, the old `modelProfiles`.
  - Main builds the registry at startup in the new `main/modelRegistry.ts`, before any window opens. `loadModelRegistry(...sources)` takes extra profile sources, so A4 only has to pass the models file to it. Nothing reads a file today.
  - The renderer copies main's list over `models:profiles` before its first render (`renderer/src/models.ts`). If that read fails, the renderer keeps the built-ins, and main still checks every send.
- **Lookups follow the registry.**
  - `chatModels` is now a function, `chatModels()`.
  - `ChatModel` is a `string`, checked at run time with `isChatModel`, which is `hasProfile`.
  - `limitsFor`, prices (`costOf`), `providerEffort`, capabilities, `modelInfo` and `adapterForModel` all read the registry. `CONTEXT_LIMITS` and `PRICES` stay as views of the built-ins, for the tests that compare them with the old tables.
- **No silent fallback.**
  - `send()` refuses an id with no profile before it reads a key or touches the chat. The message is: "*id* can't be used right now: its profile is missing. Pick a different model."
  - The Claude adapter and `adapterForModel` throw `NoProfileError` instead of using Opus 5.5 or Claude.
  - `chatSettingsOf` keeps the chat's own model, even one with no profile.
  - Continue sends no summary request when the chat's model has no profile.
- **The notice.**
  - **In a chat:** the existing notice reads "*id* can't be used right now. Its profile is missing." with Pick a different model and Open Settings. It says nothing about keys or the provider, because the model has none. Send is disabled.
  - **In Settings → Default model:** the same sentence with Pick a different model, which focuses the model list. The list shows "*id* (no profile)" rather than pretending another model is picked.

### Files touched

- **New:**
  - `src/main/modelRegistry.ts` and `src/main/modelRegistry.test.ts`
  - `src/renderer/src/models.ts`
  - `test/e2e/model-profile.mjs`
  - `test/e2e/claude-turn-sonnet.mjs` and `claude-turn-haiku.mjs`, with their two golden files
- **Shared:**
  - `src/shared/models.ts`, `chat.ts` and `pricing.ts`
  - `src/shared/automations.ts` (a comment only)
- **Main:**
  - `src/main/chat.ts`, `continue.ts`, `context.ts` and `index.ts`
  - `src/main/adapters/{anthropic,capabilities,checks,common,registry,scan}.ts`
  - `src/main/automations/{model,run}.ts`
- **Preload:** `src/preload/index.ts`
- **Renderer:**
  - `main.tsx` and `SettingsDialog.tsx`
  - `chat/{ChatView,ModelNotice,ModelPicker,modelText,LongChat,UsageMeter}`
  - `settings/Automations.tsx`
- **Tests and docs:**
  - Tests: `chat`, `providers`, `capabilities`, `checks`, `registry`, `modelProfiles`, `modelTables.golden` and `automations/model`
  - `test/e2e/claude-turn.mjs`: it can run on another model
  - Docs: `docs/providers.md` and `docs/adding-a-provider.md`

## An id with no profile, at each entry point

| Entry point | Before A3 | After A3 |
| --- | --- | --- |
| Sending a message (`send`, chat.ts) | Sent to **Opus 5.5** without a word | Refused with the profile-missing message. No key is read, nothing is sent and no chat is made. |
| Claude adapter (`streamMessage`) | Sent as Opus 5.5 | Throws `NoProfileError` before any request |
| `adapterForModel` | Claude's adapter | Throws `NoProfileError` |
| Opening a chat whose model has none (`chatSettingsOf`) | Silently moved to the **default model** | Keeps its model and shows the notice. Send is disabled until another model is picked. |
| Stored default model (settings.json) | Not checked. New chats were sent to Opus 5.5 | Kept in the file, not replaced. Settings shows the notice, and new chats start on it with the chat notice. **My proposal; please confirm.** |
| Automations (`stepFor`) | Stop: "The model *id* isn't one Custard offers any more. Pick another." | The same, unchanged, now also when a profile is removed from the registry |
| Continue in a new chat (summary) | Summary sent to **Claude's Haiku 4.5**, because the provider fell back to Claude | Refused with the profile-missing message. "Continue without a summary" still works and sends nothing. |
| Memory captures, chat notes, chat summaries | Keyed by provider and run only after a turn that was sent | Unchanged and unreachable. They never see a model id with no profile. |

**The stored default, in short:** I didn't add a new rule. A default with no profile is left exactly as stored, so nothing changes behind your back. Settings and every new chat say so until you pick another model. Picking one in Settings or in the chat ends it. Tell me if you'd rather have something else, such as resetting it to Opus 5.5 with a visible note.

## The four A2 "no profile" functions: can an unknown id reach them?

**No, neither before A3 nor after it, so I left them as they are.** All four are reached only from inside a chat turn, with the turn's own model:

- **`claudeSearchTool` and the search effort (`takesEffort`):** only through `adapter.webSearch`, from `runWebTool` in `send()`.
- **The OpenAI hosted-search default:** the Responses adapter's `webSearch`, through the same path. Also `webTools(model)`, in the same turn.
- **The image tier (`imageRule`):** only through `prepareFiles` in the same turn.

Before A3 the turn's model was always a profile, because unknown ids had become Opus 5.5. After A3 the turn never starts for one, and the Claude adapter throws if it ever did. Making the four throw as well would change the unknown-id rows of the A2 goldens without protecting any path. I'll make them throw if you want.

**Haiku:** the profile id is `claude-haiku-4-5`, with no date. A dated id can't reach the image tier, because the image rule only ever sees the chat's model, which comes from the registry. Dated ids do appear as the model a reply came from (a fallback, say), but only the cost meter sees them, and it still prices them by their base id.

## Baselines and results

**Before any change**, measured on `model-profiles-a2`. The checks are the same as A2's, with no difference:

- **Unit tests:** 1,236 pass, 0 fail.
- **e2e:** 43 suites, 1,305 pass, 0 fail.
- **Claude golden:** 48/48. **Responses golden:** 64/64. **Request goldens:** 5/5. **A2 capability and model-table goldens:** 4/4.
- **Typecheck, eslint and prettier (src):** clean.
- **New, recorded on the base before the refactor:** the Claude turn golden on **Sonnet 5.5** and on **Haiku 4.5**, the same 12 scenarios as Opus. Each was picked as the default model in Settings. Separately, the Opus golden was still 48/48 identical with the edited script.

**After A3:**

| Check | Base | A3 |
| --- | --- | --- |
| Unit tests | 1,236 | **1,245 pass**, 0 fail. That is +7 registry tests, +1 automation test, and +1 chat test split out of one that changed (below). |
| e2e | 43 suites, 1,305 | **46 suites, 1,449 pass, 0 fail**: the 43 old suites with the same count each (1,305), plus Sonnet 61, Haiku 61 and `model-profile` 22 |
| Claude golden (Opus) | 48/48 | **48/48 identical** |
| Claude golden, Sonnet / Haiku | recorded | **48/48 identical each** |
| Responses golden | 64/64 | **64/64 identical** |
| Request goldens | 5/5 | **5/5 identical** |
| Capability and model-table goldens | 4/4 | **4/4 identical** |
| typecheck, eslint, prettier (src) | clean | clean |

**The new e2e suite `model-profile`** runs against a local Claude stand-in. It checks that:

- Main hands the renderer the 8 built-in profiles.
- A chat whose model loses its profile keeps the model, shows the notice and can't send.
- Open Settings opens Settings, and Pick a different model opens the picker. Picking Haiku carries the chat on with all of it.
- Settings shows the notice for a default model with no profile and doesn't rewrite the file. A new chat starts on that model with the notice, not on Opus 5.5.
- A send forced over IPC is refused in main, with nothing reaching the stand-in and no chat made.

**A test I changed:** `chat.test.ts` "unknown values are ignored" expected a chat with an unknown model to move to the default model. That is the silent switch you asked me to remove, so it now expects the chat to keep its model. A new test covers the same case when the chat's last request used a known model.

## Surprises

- The default-model and continue fallbacks above. Neither review had them.
- `models:list` is used only by Settings → Automations, and it carries no effort data.
- The renderer now waits for the registry before drawing. The wait is one IPC call. Every e2e suite still finds the window as before.

## What I chose not to do

- **Out of scope, as you said:** `models.json`, validation of user files, the Settings section for loaded or rejected entries, user-defined providers, the hard-wired Claude adapter, one key string per provider, `runOpenAI` flags, and the A1 effort findings.
- **Left unchanged because no path reaches them:** the four A2 functions (above). Also the Responses adapter's effort for an unknown id, which falls back to the provider's levels and is likewise reached only through the turn or the fixed summary models. And `limitsFor`'s 200K default.
- **Kept on purpose:**
  - `providerOf(unknown)` still returns Claude for the app's tint and labels. Nothing is sent through it now.
  - Design's capability report (`design/index.ts`) names Claude for a default model with no profile. It is display only.
  - Settings → Automations shows an automation's model as stored. A run with a missing profile stops with its existing message.

## Not verified

- **Everything ran against local stand-ins.** No live provider call was made in this phase.
- **Windows:** not tested. Everything ran on Linux under xvfb.
- I checked by eye only the screenshots of the two new notices.
- **Still unverified live from earlier phases:** Claude accepting its own thinking blocks back after other providers' turns, OpenAI refusal parts in one-shot calls, and DeepSeek's too-long wording.
