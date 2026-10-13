# Providers

Custard talks to each provider through one of two APIs: Anthropic's Messages API (Claude) or the OpenAI Responses API (OpenAI, DeepSeek). Each provider is one entry in `src/shared/providers.ts`; its key file is in `src/main/providers.ts` and its address in `src/main/endpoints.ts`. Its models are in `src/shared/chat.ts`, its prices in `src/shared/pricing.ts` and its context limits in `src/main/context.ts`. TypeScript flags the other tables that need an entry: attachment rules, Design's chat-output note, the orb colours and the context minimum. The theme is a `data-provider` block in `src/renderer/src/assets/main.css`.

A packaged build always sends a provider's requests to its official address. A development build leaves Claude and OpenAI to `ANTHROPIC_BASE_URL` and `OPENAI_BASE_URL`. DeepSeek uses its own `DEEPSEEK_BASE_URL` or its official address, never OpenAI's.

## Adapters

Each provider has an adapter in `src/main/adapters/` (the interface is in `types.ts`, the registry in `registry.ts`). Claude uses `anthropic.ts`. OpenAI and DeepSeek share `responses.ts`, which reads each provider's flags from `src/shared/providers.ts`. Chat turns (`streamMessage`) and background summaries (`sendMessage`: captures, chat notes, Continue in a new chat) go through the adapter. Vault tools, plugins, approvals and the chat guard sit above it and never ask which provider is answering. Automation steps and web search still build their own clients.

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
- **Not built yet (Phase 4b).** An optional "ask the model" probe. It will run only when you press Refresh, sit beside the local answer, flag any disagreement, and never replace the local answer.

### Switching provider in a chat

Chats are stored in one format, Anthropic's message blocks, and each adapter converts to and from it on every request. So a chat started with one provider can go on with another, and nothing about the stored chat changes when you switch.

When the history goes to a provider other than the one that wrote it:

- Blocks only the original provider can read are dropped: Claude's thinking (and redacted thinking), Claude's fallback markers, and compaction blocks of either provider. Reasoning from a Responses provider is never stored, so it never reaches another provider.
- Everything else is kept. Text stays text, and tool calls and their results become the other API's function calls and outputs.
- A tool call to a tool this chat isn't offered now is sent as plain text (`history.ts`).
- Attached files are sent again in the new provider's form, or refused with a note when it can't take them (a PDF to DeepSeek, say).

A provider-neutral stored format is a possible later cleanup, if the round-trip test (Claude, then DeepSeek, then OpenAI, then Claude, with tool calls) shows problems. It isn't built.

## DeepSeek

Checked against api-docs.deepseek.com on 2026-10-12 (the overview, Models & Pricing, Create Response, the Responses API guide, Thinking Mode and Tool Calls pages).

|                      | DeepSeek in Custard                                                                                                                                                                                               |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Models               | DeepSeek V4 Pro (`deepseek-v4-pro`) and DeepSeek Flash (`deepseek-flash`). Both have a 1M context and up to 384K output.                                                                                          |
| Address              | `https://api.deepseek.com/responses`, with the DeepSeek key from Settings.                                                                                                                                        |
| Tools                | Function tools, as for OpenAI.                                                                                                                                                                                    |
| Thinking             | DeepSeek has no reasoning summaries. It streams its reasoning text as it goes, and Custard shows that. Within a turn, the reasoning is passed back with each tool result.                                         |
| Effort               | Custard's levels are sent as they are. DeepSeek treats low as low, medium/high/xhigh as high, and max as max.                                                                                                     |
| Effort in its list   | DeepSeek's model list also names effort levels per model (`fast`, `balanced`, `thorough`; seen in Neno's live check on 2026-10-13). Custard doesn't read or show them yet. To revisit with the picker in Phase 6. |
| Web search           | None. DeepSeek chats get `web_read` only, and the model is told search isn't available.                                                                                                                           |
| Files                | Text files work. Images work on Flash only. PDFs are refused ("File inputs are not supported").                                                                                                                   |
| Long chats           | No compaction and no token counting endpoint. The context gauge is an estimate, and "Continue in a new chat" is the way on.                                                                                       |
| Cost                 | Always the peak rates (Flash: $0.30 in, $0.006 cached, $1.20 out per million tokens; V4 Pro: $1.32, $0.044, $3.96). Off-peak hours cost half, so the estimate may be high.                                        |
| Background summaries | Captures, chat notes and Continue use DeepSeek Flash for DeepSeek chats.                                                                                                                                          |
| Data                 | DeepSeek's privacy policy says data is processed and stored in the People's Republic of China. Neno chose to let DeepSeek chats read vault notes and memory like any other model.                                 |

Unverified, since nothing has been sent to DeepSeek itself:

- The Chat Completions docs say that with tools, earlier `reasoning_content` must be passed back in every later request, or the request fails with a 400. The Responses docs state no such rule. Custard keeps a Responses provider's reasoning only within a turn, not between messages. Whether a second message in a DeepSeek chat with tools fails is the first thing the live test checks.
- That background summaries get valid JSON from `text.format: json_schema` with Custard's schemas.
- DeepSeek's wording for a too-long request (a 400). Custard's check for it is a guess.
- How DeepSeek counts image tokens. OpenAI's rule is used for the estimate.
