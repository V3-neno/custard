# Providers

Custard talks to each provider through one of two APIs: Anthropic's Messages API (Claude) or the OpenAI Responses API (OpenAI, DeepSeek). Each provider is one entry in `src/shared/providers.ts`; its adapter is in `src/main/adapters/registry.ts`, its key file in `src/main/providers.ts` and its address in `src/main/endpoints.ts`. Its models are in `src/shared/chat.ts`, its prices in `src/shared/pricing.ts` and its context limits in `src/main/context.ts`. TypeScript flags the other tables that need an entry: attachment rules (`attachments/request.ts`), Design's chat-output note (`design/capabilities.ts`), the orb colours (`Orb.tsx`) and the context minimum (`MIN_TRIGGER`). The theme is a `data-provider` block in `src/renderer/src/assets/main.css`, which TypeScript can't check.

To add a provider, follow [adding-a-provider.md](adding-a-provider.md): the steps in order, a template adapter (`src/main/adapters/template.ts`) and walkthroughs for Qwen and Claude on Amazon Bedrock.

A packaged build always sends a provider's requests to its official address. A development build leaves Claude and OpenAI to `ANTHROPIC_BASE_URL` and `OPENAI_BASE_URL`. DeepSeek uses its own `DEEPSEEK_BASE_URL` or its official address, never OpenAI's.

## Adapters

Each provider has an adapter in `src/main/adapters/` (the interface is in `types.ts`, the registry in `registry.ts`). Claude uses `anthropic.ts`. OpenAI and DeepSeek share `responses.ts`, which reads each provider's flags from `src/shared/providers.ts`. Everything that calls a model goes through the adapter: chat turns (`streamMessage`), one-shot calls (`sendMessage`: captures, chat notes, Continue in a new chat, automation steps) and web searches (`webSearch`). Vault tools, plugins, approvals and the chat guard sit above it and never ask which provider is answering.

- **Automation steps** (`automations/model.ts`) are one `sendMessage` call each, with the run's tools and no retries. Claude waits for the reply over a stream with a 16,000-token limit; a Responses provider sends one plain request with no limit. These are the requests the steps sent before they moved (`test/e2e/provider-requests.mjs` compares them). What a reply means for the run is the same for every provider: declined, too long, or the provider couldn't finish ends the run with the reason; cut off while calling a tool ends it without running the call; cut off with text only keeps the text, and the run log says it ended early at the output limit.
- **Web search** (`web/search.ts`) runs in a call of its own holding only the query: Claude's hosted search tool for Claude, OpenAI's `web_search` for OpenAI. DeepSeek has no hosted search, so its adapter answers that search isn't available; it is never offered the `web_search` tool, and the capability matrix says so. Whether a model has search is still decided in one place (`webTools`, from the provider's profile and `claudeSearchTool`), which both the tool list and the matrix read.
- **A declined one-shot call.** OpenAI and DeepSeek decline with a refusal part; `sendMessage` reports it as `refused`, as it does for Claude's refusal stop, so a refusal is never kept as a summary or a step's answer. Memory captures, chat notes (and their titles) and Continue all go through two summarizers (`memory/summarize.ts`, `handoff.ts`) that throw on `refused`, `cut-off`, `too-long` and `failed`; each caller treats the throw as "no summary" and writes nothing. In a chat, a refusal part is the model's own words and is shown as its reply; Claude's refusal has no words, so Custard shows a notice.

What a model can do (`getCapabilities`, in `capabilities.ts`) is read from the same rules a request is built from, so it can't promise what a chat would refuse. Each answer is marked `docs` or `live`, and only a test recorded on a known model counts as `live`.

### Key checks and model lists

Settings checks a key only when you press Save or Refresh, never at startup or in the background. The check is one request: the provider's own model list, sent to its pinned address with that provider's key only (`src/main/adapters/checks.ts`).

