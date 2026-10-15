# Workstream A, Phase 1: one profile per model (investigation)

Investigation only. No app code changed. Branch `claude/project-thread-e94hk0`, draft PR into `claude/project-thread-q985ap`. The PR holds only a copy of this file.

**Where the base is.** Your message calls the base "PR #36". PR #36 is actually "Automations: scheduled skill runs (Step 2)", which was merged into `note-editing` today. `claude/project-thread-q985ap` is the branch of **PR #51** (provider adapters, phases 1-8), merged into #48's branch today at a8ec2e7. That commit has the same tree as `note-editing` (6f2924c). I branched from `claude/project-thread-q985ap` as you asked. Nothing is merged, and nothing goes into main.

## What I read

- Reviews: `adapter-plan.md` and phases 1, 2, 3, 4, 5, 5b, 6, 7 and 8. Docs: `docs/adding-a-provider.md` and `docs/providers.md` (registry design, wrinkles, readiness).
- Code, read in full: `shared/providers.ts`, `shared/chat.ts`, `shared/pricing.ts`, `shared/adapter.ts`, `main/context.ts`, `main/adapters/{capabilities,common,registry,responses,anthropic,checks}.ts`, `main/providers.ts`, `main/endpoints.ts`, `main/apiKey.ts`.
- Code, read in part: `attachments/request.ts` (lines 1-140), `web/search.ts` and `web/index.ts` (the search choice), `compaction.ts`, `openai.ts` (the request), `chat.ts` (`send`, system prompt), `store.ts` (settings), `automations/{model,run}.ts`, `adapters/scan.ts` (columns), `design/capabilities.ts`, `Orb.tsx`, `SettingsDialog.tsx` (Default model, provider sections).
- Found by grep, not read line by line: every other importer of `chatModels`, `ChatModel` and the per-provider tables.

## The real list of a model's facts

The brief says four files. The code has model facts in **six** files, plus DeepSeek effort branches in two more.

| Fact | Where today | Keyed by | Read by |
| --- | --- | --- | --- |
| id, label, provider | `shared/chat.ts` `chatModels` | model | everything |
| Takes effort (yes/no). For Claude this also turns thinking on | `chatModels[].effort` | model | `anthropic.ts:71`, `responses.ts:32`, picker, capabilities |
| Effort names and what is sent | `deepseekEfforts`, `deepseekEffort`, `effortChoices`, `shownEffort` in `shared/chat.ts`; `responses.ts:33`; `SettingsDialog.tsx:223-251` | provider, by the name `'deepseek'` | picker, Settings, requests |
| Server-side fallback | `chatModels[].fallbacks` | model | `anthropic.ts:75`, capabilities |
| Context window, max output, compaction | `main/context.ts` `CONTEXT_LIMITS`. A missing id silently gets 200K / 64K / no compaction | model | budget, compaction, Claude's image and PDF limits, capabilities |
| Smallest compaction trigger | `context.ts` `MIN_TRIGGER` | provider | compaction |
| Prices, including long-context rates | `shared/pricing.ts` `PRICES`. Dated ids are priced as their base id by prefix | model | usage meter, `priced` |
| Images and PDFs accepted | `attachments/request.ts` `PROVIDER_LIMITS.refuses`: per provider, with `m !== 'deepseek-flash'` inside | provider + one id | attachments, capabilities |
| Image and PDF page limits | same file, from the context window for Claude | provider | attachments |
| How image tokens are counted | `request.ts:91` `claudeTier`: id prefix `claude-haiku-4-5` | id pattern | estimates |
| Hosted search, and which tool version | `web/search.ts:53` `claudeSearchTool` (id patterns) for Claude; `responses.webSearch` flag for Responses providers | id pattern / provider | `webTools`, capabilities, adapters |
| Effort on the search call | `web/search.ts:67` `takesEffort` (`/^claude-haiku/`), a copy of `chatModels.effort` | id pattern | Claude search |
| Reasoning summaries, encrypted reasoning, token counting | `shared/providers.ts` `responses` flags | provider | `openai.ts`, capabilities |
| Seen working live | `adapters/capabilities.ts` `LIVE` | model | matrix evidence |
| Summary model | `providers[].summaryModel` | provider, names a model | captures, chat notes, Continue |
| Default model | `defaultChatSettings` in `shared/chat.ts` | global | new chats |
| How the model is introduced | label + `providers[].maker` | provider | system prompts |
| Design's "can the chat return images" | `design/capabilities.ts` `CHAT_IMAGE_OUTPUT` | provider | Design |
| Orb colours, theme | `Orb.tsx` `RAMPS`, `main.css` | provider | renderer |

