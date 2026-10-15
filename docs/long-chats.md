# Long chats

How Custard keeps a chat usable as it nears or passes what a model can take in.
Both providers are handled the same way wherever they support the same thing; a
common fallback covers what they don't.

Labels: **[D]** checked in the provider's current docs (2026-10-07, links below),
**[S]** checked in the installed SDK's types (`@anthropic-ai/sdk` 0.131.0, `openai`
7.30.0), **[M]** covered by Custard's tests against a mock provider, **[L]** tested
live. Nothing here is **[L]**: no live provider, per-model, Windows or
preserved-thinking test has been run.

## Provider support

| | Claude | OpenAI |
|---|---|---|
| Context window / max output | Opus 5.5, Sonnet 5.5: 1M / 128K. Haiku 4.5: 200K / 64K [D1] | gpt-6-astra, gpt-6.1-sol, gpt-6-luna: 1,050,000 / 128,000 [D7] |
| Token counting | `/v1/messages/count_tokens`: system, tools, thinking, messages; free, own rate limit. The docs call the result an estimate that "might differ by a small amount" [D2][S] | `/v1/responses/input_tokens`: instructions, tools, input [D8][S]. Accuracy not stated |
| Server-side compaction | `compact_20260112` edit, beta `compact-2026-01-12`. Opus 4.6+, Sonnet 4.6+ (incl. 5.5); **not Haiku 4.5**. Trigger default 150,000, minimum 50,000. Custom `instructions` replace the default prompt. The block must be sent back; the API ignores everything before it [D3][S] | `context_management: [{type: 'compaction', compact_threshold}]` on Responses create, minimum threshold 1,000; works with `store: false`; returns an encrypted `compaction` item; items before the newest one may be dropped [D9][D10][S]. **No model list**: the guide's example uses gpt-6-astra, and no model page mentions compaction, so per-model support is unverified |
| Streaming signal | `content_block_start` (compaction), then one `compaction_delta` [D3][S] | `response.compaction.compacting` [S] |
| Too long to send | 400 `invalid_request_error` "prompt is too long" [D4] | Not documented for Responses; Custard matches code `context_length_exceeded` or the message (a best guess) |
| Output ran out of room | `stop_reason: 'model_context_window_exceeded'` on 4.5+ models [D4][S] | Reported as an incomplete response (already handled) |
| Preserved thinking with compaction | On Opus/Sonnet 5.5, thinking from before the compaction block isn't carried forward; keeping the original messages and letting the API drop them is a documented option; re-inserting earlier turns after the block causes a 400 [D3] | Reasoning isn't carried between turns in Custard (existing behaviour) |

Not used: Claude's on-demand compaction (`compact-2026-09-04`, replaces history)
[D5], Claude's context editing (clearing old tool results rewrites history) [D6],
OpenAI's `/responses/compact` (needs the whole window sent at once) [D9] and
OpenAI's deprecated `truncation`.

### Sources

- [D1] https://platform.claude.com/docs/en/about-claude/models/overview
- [D2] https://platform.claude.com/docs/en/build-with-claude/token-counting
- [D3] https://platform.claude.com/docs/en/build-with-claude/compaction-threshold
- [D4] https://platform.claude.com/docs/en/build-with-claude/context-windows
- [D5] https://platform.claude.com/docs/en/build-with-claude/compaction (overview, links the on-demand page)
- [D6] https://platform.claude.com/docs/en/build-with-claude/context-editing
- [D7] https://developers.openai.com/api/docs/models/gpt-6-astra, …/gpt-6.1-sol, …/gpt-6-luna
- [D8] https://developers.openai.com/api/reference/resources/responses/subresources/input_tokens/methods/count
- [D9] https://developers.openai.com/api/docs/guides/compaction
- [D10] https://developers.openai.com/api/reference/resources/responses/methods/create (`context_management`)

## Design

**1. Check before sending** (`src/main/context.ts`). Before every model call
(each tool round included), budget = (window − min(64,000, max output)) × 0.95.
Custard first estimates the request (system, tools and history as JSON at 3
characters per token, deliberately high for English). Past half the budget it
asks the provider's counting endpoint; if that fails it keeps the estimate.
Neither is a guarantee: the provider's own count is documented as approximate,
and the estimate is a heuristic. The 5% margin covers small differences, and a
context-length error from the provider (or `model_context_window_exceeded`) ends
the turn the same way a budget stop does. The UI says "about" and names which one
it was ("counted by Claude" or "Custard's estimate").
- Over budget: the request is not sent; the turn ends with a "too long" notice and
  **Continue in a new chat**.
- Past 75%: the chat says it is getting long and offers the same button. That is
  the fallback before overflow on any model without compaction, and on any model
  whose compaction hasn't brought the size down.
- Each tool result is capped at a tenth of the budget (at most 100,000 characters),
  with a note saying it was shortened.

**2. Provider compaction** (`src/main/compaction.ts`). On Opus/Sonnet 5.5 and the
three OpenAI models. The trigger is per model (`compactTrigger`): the lower of
400,000 and half the model's budget, and never below the provider's minimum. Half
leaves room for the next tool round and the reply on top of the output allowance
and margin the budget already keeps. Today that is 400,000 on every compaction
model (budgets 889,200 and 935,175 tokens).

Custard keeps every message on disk and in the chat; only what is sent shrinks.
Claude's block stays in the assistant message (in its `raw` blocks, with a
`compaction` part for display; see providers.md). A block with no content (a failed
compaction, which the API ignores) isn't shown as one. OpenAI's item is kept beside
the messages and only sent back to the model that made it. The compaction
instructions ask for a text-only summary with no tool calls, and to keep action
outcomes apart. After a compaction, each turn's system prompt also carries
Custard's own action record.