| Provider | Request (checked 2026-10-13)                                                                               |
| -------- | ---------------------------------------------------------------------------------------------------------- |
| Claude   | `GET /v1/models` with `x-api-key`, every page (at most 5 of 1,000)                                         |
| OpenAI   | `GET /v1/models` with `Authorization: Bearer`                                                              |
| DeepSeek | `GET https://api.deepseek.com/models` with `Authorization: Bearer` (api-docs.deepseek.com/api/list-models) |

- A rejected key (401) says so and stays saved, so you can replace it. Anything else (no connection, a timeout, a server error, a list Custard can't read) says it couldn't check, and the saved key isn't touched.
- Each of Custard's models is marked as usable with the key or not. Claude's and OpenAI's lists stay fixed.
- DeepSeek's profile has `discoverModels` on. A model DeepSeek lists that Custard has no profile for appears in Settings as "not yet supported". It never appears in the picker, because Custard has no prices, context limits or file rules for it.
- The last result is kept in `model-checks.json` in Custard's data folder. It holds model ids and the outcome, never a key, and is deleted when you remove the key.
- No key reaches an error message, a log line or the window. Text that looks like a key (`sk-…`, including a provider's masked echo) is replaced with "[key hidden]".

### Capabilities in Settings

Settings → Capabilities shows what each provider can do, built by `src/main/adapters/scan.ts` from local files only. Opening the tab and its Refresh button ask no provider and no model.

- **Matrix.** Rows are the capabilities in `src/shared/adapter.ts`; columns are the providers, or each model with By model. Every cell comes from `capabilitiesOf`, so it follows the same rules a chat's request is built from. A provider is supported when any of its models is, and the note names the models when not all are ("DeepSeek Flash only"). Green is supported, red is not supported, and grey is unknown. Unknown is used only for a model a provider lists that Custard has no rules for, taken from the last key check.
- **Evidence.** Each cell is tagged `docs` or `live`. A model is `live` only where a test on that model was recorded (`LIVE` in `capabilities.ts`). A provider is `live` only when every model that has the capability was tested live. Otherwise it is `docs`, and the note names the live model.
- **Inventory.** The scan lists Custard's vault, earlier-chat and web tools; every installed plugin's tools and whether the plugin is on; each skill in `Custard/Skills` with the tools its SKILL.md names; and the features that need a capability (Continue, chat notes, attachments and others).
- **Recommendations.** For each capability some of a provider's models lack, the scan names an installed plugin whose manifest declares it can fill that gap (`fills`, see [plugins/MANIFEST.md](plugins/MANIFEST.md)). If there is none, it says no plugin is available yet. Only web search, PDFs and images can be filled by a plugin; the other capabilities are part of the model. The scan never installs, turns on or changes a plugin.
- **Start building.** Every gap without a plugin has a Start building button, fillable or not. It makes a new plugin the same way New plugin does (`plugin/<id>`, with the usual sample) and opens its workspace in Plugins mode with a starter prompt in the message box, not sent. The prompt comes from the `plugin-discovery` skill (`Custard/Skills/plugin-discovery/SKILL.md`): one section per capability, filled in by `src/main/plugins/discovery.ts` without a model. The vault's copy is used when its section is usable, otherwise the copy bundled with Custard. The button is checked against a fresh scan, so it can't build for a gap that a plugin already fills or that the provider doesn't have.
- **Not built yet (Phase 4b).** An optional "ask the model" probe. It will run only when you press Refresh, sit beside the local answer, flag any disagreement, and never replace the local answer.

### A model per chat

Each chat keeps its own model and effort (`model` and `effort` on the saved chat). The picker under the message box shows the chat's model; it opens a panel with a tab per provider and that provider's models, and for DeepSeek the effort buttons Fast, Balanced and Thorough. Picking in an open chat saves the new model on the chat and the next message goes to it; picking on a new chat's start page applies to that chat only. Picking a model or an effort sends nothing to any provider.

- **Default model.** Settings → General → Default model is what a new chat starts on. Changing it changes no existing chat. Continue and Handoff start the new chat on the model of the one they carry on.
- **Older chats.** A chat saved before this keeps the model its last request used (`context.model`), or the default if it has none.
- **Can't be used now.** Worked out from what Custard already knows, with no request: no key saved for the provider (`no-key`), the last Save/Refresh check had the key rejected (`rejected`), or the last successful check didn't list the model as usable with this key (`removed`). A check that couldn't reach the provider changes nothing. The chat then shows a notice above the message box with Pick a different model, and nothing can be sent until another model is picked. The picker greys such models out with the reason. With no keys at all, the notice points to Settings.
- **Effort.** The chat's effort goes into every request (`streamMessage` and `sendMessage`). A model that takes none (Haiku 4.5) gets none, without a notice.
- **Providers in Settings.** After a successful check, each provider's section lists Available models; a model the key can't use is struck through with "Your key can't use this model".

### Switching provider in a chat

Chats are stored in one format, Anthropic's message blocks, and each adapter converts to and from it on every request. So a chat started with one provider can go on with another, and nothing about the stored chat changes when you switch.

When the history goes to a provider other than the one that wrote it:

- Blocks only the original provider can read are dropped: Claude's thinking (and redacted thinking), Claude's fallback markers, and compaction blocks of either provider. Reasoning from a Responses provider is never stored, so it never reaches another provider.
- Everything else is kept. Text stays text, and tool calls and their results become the other API's function calls and outputs.
- A tool call to a tool this chat isn't offered now is sent as plain text (`history.ts`).
- Attached files are sent again in the new provider's form, or refused with a note when it can't take them (a PDF to DeepSeek, say).

A provider-neutral stored format was kept as a possible cleanup if the round-trip test showed problems. The test (`test/e2e/round-trip.mjs`: Claude, then DeepSeek, then OpenAI, then Claude, with tool calls) showed none against stand-ins, so it isn't built. Claude's thinking being accepted back after other providers' turns is untested live.

## Registry design

### How providers are found

There is no discovery at runtime. A provider exists because it has an entry in `providers` (`src/shared/providers.ts`); `Provider` is that object's keys, and `providerIds` its order (the picker's and Settings' order). Every table keyed by provider is a `Record<Provider, …>`, so a new entry fails the typecheck until it has an adapter (`registry.ts`), a key file, an address, attachment rules, Design's note, orb colours and a context minimum.

- `adapterFor(provider)`: the adapter for a provider.
- `adapterForModel(model)`: looks the model up in `chatModels` by id; an unknown id falls back to Claude.
- `allModels()`: every provider's own models, from `listModels(null)`. No request, no key.

Plugins can't add providers, and Settings can't add an address.

### How availability is worked out

`availabilityFrom` in `adapters/checks.ts`, for each model in `chatModels`, from two local facts only (no request):

1. Is a key saved for its provider? No: `no-key`.
2. What did the last Save/Refresh check say (`model-checks.json`)? Key rejected (401/403): `rejected`. A successful list without this model: `removed`. Couldn't reach the provider, or never checked: available.

The chat picker, the chat's "can't be used now" notice and the Automations picker read this one answer through `models:availability`. Settings' Available models list reads the last check directly.

### What is central and what is per provider

| Central (never asks which provider)                                                       | Per provider                                                                          |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| The chat turn's frame: approvals, chat guard, tool running, saving (`chat.ts`, `turn.ts`) | Building the request and reading the reply (`streamMessage`, `sendMessage`)           |
| The model picker, availability and the "can't be used now" notice                         | The key check request and model list shape (`listModels`, `authenticate`)             |
| Settings → Capabilities: matrix, inventory, recommendations (`scan.ts`)                   | The rules capabilities are read from: profile flags, attachment rules, context limits |
| Settings' key sections, Default model, Available models                                   | Key file name, pinned address, key hint text                                          |
| Automations: the picker, the run loop and the run log (`automations/run.ts`)              | Each step's request (`sendMessage` with tools)                                        |
| Summaries: evidence, schemas, what gets written (`memory/`, `handoff.ts`, `chatNotes.ts`) | The summary model (`summaryModel`) and structured output on the wire                  |
| Whether search is offered (`webTools`) and the search tool's results to the model         | Running the search (`webSearch`)                                                      |
| The stored chat format and `history.ts` (tool calls a chat can't use become text)         | Converting that format to the provider's input and back                               |
| Cost meter and usage log (`usage.ts`)                                                     | Reading the provider's usage (`claudeParts`, `fromOpenAI`) and its prices             |

## Known wrinkles

Stated plainly so nobody has to rediscover them.

- **Search is wired in two places.** `webTools` (`web/index.ts`) decides whether a model gets `web_search` at all (from the Responses `webSearch` flag, or `claudeSearchTool`, which matches Claude model ids by pattern). The adapter's `webSearch()` runs it. A provider with hosted search needs both. Moving the decision into the adapters would make `capabilities.ts` (which imports `webTools`) and the adapters import each other.
- **Chats are stored in Anthropic's block format.** Every other provider is a conversion on each request (`toInput`/`toBlocks` in `openai.ts`). A new Anthropic block type needs a decision in every converter; a provider-specific item (OpenAI's encrypted reasoning, DeepSeek's reasoning text) is never stored, so it can't reach another provider, and is only passed back within a turn.
- **DeepSeek's effort names map to low/high/max.** The picker's Fast, Balanced and Thorough send `reasoning.effort` low, high and max (Neno's call, 2026-10-13). The branch is by name in three places: `responses.ts` (`effortFor`), `ModelPicker.tsx` and `SettingsDialog.tsx`.
- **The Claude adapter is hard-wired to `claude`.** Its id, its key check and `anthropicEndpoint()` say `claude`. A second Anthropic-API provider (Bedrock, Vertex) means making it take an id and a client first.
- **One key string per provider.** `apiKey.ts`, the key IPC, Settings and `OneShotRequest.apiKey` all hold one string. Providers that need a region, an account or a key pair don't fit without changing that.
- **Errors are classified for two SDKs.** `errorKind` and `isContextError` know the Anthropic and OpenAI SDKs' error classes and messages. Another SDK's errors come out as `unknown`. Each provider's too-long wording is a guess until seen.
- **Key hiding by shape covers `sk-…` only.** The exact key is always removed where the caller passes it; other shapes need a pattern added to `hideKey`.
- **Model ids are global.** `chatModels`, `PRICES`, `CONTEXT_LIMITS` and `capabilitiesOf` are keyed by id alone, and a model's facts are spread over four files.
- **Claude's streamed one-shot call drops `schema`.** `sendMessage` with `stream: true` (automation steps) sends no `output_config`. Nothing calls it with both today.
- **Unverified live**, as of 2026-10-14 (everything else was tested against local stand-ins):
  - Claude's thinking blocks accepted back after other providers' turns in one chat, and DeepSeek accepting history converted from Claude.
  - OpenAI's refusal parts in one-shot calls (`refused` in summaries and automation steps).
  - The automation step and web-search requests after they moved onto the adapters (identical to before against stand-ins).
  - The automation run log's cut-off line on a real cut-off.
  - DeepSeek's too-long wording and image token counting (see DeepSeek below).
  - Windows, for all of the above.

## Readiness

**Is the pattern solid enough to maintain?** Yes, for providers that speak the Responses API or Anthropic's Messages API from Anthropic. Adding DeepSeek needed a profile, tables and three name branches for effort, and the typecheck listed every table. The behaviour is pinned by golden records (Claude 48 checks, Responses 64, automation and search requests 5), a round trip through all three providers and a skills-and-plugins matrix, so a refactor that changes a request shows up as a diff.

**Weak points.**

1. The stored format is Anthropic's, so every other provider depends on two converters staying in step with Anthropic's block types.
2. Provider names still appear in code: DeepSeek's effort (three places), Claude's adapter and address, `providerOf` falling back to Claude, and `claudeSearchTool`'s id patterns.
3. A model's facts are spread over `chat.ts`, `pricing.ts`, `context.ts` and `attachments/request.ts`, held together by tests rather than by one type.
4. `runOpenAI` (`openai.ts`) serves two providers through flags; each quirk of a third adds a flag there.
5. Credentials are one string.

**What a new provider breaks first.**

1. The key check, if its model list isn't `GET /models` returning `{ data: [{ id }] }` at the same base address.
2. Error classification: a rejected key that doesn't come back as the SDK's 401 class shows "couldn't check" instead of "rejected", and a too-long error isn't recognised.
3. History conversion edge cases on its first multi-turn chat with tools (tool call id formats, whether it wants its reasoning back).
4. Effort, if its level names aren't OpenAI's.

**With more time.**

- One model profile per model (provider, label, effort levels and labels, prices, limits, file rules) instead of four tables, and effort mapping as profile data rather than name branches.
- "Has hosted search" as a pure function in the profile layer, read by both `webTools` and the adapters, so search lives in one place.
- Credentials as a per-provider shape (key, or key plus region, or an AWS profile), stored the same encrypted way.
- An adapter conformance suite: the golden scenarios as one harness each adapter runs against its stand-in, instead of one script per API.
- A provider-neutral stored format, only if a provider appears that can't be converted cleanly from Anthropic's blocks.

## DeepSeek

Checked against api-docs.deepseek.com on 2026-10-12 (the overview, Models & Pricing, Create Response, the Responses API guide, Thinking Mode and Tool Calls pages).

|                      | DeepSeek in Custard                                                                                                                                                                                                                                                                |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Models               | DeepSeek V4 Pro (`deepseek-v4-pro`) and DeepSeek Flash (`deepseek-flash`). Both have a 1M context and up to 384K output.                                                                                                                                                           |
| Address              | `https://api.deepseek.com/responses`, with the DeepSeek key from Settings.                                                                                                                                                                                                         |
| Tools                | Function tools, as for OpenAI.                                                                                                                                                                                                                                                     |
| Thinking             | DeepSeek has no reasoning summaries. It streams its reasoning text as it goes, and Custard shows that. Within a turn, the reasoning is passed back with each tool result.                                                                                                          |
| Effort               | The picker's Fast, Balanced and Thorough send `reasoning.effort` low, high and max: the values the Create Response docs list (Neno's call, 2026-10-13). Any other level is sent as high.                                                                                           |
| Effort in its list   | DeepSeek's model list also names effort levels per model (`fast`, `balanced`, `thorough`; seen in Neno's live check on 2026-10-13). Its docs say these are for `reasoning_effort` on Chat Completions, which Custard doesn't use. Custard doesn't read them yet; Settings says so. |
| Web search           | None. DeepSeek chats get `web_read` only, and the model is told search isn't available.                                                                                                                                                                                            |
| Files                | Text files work. Images work on Flash only. PDFs are refused ("File inputs are not supported").                                                                                                                                                                                    |
| Long chats           | No compaction and no token counting endpoint. The context gauge is an estimate, and "Continue in a new chat" is the way on.                                                                                                                                                        |
| Cost                 | Always the peak rates (Flash: $0.30 in, $0.006 cached, $1.20 out per million tokens; V4 Pro: $1.32, $0.044, $3.96). Off-peak hours cost half, so the estimate may be high.                                                                                                         |
| Background summaries | Captures, chat notes and Continue use DeepSeek Flash for DeepSeek chats.                                                                                                                                                                                                           |
| Data                 | DeepSeek's privacy policy says data is processed and stored in the People's Republic of China. Neno chose to let DeepSeek chats read vault notes and memory like any other model.                                                                                                  |

Checked live by Neno on 2026-10-13 with a real DeepSeek key:

- A chat with three vault tool calls, then a later message, worked. So the Chat Completions rule that earlier `reasoning_content` must be passed back with tools (or a 400) does not bite on the Responses API, where Custard keeps reasoning only within a turn.
- A chat note was written by DeepSeek Flash, so `text.format: json_schema` works with Custard's schemas.
- DeepSeek Flash read an attached image, and the meter counted it from DeepSeek's own usage.

Still unverified:

- DeepSeek's wording for a too-long request (a 400). Custard's check for it is a guess.
- How DeepSeek counts image tokens before sending. OpenAI's rule is used for the estimate.
- Which model ran the tool-call chat wasn't recorded, so tool use stays `docs` in the capability matrix.