Not model facts, so they stay where they are: Claude's fixed `max_tokens` (64,000 per turn, 16,000 one-shot), compaction turned down at runtime (session state), and Design's image models (`design/images/models.ts`, a separate list, out of scope).

## Where the docs and the code disagree (I trust the code)

1. **"Four files."** Six, as above. `web/search.ts` and `adapters/capabilities.ts` aren't in the readiness list.
2. **`providers.md`: "The chat's effort goes into every request (`streamMessage` and `sendMessage`)."** Claude's `sendMessage` never sends effort (`anthropic.ts:168-200`; its comment assumes Haiku). Automation steps pass no effort for any provider (`automations/model.ts:28-37`). Summaries pass `low` (`summarize.ts:161`, `handoff.ts:308`). So a Claude automation on Opus runs without thinking. I'm reporting this, not changing it.
3. **An unknown model id falls back to Opus 5.5, silently.** The docs mention `adapterForModel` falling back to Claude. They don't say that `send()` in `chat.ts:247` uses `chatModels[0]` (Opus 5.5) for any unknown id, and so does `anthropic.ts:59`. The stored default model isn't validated either (`store.ts:180`). With fixed models this almost never happens. Once you can remove a profile it would, and it would send to Opus without saying so.
4. **Your list of facts** has "image and PDF support" as model facts. Today they are per-provider functions with a model id inside, not data.

## Proposed design

### One profile per built-in model, in one file

A new `src/shared/models.ts` holds one entry per model. Only per-model facts go in it; provider facts stay in `providers.ts`.

```ts
type ModelProfile = {
  id: string                       // unique across all providers
  provider: Provider
  label: string
  limits: { window: number; maxOutput: number }
  compaction: boolean
  prices: Price | null             // null: unpriced, as the meter already handles
  priceDatedIds?: boolean          // "claude-opus-5-5-20261001" priced as the base id
  thinking: boolean                // Claude: adaptive thinking on. Responses models always reason
  effort: null | {
    levels: { value: Effort; label: string; send: string }[]   // buttons, stored value, wire value
    otherwise: Effort              // any other stored level shows and sends as this one
  }
  fallbacks: boolean               // Claude only
  files: {
    images: false | { tokens: 'claude' | 'claude-small' | 'patches' }
    pdf: boolean
  }
  search: false | 'claude-20260209' | 'claude-20250305' | 'responses'
  live?: Capability[]              // built-in profiles only
}
```

- **DeepSeek effort as data:** `levels` = Fast/low/low, Balanced/high/high, Thorough/max/max, `otherwise: 'high'`. Claude and OpenAI list all five levels with their current labels. `effortChoices`, `shownEffort`, `deepseekEffort`, `responses.ts`'s branch and the three `SettingsDialog` branches all read the profile. No code names `'deepseek'` for effort any more. `send` is a string, so Qwen-style names (`none`, `minimal`) fit later.
- **The old tables stay as derived views.** `chatModels`, `CONTEXT_LIMITS` and `PRICES` are built from the profiles, so most call sites don't change. The id patterns (`claudeSearchTool`, `takesEffort`, `claudeTier`) and `m !== 'deepseek-flash'` are replaced by profile fields.
- **Attachment refusal sentences** stay per provider, so their wording doesn't change. Only "does this model take images" comes from the profile.
- **"Not yet supported" becomes supported** by adding one profile entry. The capabilities, the picker, the meter, limits, files and search all follow from it.

### Settings → Capabilities stays local and correct

`capabilitiesOf` keeps its rules, which are code. They read the profile instead of four tables: vision from `files.images`, PDFs from `files.pdf`, effort from `effort`, web search from `search`, compaction from `compaction`, fallbacks from `fallbacks`, and evidence from `live`. Requests are built from the same profile, so the matrix and a real request can't disagree.