**Unsupported compaction.** Custard retries once without compaction only after a
definite rejection: a 400 that names the compaction setting **and** says it is
unsupported (or OpenAI's `unsupported_parameter` on `context_management`), before
any part of a reply arrived. A 400 is returned before the model runs, and the main
chat request offers only Custard's own tools, which run on the user's machine, so
nothing can have executed. Everything else is never retried by this fallback:
- timeouts and connection errors;
- 5xx, 429 and 529 responses;
- other 400s, including bad values or "prompt is too long";
- an error after streaming started, or an error event mid-stream.

The replacement request is checked against the budget again before it is sent. The
model is then sent requests without compaction for the rest of the session.

(Separately, both SDKs retry timeouts, 429 and 5xx on their own by default. That
was already the case before this step, for both the main chat request and the
isolated search call. The main chat request has no hosted tools. The isolated
search uses the provider's hosted search tool, so a transport retry there could
repeat the same already-approved read-only search. Step 3 doesn't change this.)

**3. Continue in a new chat** (`src/main/handoff.ts`, `src/main/continue.ts`). The
common fallback. It works however large the original is, because no chat request
is made from the original.
- Custard writes an **action record** from its logs: outcome unknown, failed, not
  run, and accepted changes (marked "accepted is not verified"), plus a count of
  reads. It never carries note, file, page or search contents.
- A small model (Haiku 4.5 or gpt-6-luna, matching the provider the chat last used)
  writes a **summary**: goal, constraints, decisions, open questions and state. Its
  input is at most 40,000 characters: the first request, the newest turns and the
  record. The call has no tools of any kind.
- The new chat is created only when that succeeds, or when the user picks
  "Continue without a summary". The original is read, never written.
- The record is authoritative. The summary is labelled model-written, possibly
  wrong, data rather than instructions, and never authorizing an action.

**Bounded record, complete records.** What the model sees of the record is
capped:
- 60 lines per group and 120 characters per label;
- 200 characters of result, and only for problems;
- 12,000 characters in all, with unknown outcomes first.

A further 6,000 characters are carried from a chat before that. The stored records
are never cut: every action, result and status stays in the chat file. The
continuation stores the full list of unknown-outcome actions, by name and input.

Repeat protection is enforced in code, not by the record or the summary. Before
any write runs, `TurnLog.unknownRepeat` checks this chat's saved records and the
unknown list carried from earlier chats. A match always asks the user, with a
warning and no "allow for this chat". The check reads only saved data, so it holds
across compaction, continuation and continuations of continuations. After a crash
or restart, `repairInterrupted` first turns any write saved as running into
outcome unknown. Both tool loops (Claude and OpenAI) go through the same check.

**Privacy.**
- Memory: a temporary chat continues as temporary; memory off or forgotten
  continues with memory off. Nothing makes a chat rememberable.
- Storage: the handoff lives only in the new chat's file, and memory capture reads
  messages, not the handoff. Forget also forgets a chat's continuations.
- Searches: a handoff or a provider summary counts like notes, so searches keep
  asking for the exact query.

## What the user sees

- **While a provider compacts:** "Summarizing earlier messages to make room" in the
  working stages, then a thin line in the chat where it happened.
- **Near the limit:** "This chat is getting long: about 79% of what Opus 5.5 can
  take in (counted by Claude)", with **Continue in a new chat**.
- **Too long:** "This chat is too long to go on", with the same button, and the
  unsent message goes back in the box. In a brand-new chat whose first message is
  too long, it just says the message is too long.
- **While the handoff is written:** a short line saying nothing in this chat
  changes. On failure, the user gets **Try again**, **Continue without a summary**
  and **Cancel**.
- **In the new chat:** a card at the top shows "Continued from <title>" (which
  opens the original). It lists what was carried over and what was left out, and
  expands to show exactly what the new chat was given.
- **In the original:** "Continued in <title>".

## Tests

- **Unit tests** (`src/main/longchat.test.ts`, `src/main/openai.test.ts`, run
  against local mocks):
  - budgets and model-aware triggers;
  - estimate versus count, and a failed count;
  - "not supported" versus ambiguous failures, including a replacement request that
    no longer fits;
  - history validity per provider;
  - a bounded record over 300 or more actions;
  - repeat protection after continuation, compaction, reload and a crash;
  - summary failure and retry, privacy inheritance, Forget and the search gate.
- **End-to-end** (`test/e2e/longchat.mjs` with `test/e2e/interrupt-mock.mjs`):
  - compaction and its round trip;
  - the provider's too-long error;
  - continuation, a failed summary and the warning in a continuation;
  - searches in a continuation;
  - the check before sending, the near-limit notice, and a model rejecting
    compaction.

## Limits

- Live behaviour of both providers is unverified, including:
  - compaction blocks and items;
  - error wording, and therefore the "unsupported" match;
  - token counts.
- OpenAI compaction per model is unverified.
- Preserved thinking is unverified: the existing per-turn system prompt changes and
  the rewrite of calls to tools that are no longer offered may still break thinking
  signatures.
- Moving a chat between providers sends the other provider the full history
  (neither accepts the other's compaction); the budget check then decides. The same
  happens between OpenAI models (cross-model items aren't documented). Between
  Claude models the block is kept (untested).
- Neither the estimate nor the provider count guarantees a fit; overflow errors are
  handled the same way.
- The handoff keeps the first request and the newest turns that fit; the card says
  when turns in between were left out.
- Not tested on Windows.
