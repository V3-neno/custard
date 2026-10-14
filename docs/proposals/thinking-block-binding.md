# Claude thinking blocks in continued chats: investigation

**Base branch: `automation-thinking-p3` at beeac8c.** It is the tip of the open chain (main ← #52 … ← #58), and it already holds #60 (folder permissions, merged into it). #59 (B1) and #61 (dropdown) are open PRs on top of it and are not in it. This file is the only change on the branch `thinking-block-binding`. No app code was changed, and no live provider call was made.

**Everything below about how the live API behaves is unverified.** It comes from Anthropic's guide as bundled with Claude Code (the `claude-api` skill, files `shared/model-migration.md` and `shared/preserved-thinking-migration.md` plus `preserved-thinking-migration/causes.md`). I re-read those files for this review and quote them below. The code facts are from reading the code on beeac8c.

## Short answer

- For Opus 5.5 and Sonnet 5.5, Custard rebuilds the system prompt and the tool list on every send, and some of what goes into them changes between turns of the same chat (the date, memory and captures, automation questions, widget state, editable folders, enabled plugins, plugin notes). It also rewrites earlier messages on the way out in two cases.
- Custard sends every stored thinking block back, unchanged, on every later turn.
- Per the guide, that combination is a 400 on accounts created on or after 2026-08-31, as soon as a turn follows a change. In Custard, the turn fails before anything is written: the message goes back to the input box with a raw error line, and every retry fails the same way until the change is undone. Nothing in Custard strips the blocks and retries.
- Whether Neno's account is enforced cannot be read in the Console. The only check is a live request (section 6).

## 1. What Custard sends for a Claude chat turn, and what can change between turns

Built per send in `src/main/chat.ts` `send()`, passed to `src/main/adapters/anthropic.ts` `streamMessage`:

- **`system`**: an array of text blocks assembled at chat.ts:348-480. In order: the base and mode prompt, the workspace prompt, the hub prompt, the skill write root, then the vault prompt (memory, recent captures, the skills list, the date) or the date line alone (chat.ts:390). After that come the automation questions (395-410), the unreachable-vault line, plugin instructions (412-419), plugin notes for this message (431), the handoff and action record for a continued or compacted chat (445), earlier chats (448), referenced chats (454), the web prompt, the "Not run/Outcome unknown" line, and the widget catalog (466-480).
- **`tools`**: chat.ts:481-496. Vault and chat tools, `vault_append`/`vault_edit` only when a folder grant allows them (484-487), workspace tools, `automation_question` only while questions are shown (490), web tools, plugin tools, `widget_show`/`widget_hide` with the current widget keys (493), design tools and the hub tool. All are filtered by the mode's policy.
- **`messages`**: `history()` at chat.ts:502-507, which is `withoutUnavailableTools(withFiles(conversation.messages, …), available)`, then `claudeHistory()` (compaction.ts:50) in the adapter.
- **Other fields**: `model`, `max_tokens: 64000`, `cache_control: {type:'ephemeral'}`, `stream`, `thinking: {type:'adaptive', display:'summarized'}` when the profile thinks (Opus 5.5, Sonnet 5.5; not Haiku 4.5), `output_config.effort`, and `betas` `server-side-fallback-2026-07-01` (with `fallbacks: 'default'`) and `compact-2026-01-12` (with `context_management`) (anthropic.ts:64-99).

Within one send, the tool loop reuses the same `system` and `tools` and only appends to `messages` (anthropic.ts:102-166), so the steps of one turn are append-only. The changes happen between sends.

**What can change between two sends of the same chat.** Each example is real output from Custard's own functions on this branch (run through esbuild in a scratch folder, not committed):

| Change | Where | Example |
|---|---|---|
| The date | vault.ts:206-217 via chat.ts:390 or the vault prompt | `Today's date is 2026-10-14 (Wednesday). …` becomes `Today's date is 2026-10-15 (Thursday). …` after local midnight (Europe/Stockholm, 21:59Z vs 22:01Z) |
| An automation question was asked | chatTool.ts:49, chat.ts:395-410 | turn 1: `<question id="q1" automation="Weekly review" left="Oct 14, 08:00">`; turn 2: the same line with ` asked="yes"` added |
| A question is answered or dismissed | chat.ts:396, 490 | its block leaves `system`; when none is left, the `automation_question` tool leaves `tools` |
| A memory capture was written after the turn | memory/capture.ts:156, vault.ts:255-283 | "Recent activity" in the vault prompt gains a line. Inferred from the code path; whether a given turn writes a capture depends on the summarizer |
| Memory.md or a skill was edited (by the user, Obsidian or a vault tool) | vault.ts:242-283 | `<memory>` or `<skills>` text changes |
| Another chat's summary note changed | earlierChats.ts:132-156 | the "Earlier chats" list changes |
| The user closed a widget | widgets/manager.ts:157 | the catalog line gains ` (the user closed it in this chat)` |
| A plugin was enabled or disabled | chat.ts:345, 412, 492-493 | plugin instructions and tools are added or removed, and widget keys change |
| An editable folder was added or removed (Settings, Editable folders) | chat.ts:382-388, 484-487 | the grants list in `system` changes; `vault_append`/`vault_edit` appear or disappear in `tools` |
| The message mentions a plugin | memory/plugins.ts via chat.ts:431 | a plugin-notes block is in `system` for this send only |
| A tool used earlier is no longer offered | history.ts:15-55 | an earlier assistant `tool_use` and its `tool_result` go out as text: `{"type":"text","text":"[Earlier call to spotify__play, which is not available now: {\"q\":\"jazz\"}]"}` and `[Result of that earlier call: Playing.]`. The stored chat is unchanged; only the outgoing copy is rewritten |
| An earlier attached file is missing or changed | attachments/request.ts:221-222, 236-241 | the file block in that earlier user message is replaced by a short placeholder note |

These do **not** change between sends, and the guide's keep list says they are not part of the check: the model, effort, the thinking config, `cache_control`, betas, and string versus a single text block.

## 2. Which stored thinking blocks are sent back, and to which model

- **Stored**: anthropic.ts:160 stores `echoableContent(message.content)`, which is every block as the API returned it, thinking and redacted_thinking included. The only exception is a mid-answer fallback: blocks before the last `fallback` marker, other than text, are left out (anthropic.ts:45-52). Thinking text and signatures are stored unmodified.
- **Sent back to Claude**: all of them, on every later turn, to whichever Claude model the chat is on now. `claudeHistory` (compaction.ts:50-60) removes only `compaction` blocks, and only for a model that doesn't compact. Nothing in `src/main` filters `thinking` or `redacted_thinking` on the way out; I grepped for both.
- **Sent to OpenAI or DeepSeek**: never. `toInput` in openai.ts drops thinking, compaction and fallback blocks.
- **One-shot calls** (`sendMessage`, anthropic.ts:175-249): automation runs rebuild each assistant turn from text and tool calls only (automations/run.ts:390-409), so they never send thinking back. Summaries and handoffs send no assistant thinking.

Per model, according to the guide's model-binding rules (unverified):

| Blocks made by | Sent to | What the guide says happens |
|---|---|---|
| Opus 5.5 | Opus 5.5 | checked against the conversation; a 400 on an enforced account if anything before the block changed |
| Opus 5.5 | Sonnet 5.5 or Haiku 4.5 | dropped silently, 200, not billed: "Claude Opus 5.5 to any other model, is a downgrade … `model_binding_mismatch` drops, 200 in both modes" |
| Sonnet 5.5 | Sonnet 5.5 | checked like Opus 5.5 |
| Sonnet 5.5 | any other model | dropped: "no other model reads Claude Sonnet 5.5's blocks" |
| any | a model after switching back | read again if nothing changed: "Round trip … nothing is lost, provided the client keeps the history intact" |
| Haiku 4.5 | (Custard sends no thinking config for Haiku 4.5, so it makes none) | "Claude Haiku 4.5 doesn't run this check." |

Turns from OpenAI or DeepSeek in the middle of a Claude chat are stored as plain text and tool_use blocks and appended, which the guide says is fine: "Turns from a non-Claude model do not invalidate earlier thinking, provided they are appended after the existing history as ordinary assistant messages (`text` and `tool_use` content, no `thinking` blocks) and nothing earlier changes."

## 3. Which changes invalidate a block

What the guide says, quoted (model-migration.md, "Breaking change 3", Fable 5.1 section, which the Opus 5.5 section says applies "verbatim"):

> A Claude Fable 5.1 thinking block's `signature` also records the conversation prefix that produced it - the top-level `system` prompt, the set of tools in `tools`, and every message before the block (with server-side compaction, the prefix starts at the most recent compaction block)

> **What invalidates every later thinking block:**
> - Editing, reordering, or removing an earlier turn while keeping later ones …
> - Injecting per-request text into an earlier turn (a reminder, a status line, a token count) that you remove or rebuild on the next request.
> - Rebuilding the top-level `system` prompt or `tools` array between requests in the same conversation.
> - Removing a thinking block from anywhere other than the start of the run …

From causes.md: "Tools are compared as their full definitions - name, description, and `input_schema` - so changing even one tool's description invalidates every thinking block minted before the change … Adding or removing a plain tool has the same effect".

And what keeps blocks valid: "changing any request parameter outside `system` / `tools` / `messages` (`max_tokens`, `output_config` incl. `effort`, `tool_choice`, `metadata`); adding, moving, or removing `cache_control` markers; … server-side compaction and context editing".

**Mapping to Custard. This is inferred from the quotes above, not tested:**

- **Guide-stated (a direct match to a quoted rule)**: every row of the section 1 table that changes `system` or `tools` ("Rebuilding the top-level `system` prompt or `tools` array"). The `withoutUnavailableTools` rewrite and the file placeholder are "Editing … an earlier turn".
- **Inferred**: that a per-send block present on one turn and gone on the next (plugin notes) counts as a `system` change. The guide's rule is about the whole `system` array, so I expect yes, but I did not test it. Also inferred: that Claude's server-side compaction resets the check for messages but not for `system` (the guide says only "the prefix starts at the most recent compaction block").
- **Not a problem per the guide**: a model switch ("a model switch by itself never fails the prefix check"), changing effort, and the fallback marker handling (Anthropic's own rule for fallback, already in anthropic.ts:43-44; its interaction with the thinking chain is not covered by the guide, so unverified).
- **Which turns are hit**: any turn after a change, for a chat whose earlier Opus 5.5 or Sonnet 5.5 turns hold at least one thinking block. Adaptive thinking may skip thinking on short turns, so a chat of short exchanges may carry no blocks and never fail.

## 4. The account rule, the opt-in, and how to check the account

Quoted from model-migration.md:

> **Who is enforced:** new accounts **created on or after August 31, 2026**, on every platform. Enforcement scope is decided per model - Claude Opus 5.5 also enforces it for new accounts only

> For accounts created earlier the API *records* the mismatch but acts on it only when the request sets `thinking.block_binding.prefix_mismatch_behavior` - **any value, including `"error"`, opts the request into enforcement** … (the beta header alone does not opt in …)

For Sonnet 5.5: "It is enforced by default for accounts created on or after August 31, 2026, 00:00 UTC, on the Claude API and Amazon Bedrock".

**How Neno checks the account: there is no Console method in the guide.** It does not name any Console page that shows enforcement or the organization's creation date, and I know of none. The guide's only method is a live request:

> To see whether your own organization is enforced by default, send a request that edits history without the beta header - a 400 that names the header means it is.

Section 6 is that request, done through Custard. One inference: the project notes say Neno had no Claude API key on 2026-10-07 and chose API credits on 2026-10-13. If the Console organization was created then, it is after 2026-08-31 and enforced by default. If Neno's organization is older (for example, from earlier Console use), it is not enforced. Only Neno knows which.

## 5. Fix options

Nothing here is built. Each option would be a change to `anthropic.ts` and/or `chat.ts`. The SDK on this branch is `@anthropic-ai/sdk` 0.131.0, which types `thinking.block_binding.prefix_mismatch_behavior` (`resources/beta/messages/messages.d.ts:3738, 3762`), lists `thinking-binding-controls-2026-08-01` in `AnthropicBeta` (`resources/beta/beta.d.ts:52`), types `role: 'system'` messages (messages.d.ts:3044) and `tool_addition` (3363), and types `input_transformations` on the response (2940). Custard already calls `api.beta.messages.stream` with a `betas` array, so it can send the header with no new plumbing.

| Option | What it does | 400s | Reasoning kept | Prompt cache | Goldens / request hashes | Size |
|---|---|---|---|---|---|---|
| **A. `drop_block` + beta header** | Add `thinking-binding-controls-2026-08-01` to `betas` and `block_binding: {prefix_mismatch_behavior: 'drop_block'}` to `thinking` for profiles that think, in `streamMessage` and in the `claudeCounter` call (the count endpoint "runs the same check"). Optionally, the guide's variant: send it only after the first such 400, and remember it per chat. | none from this check | Lost after each change: "the API drops the first mismatched block **and every thinking block after it**", silently, unbilled, "the session's token usage might still increase" | Unchanged (both fields are outside the compared prefix). Not verified whether adding a beta value changes caching. | Every Claude request body for Opus/Sonnet changes, so `claude-turn*.golden.json` hashes and `provider-requests.golden.json` change once. Haiku 4.5 sends no thinking config, so it is unchanged. | Small (about 10 lines) |
| **B. Fixed system prompt and tools per chat, changes as mid-conversation system messages** | Render `system` and `tools` once per chat and store them. Send the date, memory, questions, widget state, grants and plugin notes as appended `role: 'system'` messages. Add or withdraw tools with `tool_addition`/`tool_removal` (beta `mid-conversation-tool-changes-2026-07-01`). Stop rewriting stale tool calls; leave the definitions in place. | none if done fully | Kept | Better: a stable prefix caches across turns | Most Claude goldens change, along with the stored chat format (new `role: 'system'` messages), which B2/B3 must carry and translate for OpenAI/DeepSeek | Large; touches the prompt, plugins, widgets, questions, folder permissions and history. Behaviour changes: the model sees memory as of the chat start plus deltas |
| **C. Never send thinking back** | In `claudeHistory`, remove `thinking`/`redacted_thinking` from assistant messages of earlier turns, keeping the current turn's blocks so the tool loop keeps its reasoning (removing a leading run is allowed: "removing a *leading* run of thinking blocks, oldest first"). | none from this check | Lost on every turn after the one that made it | Each turn's assistant message is sent with thinking during its own turn and without it afterwards, so the cache breaks at that message once per turn (inferred) | Hashes change for histories that hold thinking | Small, but needs care to strip exactly the earlier turns |
| **D. Send thinking back only when nothing changed** | Store a hash of `system` + `tools` with each assistant message. On the next send, if the hash differs, or an outgoing rewrite (stale tool, file placeholder) touched an earlier message, strip thinking from that point on, and record the strip so it stays stripped ("Once a block is removed, leave it out"). | none if the hash matches the API's rule exactly; any mismatch (for example a difference the API tolerates but the hash doesn't, or the reverse) is either needless loss or a 400 | Kept while nothing changes, which in Custard is often not for long (the date, captures, questions) | Unchanged | Unchanged while no thinking is stripped, except for the stored hashes | Medium, and it depends on matching the API's comparison rules, which are not published as code. Best combined with A as a safety net |

The guide's own advice on handling the error: "retry once with the beta header and `prefix_mismatch_behavior: "drop_block"`, and store that choice with the session so every later request sends it too, including after a restart; where the beta header cannot be sent, remove every `thinking` and `redacted_thinking` block from the history once and leave them out."

**My recommendation, for Neno to decide: A now, then the cheap parts of B later.** A ends the 400s with one small change. The cheap parts of B remove the accidental changes: the `asked="yes"` flag, the "closed it in this chat" note, the per-message plugin notes, and the date when it doesn't need to be in `system`. That way less reasoning is dropped. A full B is a big change and should wait until B3 settles the stored format. Not building any of this without Neno's answer.

## 6. A cheap live check on Opus 5.5 (Neno's machine, unverified)

About two short Opus 5.5 requests. The system prompt and tools are a few thousand tokens each, so the cost is small, but I have not priced it.

1. In Custard, open a **new Chat-mode chat on Claude Opus 5.5** with the vault connected.
2. Send something that makes it think, for example: *"Without a calculator: is 2^100 or 3^63 larger? Explain in two lines."* You should see the thinking text stream while it works. If no thinking appeared, the test is inconclusive: try again with a harder question.
3. Without sending anything else, open **Settings → Editable folders**, add any folder with "append" (or remove one, if you already have one). This changes both the system prompt (the grants list) and the tool list (`vault_append`).
4. Back in the same chat, send: *"And 2^50 or 3^31?"*

Expected outcome if the account is **enforced** (created on or after 2026-08-31): the second message fails at once with no reply. Your text goes back to the message box, and the error line reads (built from the code path, not seen live):

```
Claude returned an error (400): 400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation. Remove the block, or set `thinking.block_binding.prefix_mismatch_behavior` to \"drop_block\". That setting requires the `thinking-binding-controls-2026-08-01` value in the `anthropic-beta` header."},"request_id":"req_…"}
```

The path should be `messages.1.content.0`: the first reply, first block. The API "can end with one more sentence naming the first message that changed". Sending again fails the same way. Undoing the folder change in step 3 should make it work again; that is also unverified.

Expected outcome if the account is **not enforced**: the second message is answered normally, and there is no visible sign of the check.

To confirm the first reply held a thinking block, open the chat file. On Windows, the packaged app's chats are in `%APPDATA%\Custard\conversations\<chat id>.json`; a dev run uses `%APPDATA%\custard\…`. Search the file for `"type":"thinking"` in the first assistant message. The folder name follows Electron's `userData` default: `productName: Custard` from electron-builder.yml for the packaged app, and `name: custard` from package.json for a dev run. I took that from Electron's documented default behaviour; I did not check it on Windows.

## 7. How a 400 shows in Custard today, and whether anything retries

- The Anthropic SDK does not retry a 400. Its `shouldRetry` (node_modules/@anthropic-ai/sdk/client.js:708-742) retries only on 408, 409, 429, 5xx, or `x-should-retry: true`.
- If the token count runs first (only when the estimate is near the budget, context.ts:143-170), the count endpoint gets the same 400, per the guide. Custard treats a failed count as "use the estimate" and goes on to send, which then fails.
- `streamMessage`'s own retry (anthropic.ts:142-148) is only for a 400 that names compaction and says it is unsupported. The thinking 400 text doesn't contain "compact", so it is rethrown.
- chat.ts:1014-1019: not aborted, and not a context error (context.ts:173-176 looks for "prompt is too long|context window"), so the turn ends with `stopEarly('error', describeError(err, 'Claude'))`.
- `errorKind` (providerError.ts:29-56) classes it as `bad_request`; the `UNSUPPORTED` pattern doesn't match this text. The message is the generic line `Claude returned an error (400): <SDK message>`, where the SDK message is `400 ` plus the raw JSON body (client.js:603-615, core/error.js:21-29). That is the line in section 6.
- `log.interrupt` (turn.ts:185-215): the 400 comes before any output, so nothing happened, and the user's message is taken off the chat (turn.ts:209-211). The chat is saved without it, and the renderer puts the text and any files back in the box and shows the error (ChatView.tsx:406-414).
- **Nothing strips thinking blocks and retries.** Every later send replays the same blocks, so the chat stays broken until whatever changed changes back. In cases like the date, it never does.

## 8. Other things that look wrong (reported, not fixed)

1. **The error text is raw JSON.** A user sees `400 {"type":"error",…}`. It's readable, but it doesn't say what to do. It applies to every Claude 400, not just this one.
2. **Automation runs drop thinking between their own steps** (automations/run.ts:390-409). That's safe for this check, but the model loses its reasoning between tool calls within one run. I did not check whether the API accepts an assistant `tool_use` turn with no thinking block while thinking is on for Opus 5.5 and Sonnet 5.5. The e2e mocks accept it; the live API is unverified.
3. **Plugin notes are per message** (chat.ts:431), so even with nothing else changing, a message that mentions a plugin followed by one that doesn't changes `system`. That is the most frequent accidental change I found, along with the date and `asked="yes"`.
4. **The fallback handling and the thinking chain.** anthropic.ts:45-52 removes the declining model's thinking from the middle of an assistant message. The guide says blocks may only be removed as a leading or trailing run. Anthropic's fallback docs presumably cover this case, but I did not find it in the guide. Unverified.
5. **The B1 review's live-risk note stands.** This file replaces it as the detailed version. B2 will not change Claude requests, as decided.

## What I read

- **Read in full**: `src/main/adapters/anthropic.ts`, `src/main/adapters/responses.ts`, `src/main/compaction.ts`, `src/main/turn.ts`, `src/main/providerError.ts`, `src/main/history.ts` (the function); and the guide's `shared/preserved-thinking-migration.md`.
- **Read in part**:
  - `src/main/chat.ts`: 241-310, 340-520 and 900-1030.
  - `src/main/attachments/request.ts`: 170-240 and 290-345.
  - `src/main/context.ts`: 100-185.
  - `src/main/vault.ts`: 206-217 and 240-285.
  - `src/main/memory/capture.ts`: 140-200.
  - `src/main/automations/chatTool.ts`: 37-54.
  - `src/main/automations/run.ts`: 380-415.
  - `src/main/earlierChats.ts`: 132-156.
  - `src/main/widgets/manager.ts`: 153-163.
  - `src/renderer/src/components/chat/ChatView.tsx`: 395-430.
  - The SDK's `client.js`: the error and retry code.
  - The guide's `causes.md`: the model-switch section, the cause table, the keep list and the failure modes.
  - The guide's `model-migration.md`: Breaking change 3 for Fable 5.1, Opus 5.5 and Sonnet 5.5, and the Haiku 5.5 paragraph.
- **Grepped only**:
  - SDK typings (`messages.d.ts`, `beta.d.ts`).
  - `src/main` for `thinking`/`redacted_thinking`.
  - `src/shared/models.ts` for the thinking flags.
  - `openai.ts` `toInput` (read in B1).
  - Settings UI labels.

## Baselines on beeac8c (unchanged; this branch adds only this file)

- **Unit** (`npx vitest run`): 1,315 passed, 82 files.
- **Typecheck** (`npm run typecheck`): clean.
- **ESLint** (`npx eslint src test`): clean. On the whole repo, 14 errors, all in `plugin/spotify/tests` (Neno's commit 918e9cb). These were already there and are out of scope.
- **e2e**: run one suite at a time under xvfb. Playwright was missing after `npm ci`; I installed it with `npm i --no-save --ignore-scripts playwright` (not saved to package.json). In the full run, 49 suites ran and 48 passed, with no failed checks. One suite, `automations`, stopped at "A schedule fires by itself, once" with `page.waitForFunction: Timeout 120000ms exceeded` (automations.mjs:165), after 15 checks had passed. Rerun alone, it passed all 19 checks. **With that rerun, the total is 49 suites, 1,582 checks passed, 0 failed.** The timeout is in a scheduler-timing check, not in anything this review covers. I did not investigate it further.

## What I could not verify

- Everything about the live API: the 400 itself, its exact text, which accounts are enforced, the model-binding drops, how `drop_block` behaves, the effect on the cache, and whether the count endpoint returns the same 400.
- Whether Neno's account is enforced.
- Windows paths and behaviour.
- Whether a capture is written on any given turn. That depends on the summarizer's output.