**Guard:** before the refactor, record a capability golden: `capabilitiesOf` and `modelInfo` for all 8 models as JSON. It must be identical after, as with the request goldens.

This also takes care of "search is wired in two places". `webTools` reads `profile.search` from `shared`, so the circular import between the adapters and `capabilities.ts` (Phase 7) goes away. The adapters still run the search.

### User-added models and adapters: proposal and trade-offs

**Where the file lives:** `models.json` in Custard's data folder (next to `settings.json`), **not** in the vault. A profile decides prices and which key and address a model's requests use. Chats and automations can write to the vault (in allowed folders), and it syncs. The workspace file tools are already denied the data folder (`workspace/index.ts:59`).

```json
{ "version": 1, "models": [ { "id": "deepseek-v5-preview", "provider": "deepseek", "label": "DeepSeek V5 Preview", "limits": { "window": 1000000, "maxOutput": 384000 } } ] }
```

| Option | What it allows | For | Against |
| --- | --- | --- | --- |
| **1. Models for built-in providers (recommended)** | New model ids, and changes to built-in ones, for Claude, OpenAI or DeepSeek | Uses that provider's adapter, key and pinned address. No new code paths and no new place a key can go. Covers "not yet supported" models. | No new providers |
| 2. Also user providers (Responses API only) | A provider entry with a name, a base URL and a key | Qwen-style providers without a release | Breaks the pinned-address rule: a key and your chats go to an address typed in a file. Needs a key file per user provider, and defaults for theme, orb, compaction trigger and attachment rules. `Provider` stops being a fixed type, so TypeScript no longer lists missing tables. |
| 3. User adapter code (a `.js` file) | Any API | Anything is possible | Runs in the main process with every key, the vault and the disk. A plugin can't do it either: the sandbox can't stream a chat turn or hold a key today. Not recommended. |

**Validation (option 1):**

- **Required:** `id`, `provider`, `label`, `limits`.
- **Optional, with safe defaults:** no prices = unpriced (the meter says so, as today); no effort = none; no files = text only; search, compaction, thinking and fallbacks = off.
- **Strict:** unknown fields reject the entry, so a typo like `contextWindo` can't be ignored silently.
- **Bounds:** window 1,000 to 10,000,000; maxOutput no more than the window; prices finite and 0 to 1,000; id `[a-z0-9._:/-]`, up to 100 characters; label up to 60.
- **Rules:**
  - Effort `otherwise` must be one of its levels.
  - `search` must match the provider's API.
  - `fallbacks` only on Claude.
  - `live` is not allowed: a user profile's cells are `docs`, with the note "From your models file".
- **Duplicates:** an id used twice in the file rejects both entries. An id that is another provider's built-in model is rejected. An id that is the same provider's built-in model is a customisation: the fields are merged, then the whole entry is checked again.
- **Bad file** (unreadable, not JSON, unknown version): no user entry loads, the built-ins are unaffected, and Settings shows the reason. **Bad entry:** that entry is skipped and listed in Settings with the reason, and the others load. An entry is never half-loaded. Nothing crashes.
- **When it is read:** at startup, and when you press Reload in Settings. There is no file watching, in line with "nothing in the background".

**A model with no profile:**

- A model the provider lists without a profile stays unpickable, as you decided on 2026-10-13. Settings can offer "Copy a starter profile", filled from the provider's own list (id, name, context, output), for you to check and paste.
- **A chat or default model whose profile has gone** (removed, or now invalid) should show the "can't be used now" notice with a new reason ("its profile is missing") and Pick a different model. It should never fall back to Opus silently. Automations already stop with "isn't one Custard offers any more" (`automations/model.ts:23`). **This is a behaviour change** (point 3 above) and needs your OK.

**What this costs in the code:** `ChatModel` becomes a string checked at runtime, not a fixed list. Seven renderer components import `chatModels` directly (picker, Settings, Automations, usage meter, notice, long chat, model text). They would read the list from main over IPC (`models:list` already exists). A unit test pins that built-in references (summary models, default model) resolve to a profile.

