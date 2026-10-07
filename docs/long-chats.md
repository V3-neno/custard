# Long chats

How Custard keeps a chat usable as it nears or passes what a model can take in.
Both providers are handled the same way wherever they support the same thing; a
common fallback covers what they don't.

Labels: **[D]** checked in the provider's current docs (2026-10-07), **[S]** checked
in the installed SDK's types (`@anthropic-ai/sdk` 0.131.0, `openai` 7.30.0),
**[M]** covered by Custard's tests against a mock provider, **[L]** tested live.
Nothing here is **[L]**: no live provider, Windows or preserved-thinking test has
been run.

## Provider support

| | Claude | OpenAI |
|---|---|---|
| Context window / max output | Opus 5.5, Sonnet 5.5: 1M / 128K. Haiku 4.5: 200K / 64K **[D]** | gpt-6-astra, gpt-6.1-sol, gpt-6-luna: 1,050,000 / 128,000 **[D]** |
| Token counting | `messages.countTokens` (`/v1/messages/count_tokens`): counts system, tools, thinking, betas and `context_management`; free, own rate limit **[D][S]** | `responses.inputTokens.count` (`/v1/responses/input_tokens`): counts instructions, tools and input **[S]** (endpoint in API reference **[D]**) |
| Server-side compaction | `compact_20260112` edit in `context_management`, beta `compact-2026-01-12`; Opus/Sonnet 4.6+ and 5.x only, **not Haiku 4.5**; returns a `compaction` block to send back unchanged; the API drops everything before it **[D][S]** | `context_management: [{type: 'compaction', compact_threshold}]` on Responses create; works with `store: false`; returns an encrypted `compaction` item; items before the newest one may be dropped **[D][S]**. The guide lists no model restriction (its example uses gpt-6-astra) and no model page mentions it, so per-model support is **not verified** |
| Compaction instructions | `instructions` on the edit **[D][S]** | None documented |
| Streaming signal | `content_block_start` with a `compaction` block, then `compaction_delta` **[S]** | `response.compaction.compacting` **[S]** |
| Too long to send | 400 `invalid_request_error` "prompt is too long" (exact wording not documented); 413 `request_too_large` is the 32 MB size limit **[D]** | Error shape not documented for the Responses API; Custard matches code `context_length_exceeded` or the message (a best guess) |
| Output ran out of room | `stop_reason: 'model_context_window_exceeded'` **[D][S]** | Reported as an incomplete response (already handled) |

Not used: Claude's on-demand compaction (`compact-2026-09-04`, needs history
replaced), Claude's context editing (clearing old tool results rewrites history
and breaks preserved thinking), OpenAI's `/responses/compact` (needs the whole
window sent at once; returns a new window to replace history) and OpenAI's
deprecated `truncation`.

## Design

**1. Check before sending** (`src/main/context.ts`). Before every model call:
budget = (window − min(64,000, max output)) × 0.95. Custard estimates the request
(system, tools and history, as JSON at 3 characters per token, which overestimates
English text). Past half the budget it asks the provider to count exactly; if the
count fails it keeps the estimate. Over budget: the request is not sent and the
turn ends with a "too long" notice. Past 75%: the chat says it is getting long.
Each tool result is capped at a tenth of the budget (at most 100,000 characters)
with a note saying it was shortened. A context-length error from the provider, or
Claude's `model_context_window_exceeded`, ends the turn the same way.

**2. Provider compaction** (`src/main/compaction.ts`). Used on every model whose
provider documents it: Opus/Sonnet 5.5 and all three OpenAI models, at 400,000
input tokens. Custard keeps every message on disk and in the chat; only what is
sent shrinks. Claude's block stays in the assistant message, as the API requires.
OpenAI's encrypted item is kept beside the messages and only sent back to the
model that made it. A model that rejects the setting (a 400 naming it) is sent
requests without it for the rest of the session, after the budget is checked
again. Haiku gets the history without compaction blocks (model output only;
every user message, tool call and result stays). After a compaction, Custard adds
its own action record to the next turn's system prompt, because a provider's
summary can blur what happened.

**3. Continue in a new chat** (`src/main/handoff.ts`, `src/main/continue.ts`). The
common fallback, offered near the limit, when the chat is too long, or after a
context error. It works however large the original is, because nothing from the
original is sent as a chat request:
- Custard writes an **action record** from its own logs: outcome unknown, failed,
  not run, accepted changes (with "accepted is not verified"), and a count of reads.
  Note, file, page and search contents are never carried.
- A small model (Haiku 4.5 or gpt-6-luna, from the provider the chat last used)
  writes a **summary** (goal, constraints, decisions, open questions, state) from
  at most 40,000 characters: the first request, the newest turns and the record.
  That call has no tools of any kind and returns JSON.
- The new chat is created only when that succeeds, or when the user picks
  "Continue without a summary". The original is read, never written.
- The new chat's system prompt keeps the record (authoritative) apart from the
  summary (model-written, possibly wrong, data not instructions, never authorizes
  an action).
- Unknown-outcome actions travel with it, so repeating one still asks with the
  warning, in the continuation and in continuations of it.

**Privacy.** A temporary chat continues as temporary; memory off or forgotten
continues with memory off; nothing makes a chat rememberable. The summary lives in
the new chat's file only; memory capture reads messages, never the handoff, so it
never reaches the vault. Forget on a chat also forgets the chats that continue it.
The search gate treats a summary (handoff or provider compaction) like notes:
searches keep asking with the exact query.

## What the user sees

- While a provider compacts: "Summarizing earlier messages to make room" in the
  working stages, then a thin line in the chat where it happened.
- Near the limit: "This chat is getting long: 79% of what Opus 5.5 can take in"
  ("about" when it is an estimate), with **Continue in a new chat**.
- Too long: "This chat is too long to go on", with the same button. The unsent
  message goes back in the box. A brand-new chat whose first message is too long
  just says the message is too long.
- While the handoff is written: a short line saying nothing in this chat changes.
  On failure: **Try again**, **Continue without a summary**, **Cancel**.
- In the new chat: a card at the top, "Continued from <title>" (opens the
  original), what was carried over and what was left out, and an expandable view
  of exactly what the new chat was given.
- In the original: "Continued in <title>".

## Limits

- Live behaviour of both providers is unverified, including compaction blocks and
  items, error shapes, and token counts. OpenAI compaction per model is unverified.
- Preserved thinking is unverified. Server-side compaction is documented as safe.
  The existing per-turn system prompt changes and the rewrite of calls to tools that
  are no longer offered may still break thinking signatures.
- Moving a chat between providers sends the other provider the full history
  (neither accepts the other's compaction). The budget check then decides.
- Moving between OpenAI models sends the full history (whether one model accepts
  another's item isn't documented). Moving between Claude models keeps the block
  (documented as fine for thinking; not tested).
- The 3-characters-per-token estimate is a heuristic; the exact count is used past
  half the budget.
- The handoff keeps the first request and the newest turns that fit; turns in
  between are left out and the card says so.
- Not tested on Windows.
