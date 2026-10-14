# Adding a provider

How to add a model provider to Custard, in the order the work goes. How the pieces fit together is in [providers.md](providers.md) (registry design and known wrinkles). Two worked examples follow the steps: [Qwen](#walkthrough-qwen-openai-compatible) and [Claude on Amazon Bedrock](#walkthrough-claude-on-amazon-bedrock).

Checked against the code on 2026-10-14 (branch of PR #51; model profiles from Phase A2). File paths are from the repo root.

## Before you start: which kind of provider is it?

| The provider speaks…                                    | Adapter                                                         | Work                                                                  |
| ------------------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------- |
| The OpenAI **Responses API** (`POST /responses`)        | Reuse `responsesAdapter(id)` (`src/main/adapters/responses.ts`) | A profile and tables. No adapter code unless a feature behaves oddly. |
| Anthropic's **Messages API** at another address or auth | Today `anthropicAdapter` is hard-wired to `claude`              | Make it take a provider id and a client factory (see Bedrock below).  |
| Anything else (Chat Completions only, Converse, Gemini) | A new adapter, from `src/main/adapters/template.ts`             | The adapter, plus history conversion and stop mapping for chats.      |

"OpenAI-compatible" usually means Chat Completions, not Responses. Check which one the provider documents before assuming the first row.

## Steps

### 1. Profile in `src/shared/providers.ts`

Add an entry to `providers`. The key (`qwen`, say) becomes the `Provider` type everywhere, and TypeScript then fails every table that needs an entry for it. That failing list is your checklist.

- `name`, `maker` ("a Qwen model": how the model is introduced in its instructions; `null` only for Claude).
- `api`: `'anthropic'` or `'responses'`. A third API means a new `ProviderApi` value and a new adapter.
- `summaryModel`: the cheap model for captures, chat notes and Continue. It must also have a model profile (step 5).
- `keyPlaceholder`, `keyWhere`: shown in Settings.
- `discoverModels`: `true` lists models the provider has that Custard has no profile for, as "not yet supported" in Settings. They are never pickable.
- `responses` (Responses providers only): `reasoningSummary`, `encryptedReasoning`, `tokenCount`. (Hosted search is per model, in its profile: step 8.) Set each one only when the provider documents it. A flag that is wrongly on sends a field the provider may reject or silently ignore.

### 2. Adapter: reuse or write

- **Responses API:** reuse `responsesAdapter(id)`. It reads the `responses` flags, so OpenAI and DeepSeek are the same code.
- **Anthropic Messages API elsewhere:** `anthropic.ts` builds its client in one place (`client()`), but its id, its key check and `anthropicEndpoint()` all say `claude`. Turn it into `anthropicAdapter(id, makeClient)` first. That is a refactor of Claude's path, so run the Claude golden record before and after (step 10).
- **Another API:** copy `src/main/adapters/template.ts`. Every `PROVIDER-SPECIFIC` comment is a place to fill from the provider's docs. The rest (the turn loop, the stop rules, how errors become `ProviderError`) is the same for every adapter and should stay. The template compiles but its request code has never been sent anywhere.

What an adapter must get right, whichever route:

- **Stored chats are Anthropic message blocks.** Convert on the way out, drop what the provider can't read (Claude's thinking, redacted thinking, fallback markers, compaction blocks), and store only `text` and `tool_use` blocks back. Never store the provider's own reasoning: it would reach other providers.
- **Every way a reply can end maps to a stop.** For `sendMessage`: `refused`, `cut-off`, `too-long`, `failed`, `done`. Summaries and automation steps rely on these to never keep a declined or partial text (Phase 8). For `streamMessage`: the `TurnEnd` values in `types.ts`.
- **Errors are `ProviderError` with the key hidden** (`toProviderError(err, name, key)`). A rejected key must come out as kind `auth`, or Settings and the picker can't say the key was rejected. `errorKind` in `providerError.ts` only knows the Anthropic and OpenAI SDKs' error classes; another SDK needs its own mapping.
- **Approvals, the chat guard and tools are not the adapter's job.** It calls `turn.runRound(calls)` and reads the results from `turn.history()` at the next step.

### 3. Registry line

`src/main/adapters/registry.ts`, in `adapters`:

```ts
qwen: responsesAdapter('qwen'),
```

TypeScript requires it once the profile exists. Nothing else finds providers: there is no discovery at runtime (see [providers.md](providers.md#registry-design)).

### 4. Key storage, address and Settings

- `src/main/providers.ts` → `KEY_FILES`: the key's file name under Custard's data folder. `apiKey.ts` encrypts it with the OS keychain (`safeStorage`), and no other code reads the file.
- `src/main/endpoints.ts` → `ENDPOINTS`: the official address, pinned in a packaged build. Give it an `env` variable (`QWEN_BASE_URL`) so development and the e2e stand-ins can move it. Never let it fall back to `OPENAI_BASE_URL`, which would send this provider's key to OpenAI's address in a development build.
- `responsesClient(id, key)` in `src/main/providers.ts` already uses both.
- **Settings needs no code** for a provider whose key is one string: the key section is drawn for every entry in `providerIds`. A provider that needs more than one string (a region, an account id, a key pair) does not fit today: `apiKey.ts`, the key IPC and `OneShotRequest.apiKey` are all one string per provider.
- **Key hiding:** `hideKey` in `providerError.ts` removes the exact key when it is known, and anything shaped like `sk-…`. A key with another shape is hidden only where the caller passes it in. Add its pattern if it has a recognisable prefix.

### 5. Models, prices, limits and discoverModels

Each model id must be unique across all providers: `adapterForModel` and `capabilitiesOf` look models up by id alone.

- `src/shared/models.ts` → one entry in `builtInProfiles` per model: `id`, `provider`, `label`, `limits` (`window`, `maxOutput`), `compaction`, `prices` (put the source URL in the comment at the top of `pricing.ts`), `thinking`, `effort` (levels, or `null` for none: no effort is sent and the picker greys its buttons), `fallbacks`, `files` (`images`, `pdf`, `imageTokens`), `search` and `live`. Order is picker order. Main's model registry (`src/main/modelRegistry.ts`) starts from this list and the renderer copies it over IPC (`models:profiles`); `chatModels()`, `limitsFor`, prices and capabilities all read the registry. `modelRegistry.test.ts` checks that every model id the app's code names has a profile. Without prices, the usage meter counts the model's calls as unpriced, and `capabilities.test.ts` fails (it requires every model to be priced).
- `src/main/context.ts` → `MIN_TRIGGER` (TypeScript asks for it).
- `discoverModels` (step 1): the key check (step 9) then lists the provider's other models in Settings as "not yet supported". Unknown models never reach the picker.

### 6. Capability flags and evidence tags

`src/main/adapters/capabilities.ts` derives every capability from the rules a request is built from. For a new provider you mostly change those rules, not this file:

- vision and PDF come from `src/main/attachments/request.ts` (a per-provider entry: the refusal wording and image size rules), which asks the profile's `files` whether the model takes them. TypeScript asks for it.
- reasoning summaries and token counting come from the `responses` flags.
- thinking, effort, fallbacks, web search and compaction come from the profile.

**Evidence tags:** every answer is `docs` until someone records a live test on that model. Then add the capability to the profile's `live`, with who tested it and when in a comment. Never mark `live` from a stand-in test.

Other per-provider tables TypeScript will ask for: `CHAT_IMAGE_OUTPUT` in `src/main/design/capabilities.ts` (Design's note on image output), `RAMPS` in `src/renderer/src/components/Orb.tsx` (orb colours). The theme is a `:root[data-provider='…']` block in `src/renderer/src/assets/main.css`; TypeScript can't see that one.

### 7. Effort mapping

The picker offers Custard's levels. What goes on the wire is decided per provider:

- Claude: `output_config.effort`, only for models whose profile has effort levels.
- Responses: `reasoning.effort`, through `effortFor` in `responses.ts`.
- What is sent comes from the profile's `effort`: each level has the picker's `label`, Settings' `settingsLabel`, the stored `value` and the `send` value, and `otherwise` is the level any other stored value shows and sends as. DeepSeek's profiles are the example (Fast, Balanced, Thorough send low, high, max). No code branches on a provider's name for effort. A provider's models must share their levels: the picker shows one row per provider.
- Map only to levels the provider documents. When the docs and the API's own list disagree, ask (Neno's rule for DeepSeek: map to the documented values).

### 8. Web search

Hosted search is wired in **two places**:

1. The model's profile says whether it has hosted search, and which (`search`: `'claude-20260209'`, `'claude-20250305'`, `'responses'` or `false`). `webTools`, the capability matrix and `claudeSearchTool` read it.
2. The adapter's `webSearch()` runs the search. `responsesAdapter` calls `searchOpenAI` for a model whose profile says `'responses'`, and that code expects OpenAI's `web_search` tool and its reply shape.

A provider without hosted search needs nothing: its profiles say `search: false`, the model gets `web_read` only and is told search isn't available. A provider with a different search mechanism (a request flag rather than a tool, say) needs its own search function in `web/search.ts` and its own branch in `webTools`.

### 9. Save/Refresh key check

The key check is the provider's model list, run only on Save or Refresh in Settings (`src/main/adapters/checks.ts`). Nothing calls a provider at startup or in the background.

- `responsesAdapter` sends `GET /models` to the provider's pinned address and parses `{ data: [{ id, … }] }` (`parseModelList`). A provider that lists models elsewhere or in another shape needs its own `listRaw`.
- A 401 must surface as kind `auth` ("rejected"). Anything else ("couldn't check") leaves availability as it was.
- Availability in the picker then follows by itself (`availabilityFrom`): no key, rejected, or not in the last list.

### 10. Tests, including a golden record

Unit (vitest):

- `src/main/adapters/registry.test.ts` iterates `providerIds` and `capabilities.test.ts` iterates `chatModels()`, so both cover a new provider without edits. Run them.
- Add the provider's stop mapping to `src/main/adapters/effort.test.ts` (refusal, cut-off, effort on the wire) and its model list parsing to `discovery.test.ts`.

End-to-end (built app, local stand-ins, no provider called; see `test/e2e/`):

- **Golden record.** A Responses provider: add it to `test/e2e/responses-turn.mjs` and record with `--update` on the code _before_ any adapter change, then compare after. A new API: copy that script's pattern (plain, tool, cut-off, cut-off while calling a tool, step limit, stopped, refusal, rejected key) for the new stand-in. A change to the Claude path: `test/e2e/claude-turn.mjs` must stay 48/48 identical.
- `test/e2e/provider-matrix.mjs` (the same skills, vault tools, plugin tools and approvals on each provider) and `test/e2e/round-trip.mjs` (one chat through every provider with tool history): add the provider to both.
- `test/e2e/provider-requests.mjs`: automation-step and search requests, recorded before a change and compared after.
- `test/e2e/model-check.mjs` and `model-picker.mjs`: the key check and availability.

Then a live test by hand, labelled as such in `LIVE` and in the docs. Until then, every claim about the provider's behaviour is "unverified".

## Walkthrough: Qwen (OpenAI-compatible)

Not built. Official docs read on 2026-10-14. **Checked** means read on the cited page; **assumed** means not found in the docs or not tried.

### What the docs say

| Fact                                                                                                                                                                                                       | Status                                                                | Source                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Model Studio has an OpenAI-compatible **Responses API**: `POST {base}/responses`, not only Chat Completions.                                                                                               | Checked                                                               | [Responses API via OpenAI][qwen-resp], [Responses compatibility][qwen-compat] |
| Base URL is per region and per workspace: `https://{WorkspaceId}.{region}.maas.aliyuncs.com/compatible-mode/v1` (Singapore `ap-southeast-1`, Beijing `cn-beijing`, Virginia, Frankfurt, Hong Kong, Tokyo). | Checked                                                               | [qwen-resp]                                                                   |
| The US address is documented two ways (`dashscope-us.aliyuncs.com/compatible-mode/v1` and the workspace form).                                                                                             | Checked that the docs disagree; which is right is **assumed** unknown | [DashScope compatibility][qwen-ds], [first API call][qwen-first]              |
| Auth: `Authorization: Bearer <key>`. Keys are bound to a region; a key from another region gets 401 `invalid_api_key`.                                                                                     | Checked                                                               | [qwen-resp], [qwen-first], [qwen-ds]                                          |
| Full Responses support for the Qwen 3.5 to 3.8 families; other models get "basic compatibility" only.                                                                                                      | Checked                                                               | [qwen-compat]                                                                 |
| Current models: `qwen3.8-max`, `qwen3.7-plus`, `qwen3.8-flash`, 1M context, thinking supported. Max output per model is on the console's model cards, not in the docs.                                     | Models checked; output limits **assumed** unknown                     | [Text generation models][qwen-models]                                         |
| Function tools, `instructions`, `stream`, `max_output_tokens` (includes reasoning on Qwen 3.8). Unlisted parameters are ignored.                                                                           | Checked                                                               | [qwen-resp]                                                                   |
| `store` defaults to `true`.                                                                                                                                                                                | Checked                                                               | [qwen-resp]                                                                   |
| `reasoning.effort` with none, minimal, low, medium, high, xhigh, max; supported levels and the default vary by model (Qwen 3.8: xhigh default).                                                            | Checked                                                               | [qwen-resp]                                                                   |
| Reasoning comes back as `reasoning` items with `summary_text`, and can be passed back in `input`. Encrypted reasoning is not mentioned.                                                                    | Summary checked; encrypted **assumed** absent                         | [qwen-resp]                                                                   |
| Hosted search: `tools: [{"type": "web_search"}]`.                                                                                                                                                          | Checked                                                               | [qwen-resp]                                                                   |
| Structured output (`json_schema`) is documented for Chat Completions only, on some models, and "Singapore region models are not supported yet". `text.format` on Responses is not documented.              | Checked for Chat Completions; Responses **assumed** unknown           | [Structured output][qwen-json]                                                |
| A model list endpoint (`GET /models`).                                                                                                                                                                     | Not documented; **assumed** absent                                    | none found                                                                    |
| A token counting endpoint.                                                                                                                                                                                 | Not documented; **assumed** absent                                    | none found                                                                    |
| Key format (`sk-…`).                                                                                                                                                                                       | **Assumed**                                                           | none found                                                                    |
| Prices and file (image, PDF) rules.                                                                                                                                                                        | Not read                                                              |                                                                               |

[qwen-resp]: https://www.alibabacloud.com/help/en/model-studio/qwen-api-via-openai-responses
[qwen-compat]: https://www.alibabacloud.com/help/en/model-studio/compatibility-with-openai-responses-api
[qwen-ds]: https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope
[qwen-first]: https://www.alibabacloud.com/help/en/model-studio/first-api-call-to-qwen
[qwen-models]: https://www.alibabacloud.com/help/en/model-studio/text-generation-model/
[qwen-json]: https://www.alibabacloud.com/help/en/model-studio/qwen-structured-output

### Profile only

- Entry in `providers`: `api: 'responses'`, `maker: 'a Qwen model'`, `summaryModel: 'qwen3.8-flash'`, `discoverModels: false` (no list to discover from).
- `responses` flags: `reasoningSummary: true` (checked), `encryptedReasoning: false`, `tokenCount: false` (both assumed). Each model profile's `search`: see below.
- Registry line `qwen: responsesAdapter('qwen')`, key file, theme, orb colours, a model profile per model, attachment rules.
- `store: false`, which Custard always sends, is accepted (checked: a documented field).

### Needs new code

1. **The address.** It holds a region and a workspace id, and keys only work in their region. Custard pins one official address per provider and never takes one from Settings, so either one region and workspace form is pinned (only works for keys from that region, and the workspace id still has to come from somewhere), or `ENDPOINTS` and Settings learn a region choice from a fixed list. This is a decision for Neno before building.
2. **The key check.** No documented model list, so `listRaw` can't be `GET /models`. Options: try `GET /models` live and keep it if it works, or a minimal Responses call (costs tokens on each Save/Refresh).
3. **Effort.** Qwen's levels differ per model (Qwen 3.8: none, low, medium, xhigh). Effort levels are profile data, but a provider's models must share their levels (the picker shows one row per provider), and `send` only takes Custard's five level names today. Per-model rows and other wire names need new code.
4. **Structured output for summaries.** Captures, chat notes and Continue send `text.format: json_schema`. That is undocumented on Qwen's Responses API, and unsupported in Singapore even on Chat Completions. Until a live test shows it works, Qwen chats' summaries would fail (safely: nothing is written). A fallback means a JSON-in-prompt path in `sendMessage`.
5. **Web search.** The flag would offer `web_search`, and `searchOpenAI` parses OpenAI's `web_search_call` items and citation annotations. Whether Qwen's results have the same shape is assumed, not checked. Leave the flag off until a live search is recorded.
6. **Too-long and refusal.** `isContextError` matches OpenAI's wording; Qwen's is unknown. How Qwen declines (a refusal part or plain text) is unknown.

## Walkthrough: Claude on Amazon Bedrock

Not built. Official docs read on 2026-10-14, same labels as above.

### What the docs say

| Fact                                                                                                                                                                                                                                  | Status                                     | Source                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------- |
| Two integrations. New: "Claude in Amazon Bedrock", Anthropic's Messages API at `https://bedrock-mantle.{region}.api.aws/anthropic/v1/messages`. Older: InvokeModel and Converse on `bedrock-runtime`, now called legacy by Anthropic. | Checked                                    | [Claude in Amazon Bedrock][bed-new], [Claude on Bedrock (legacy)][bed-legacy] |
| Model ids on the new integration: `anthropic.claude-opus-5-5`, `anthropic.claude-sonnet-5-5`, `anthropic.claude-haiku-4-5` and others; some need access granted in the Bedrock console.                                               | Checked                                    | [bed-new]                                                                     |
| **Not supported on the new integration:** structured outputs, server-side tools (web search, web fetch, code execution), URL sources and the Files API, the Models endpoint, Message Batches, server-side fallback.                   | Checked                                    | [bed-new]                                                                     |
| Supported: Messages, prompt caching, thinking, client tool use.                                                                                                                                                                       | Checked                                    | [bed-new]                                                                     |
| Auth: a Bedrock service role (recommended), assumed IAM roles, or bearer tokens (12-hour maximum, least preferred). SigV4 needs the SDK's `AnthropicBedrockMantle` client.                                                            | Checked                                    | [bed-new]                                                                     |
| Bedrock API keys: short-term (up to 12 hours) or long-term (creates an IAM user, "recommended only for exploration", one region). Sent as `Authorization: Bearer`.                                                                    | Checked                                    | [Bedrock API keys][bed-keys]                                                  |
| The TypeScript SDK `@anthropic-ai/bedrock-sdk` has `AnthropicBedrockMantle` (for new projects) and `AnthropicBedrock` (bedrock-runtime), taking a region and either AWS credentials or an API key.                                    | Checked                                    | [TypeScript SDK][sdk-ts]                                                      |
| Opus 5.5 on Bedrock: 1M context, 128K output, effort low to max, structured outputs not supported on either endpoint; the new endpoint is in a few regions only (us-east-1 among them).                                               | Checked                                    | [AWS model card: Opus 5.5][bed-card]                                          |
| Listing models and checking access is on the `bedrock` control plane (`ListFoundationModels`, `GetFoundationModelAvailability`), signed with SigV4.                                                                                   | Checked                                    | [Model info][bed-list], [Model access][bed-access]                            |
| Whether a bearer key can call the control plane.                                                                                                                                                                                      | **Assumed** unknown                        | none found                                                                    |
| Whether the compaction beta and Custard's other betas work on the new endpoint.                                                                                                                                                       | **Assumed** unknown                        | none found                                                                    |
| That the Bedrock SDK's errors are the Anthropic SDK's error classes.                                                                                                                                                                  | **Assumed** (it is built on the same core) | not checked                                                                   |
| Bedrock prices (regional endpoints cost 10% more than global).                                                                                                                                                                        | Premium checked; per-model prices not read | [bed-card]                                                                    |

[bed-new]: https://platform.claude.com/docs/en/build-with-claude/claude-in-amazon-bedrock
[bed-legacy]: https://platform.claude.com/docs/en/build-with-claude/claude-on-amazon-bedrock-legacy
[bed-keys]: https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys.html
[sdk-ts]: https://platform.claude.com/docs/en/cli-sdks-libraries/sdks/typescript
[bed-card]: https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-opus-5-5.html
[bed-list]: https://docs.aws.amazon.com/bedrock/latest/userguide/models-get-info.html
[bed-access]: https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html

### Profile only

- Entry in `providers`: `api: 'anthropic'`, `maker`: `null` (it is Claude), `summaryModel: 'anthropic.claude-haiku-4-5'`, `discoverModels: false`.
- Model profiles with the Bedrock ids (they don't clash with `claude-opus-5-5`), `fallbacks: false` (server-side fallback is unsupported), prices and limits in the profiles, attachment rules (no URL sources, no Files API), theme, orb colours.
- Web search: set each profile's `search` to `false` (hosted search is unsupported on this integration).

### Needs new code

1. **A Claude adapter for more than one provider.** `anthropicAdapter` is hard-wired to `claude` (id, key check, `anthropicEndpoint()`). It needs an id and a client factory (`new AnthropicBedrockMantle({ awsRegion, apiKey })` for Bedrock). Claude's golden record must stay 48/48 through that refactor.
2. **Credentials.** A long-lived bearer key is "for exploration only"; the recommended routes are IAM roles or SigV4 credentials, plus a region. Custard holds one string per provider. Either support only a Bedrock API key (simple, but short-term keys expire within 12 hours) or add a credential shape (region plus key pair or AWS profile) to `apiKey.ts`, the key IPC and Settings. A decision for Neno.
3. **The key check.** The Models endpoint isn't available, and the control plane needs SigV4. Options: `ListFoundationModels` with SigV4 credentials (needs the AWS SDK), or a one-token Messages call (costs a little on each Save/Refresh).
4. **Summaries.** Captures, chat notes and Continue ask for `output_config` JSON schema, which Bedrock doesn't support. Without new code every Bedrock chat's summary fails (safely: nothing is written). Needs a prompt-only JSON path in `sendMessage` for this provider, or summaries routed to another provider (a data decision for Neno).
5. **Betas and features per endpoint.** Compaction, the fallback beta and `cache_control` are sent by Claude's `streamMessage` by model. They need to follow the provider: fallback off (unsupported), compaction only once checked live.
6. **Search.** Done since model profiles Phase A2: each profile says `search: false`, so Bedrock is off on purpose.
7. **Key hiding.** `hideKey`'s pattern covers `sk-…` only; AWS access keys and Bedrock API keys have other shapes. Add their patterns.