### The other weak points: fix now or leave

| Weak point | Recommendation | Why |
| --- | --- | --- |
| DeepSeek effort names in code | **Fix in A** | It is the effort data itself |
| `claudeSearchTool` and `takesEffort` id patterns | **Fix in A** | They become profile fields. A new Claude model (e.g. `claude-opus-6`) would otherwise get no search. |
| Unknown id falling back to Claude/Opus | **Fix in A, if you approve** | It becomes dangerous once profiles can be removed |
| Hard-wired Claude adapter | **Leave** | It only matters for a second Anthropic-API provider (Bedrock, Vertex). It refactors Claude's path and changes nothing you can see. Profiles don't depend on it. |
| One key string per provider | **Leave** | It touches key storage, encryption, IPC and Settings, and needs its own security review. It only matters for Bedrock or Qwen regions. |
| `runOpenAI` flags | **Leave** | No new Responses quirk is in sight |

## Implementation phases, if you approve

- **A2: built-in profiles.** One file, with the old tables derived from it. Effort, search, image tier and live evidence come from profiles, and the name branches go. No behaviour change. The new capability golden plus every existing baseline must stay identical.
- **A3: runtime registry.** Main owns the list, and the renderer reads it over IPC. `ChatModel` becomes a string. The "no profile" notice comes in here, only if you approve it.
- **A4: `models.json`.** Validation, plus a Settings section listing loaded and rejected entries with Reload. Only with the options you pick.

## Risks

- A2 moves values that requests are built from (effort, thinking, search tool, fallbacks). The Claude and Responses goldens, the request golden and the new capability golden should catch any change.
- Turning ids into strings (A3) loses TypeScript's check that a referenced model exists. Tests have to cover it instead.
- A wrong user profile:
  - Wrong prices give a wrong cost estimate.
  - A window that's too big turns off the "too long" guard; the provider then refuses, and Custard shows "too long".
  - A file flag a model lacks gives a provider error when sending.
  - None of these sends data anywhere new under option 1.

## Decisions for you

1. **What the file may add:** models for built-in providers only (recommended), or user providers with an address too.
2. **Customising built-in models from the file** (prices, limits): allowed, shown as "customised" (recommended), or new ids only.
3. **Evidence for user facts:** `docs`, with a "from your models file" note (recommended), or a new third tag.
4. **A chat on a model with no profile:** block it with a notice (recommended), or keep today's silent fallback to Opus 5.5.
5. **Default effort labels in Settings** read "low effort" for Claude but "Fast" for DeepSeek. Taking every label from the profile would change that visible text. I'd keep it as it is in A2 and change it only if you want.

## Tests run for this phase

No app code changed, so the e2e suites and goldens weren't re-run. I ran these on the base branch (a8ec2e7):

- **Unit tests: 1,222 pass, 0 fail** (75 files). That's 2 more than the 1,220 baseline in your message. The last commit on the base, a8ec2e7 ("Effort buttons for Claude and OpenAI in the model picker"), came after the Phase 8 count and added 2 tests to `shared/chat.test.ts`. **From now on the unit baseline is 1,222.**
- The same commit also added checks to the `model-picker` and `deepseek` e2e suites. So the e2e baseline is probably above 1,295 too. Not measured. I'll record it before A2 changes anything.
- `npm run typecheck`: clean. `npx eslint src`: clean.
- The first unit run failed 3 files because Electron's binary wasn't installed in this container. After `node node_modules/electron/install.js`, all 75 files passed. This was a setup problem, not a code problem.

## Not verified

- Nothing was sent to any provider in this phase.
- The exact data folder path on Windows (it is Electron's `userData`).
- Whether DeepSeek's live model-list fields (`input_modalities`, `effort`) are reliable enough to fill a starter profile. You saw them once on 2026-10-13. Custard doesn't read them.
- That nothing besides the workspace tools can write to the data folder. I checked `workspace/index.ts`, not every tool.
- Renderer components found by grep were not each read in full.
- Still unverified live from earlier phases: Claude accepting its own thinking back after other providers' turns, OpenAI refusal parts in one-shot calls, DeepSeek's too-long wording, Windows.
