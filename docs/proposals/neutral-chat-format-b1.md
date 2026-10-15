# Workstream B, Phase B1 review: a provider-neutral stored chat format (investigation only)

## Base branch

**Chosen: `automation-thinking-p3` (cb8fd15), the branch of draft PR #58.** I branched `neutral-chat-format` from it. The draft PR goes into it and holds only this file. Nothing is merged.

What the repository showed on 2026-10-14:

- `main` is still a2c934b.
- The open drafts form one straight chain: main ← A1 #52 ← A2 #53 ← A3 #54 ← A4 #55 ← #56 (`automation-thinking`) ← #57 (`automation-thinking-p2`) ← #58 (`automation-thinking-p3`).
- I checked each step with `git merge-base --is-ancestor`. None of these branches is merged, and nothing newer sits on top of #58. So #58 is the tip.

## Where the brief differs from the code

- **Chats are not stored in the vault.** Each chat is one JSON file in Custard's data folder, `<userData>/conversations/<id>.json` (`store.ts:31-36`). Only the summary note (Custard/Chats) and the captures (Custard/Captures) are in the vault. Those notes are separate files and hold summaries, not messages.
- **OpenAI's compaction is not dropped on a switch, because it was never in the messages.** Its encrypted item is kept beside them, in `compactions[].item` (`shared/chat.ts:345-351`). It is sent back only to the same model (`compaction.ts:100-117`).
- **A Responses provider's reasoning is never stored at all, even for its own next turn.** It is passed back only inside one turn's tool loop (`openai.ts:292-300`). So OpenAI and DeepSeek lose their reasoning between turns today, whether or not anyone switches.
- **A live risk outside this workstream, found while answering question 5.** It may matter more than the format; see "Claude reading its blocks back" below.

## What I read

- **Read in full:**
  - `store.ts`, `shared/chat.ts`, `turn.ts`, `history.ts`, `compaction.ts`, `openai.ts`
  - `adapters/anthropic.ts`, `adapters/responses.ts`, `adapters/types.ts` (first 80 lines)
  - the round-trip e2e (`test/e2e/round-trip.mjs`, the set-up and checks)
- **Read in part:**
  - `chat.ts`: the send set-up, system prompt, tool list, history and adapter call, lines 241-520 and 960-1010
  - `attachments/request.ts:300-343`
  - `MessageView.tsx:188-228`
  - `claude-turn.mjs:340-400` (how the goldens are built)
  - `docs/providers.md:55-70`
  - Anthropic's own API guide on thinking blocks: the "preserved thinking" sections, from the API reference bundled with my tools, cached 2026-10-06
- **Through two read-only helper searches, whose findings I spot-checked:**
  - every other reader and writer listed below
  - the clean-break questions
  - The helpers read in full: `handoff.ts`, `continue.ts`, `chatNotes.ts`, `earlierChats.ts`, `memory/index.ts`, `memory/capture.ts` and `web/provenance.ts`. The rest they grepped, and the file and line references below come from them.
- **Grepped only:** the plugins, widgets, Design, preload, the other e2e suites, the unit tests and the docs.

## 1. The stored format today

`Conversation` (`shared/chat.ts:279-328`) is saved whole, as JSON, on every change (`store.ts:148-153`). It has no version field. `messages` is Anthropic's `BetaMessageParam[]`, described in the code as "exactly what is sent to the API".

**The message and block types that actually get stored:**

| Where it comes from | Stored as | Only one provider can read it? |
| --- | --- | --- |
| The user's message (`chat.ts:305`) | `{role:'user', content:'…'}`, a plain string | no |
| A Claude reply (`anthropic.ts:160`) | `{role:'assistant', content:[…]}` holding the API's blocks as returned: `text`, `thinking` (with `signature`), `redacted_thinking`, `tool_use`, `compaction`, `fallback` | thinking, redacted_thinking, compaction and fallback: yes |
| An OpenAI or DeepSeek reply (`openai.ts:150-168`) | `text` and `tool_use` only. A refusal part is stored as ordinary text. Malformed tool arguments are kept as `{__custardMalformedArguments: "…"}` | no |
| A round's tool results (`turn.ts:150-161`) | `{role:'user', content:[tool_result…, optional text note "[Custard: …]"]}`. The result content is always text | no |
| A reply cut off by Stop or a crash (`turn.ts:205`) | `{role:'assistant', content:'partial text'}`, a string | no |
| OpenAI or DeepSeek compaction (`compaction.ts:81-95`) | not in `messages`, but in `compactions[]`, as `{after, provider, model, item:{id, encrypted_content}}` | yes |
| Attached files | **Not in `messages`.** The bytes are in app data and the list is `attachments[]` with a message index. The blocks are built for each request (`attachments/request.ts:317-333`) | n/a |
| Claude's hosted web search | **Never stored.** It runs as a separate call (`web/search.ts:86-147`), and only its text result is stored, as a `tool_result` | n/a |

**A real example**, the first Claude turn of the round-trip e2e. The stand-in's blocks are at `round-trip.mjs:218-240`, and this is what Custard stores:

```json
[
  { "role": "user", "content": "round trip one" },
  { "role": "assistant", "content": [
      { "type": "thinking", "thinking": "Claude thinks again.", "signature": "sig" },
      { "type": "tool_use", "id": "toolu_list", "name": "vault_list", "input": {} } ] },
  { "role": "user", "content": [
      { "type": "tool_result", "tool_use_id": "toolu_list", "content": "…", "is_error": false } ] },
  { "role": "assistant", "content": [
      { "type": "compaction", "content": "Claude summary so far.", "encrypted_content": null },
      { "type": "fallback", "from": { "model": "claude-opus-5-5" }, "to": { "model": "claude-sonnet-5-5" }, "trigger": { "type": "refusal" } },
      { "type": "text", "text": "Claude found it." } ] }
]
```

(The real turn also has an Opus `web_search` call before this. I shortened it here.)

**Fields beside `messages` that point into it by index:**

- `notices[].after`
- `sources[].turn`
- `memory.watermark` and `memory.job.from` / `.to`
- `chatNote.upTo`
- `compactions[].after`
- `references[].message`
- `proposals[].turn`
- `attachments[].message`

`actions` is keyed by `tool_use` id.

## 2. Every reader and writer

"P" marks code that depends on Anthropic's block shapes, and would have to change.

| Area | File and lines | Reads or writes | P |
| --- | --- | --- | --- |
| Store | `store.ts:43-76` list, `86-101` count and mode, `104-113` update, `123-138` all and get, `148-157` save and delete | both | |
| Turn loop | `chat.ts:214-218` open and repair, `305` user message, `319` undo, `502-507` history for the adapter, `893-1028` save, hold and release | both | P (`history`) |
| Turn log | `turn.ts:70-77` assistant, `147-164` tool results, `172-215` notices and partial text, `218-261` crash repair | write | P |
| History for tools no longer offered | `history.ts:16-48` (outgoing copy only) | read | P |
| Files | `attachments/request.ts:317-333` `withFiles` (outgoing only), `337-343` `claudeFilesFrom` | read | P |
| Claude adapter | `anthropic.ts:45-52` `echoableContent`, `62-63` and `104` history, `159-160` store the reply, `180-197` one-shot, `284-285` history start | both | P |
| Responses adapter | `openai.ts:112-147` `toInput`, `150-168` `toBlocks`, `175-178` and `273` compaction; `responses.ts:48`, `70-73` and `95-104` | both | P |
| Unregistered template adapter | `adapters/template.ts:55-80` (it **drops tool calls entirely** on the way out) | both | P |
| Compaction | `compaction.ts:50-60` `claudeHistory`, `66-95` record, `100-117` start; `context.ts:82-90` `fromLastCompaction`, `117-131` estimate, `159-162` token count | both | P |
| Continue and handoff | `handoff.ts:46-77` and `152-203` (user and assistant text, tool_use ids; thinking is never read), `384-401` carried context; `continue.ts:41-85` | read | P |
| Chat notes | `chatNotes.ts:74-83` user words, `137` message count, `295`, `352`, `373-376` and `422` (`upTo`) | read; writes `chatNote` | P |
| Memory capture | `memory/evidence.ts:105-108` and `151-197`; `memory/capture.ts:171-175`, `484` and `505` (watermark) | read; writes `memory` | P |
| Usage and cost | `usage.ts:149-175`, which writes `c.usage` and reads no blocks | write | |
| Web | `web/index.ts:61-70` and `80-105` (tool_use ids, `sources`); `web/provenance.ts:21-43` (user text) | both | P |
| Earlier chats | `earlierChats.ts:268-307`, which loads the other chat for its mode and memory flags | read | |
| Automations | `automations/run.ts` and `automations/model.ts` build their own Anthropic-shaped messages in memory for one-shot calls. These are **never stored** in a chat | n/a | P (one-shot input) |
| Plugins | `plugins/host.ts` and `plugins/index.ts` have no message access | none | |
| Widgets | `widgets/index.ts:44`, `manager.ts:95` and `298`, which use the message count only | read | |
| Design | `design/index.ts:46`, `design/html/index.ts:60` (attachments only); `design/index.ts:128` (whether the chat exists) | read | |
| IPC and preload | `index.ts:214-227`; `preload/index.ts:244-251` (whole conversations go to the window) | both | |
| Window | `MessageView.tsx:192-226` (block switch: thinking, fallback, tool_use, text; compaction and redacted thinking are not shown); `ChatView.tsx:67`, `610-688` and `888-925` | read | P |
| Unit tests | turn, longchat, memory, request, openai, continuity, chatNotes, web and about ten more build Anthropic-shaped messages. `longchat.test.ts:318-413` pins thinking and compaction handling. There is no unit test for `echoableContent` | | P |
| e2e and goldens | `claude-turn` (×3 models), `responses-turn`, `round-trip`, and about 15 suites that read saved chat files | | P |
| Docs | `providers.md:58-67`, `adding-a-provider.md:38`, `long-chats.md:23` and `179`, `attachments.md:80` and `149`, plus comments in `types.ts:19-21`, `openai.ts:108-111`, `anthropic.ts:39-41` and `template.ts:49-52` | | |

## 3. What each provider is sent, per stored block

| Stored block | Back to Claude, same model | To another Claude model | To OpenAI or DeepSeek |
| --- | --- | --- | --- |
| user string | as is | as is | user message |
| text | as is | as is | message with that role |
| thinking, redacted_thinking | as is | **as is** (Custard doesn't strip them) | dropped (`toInput` has no case for them) |
| tool_use | as is, or as text if the tool isn't offered now | same | `function_call`, or text if the tool isn't offered |
| tool_result | as is | as is | `function_call_output` with text |
| compaction (Claude) | sent if the model compacts, stripped if not | sent if **that** model compacts | dropped |
| fallback | as is | as is | dropped |
| OpenAI compaction item | never sent | never sent | only to the model that wrote it |
| Responses reasoning | not stored | not stored | only inside one turn's tool loop |
| OpenAI refusal (stored as text) | as text | as text | as text |

**The round trip Claude Opus 5.5 → DeepSeek Flash → GPT-6 Astra → Claude Opus 5.5** is pinned by `round-trip.mjs:394-515`, against stand-ins only:

- **DeepSeek** gets no thinking, compaction, fallback or reasoning.
- **Opus's `web_search` call goes to DeepSeek as text,** because DeepSeek has no such tool. Its `vault_list` call and result go as function calls.
- **OpenAI** gets both earlier `vault_list` calls as calls. It also gets the `web_search` call as a call, because OpenAI has that tool.
- **Each Responses provider gets its own reasoning back** inside its tool loop.
- **Back on Claude,** it gets its own thinking, compaction and fallback blocks back. Every call and result, including DeepSeek's and OpenAI's, goes as Claude's own `tool_use` / `tool_result`.

**The goldens record each request in full as a hash,** plus readable parts (`claude-turn.mjs:362-387`):

- `claude-turn` covers Opus, Sonnet and Haiku, 12 cases each.
- `responses-turn` covers OpenAI and DeepSeek.
- `provider-requests` covers automation and search requests.

The `claude-turn` and `responses-turn` goldens also record **the saved chat itself**: `chat.messages`, `notices`, `actions`, and the `done` event's whole conversation.

## 4. Proposed neutral format

The idea:

- One shape that every part of Custard reads.
- A small set of neutral parts that every provider understands.
- For each assistant message, the exact blocks its provider returned, kept untouched and tagged with who wrote them.

The writing provider gets its own blocks back byte for byte. Every other provider gets the neutral parts.

```ts
type StoredChat = {
  format: 'custard-chat'
  version: 1 // the version tag: top level, read before anything else
  // ... the fields that exist today: id, mode, title, model, actions, notices,
  // sources, memory, chatNote, usage, compactions (UI facts only), attachments, ...
  messages: Message[]
}

type Message =
  | { role: 'user'; parts: UserPart[] }
  | {
      role: 'assistant'
      parts: AssistantPart[]
      // Who wrote it. Missing only for a message Custard wrote itself.
      by?: { provider: Provider; model: string }
      // Cut off by Stop or a crash: kept as the text that had streamed.
      partial?: true
      // The provider's own blocks for this message, exactly as returned,
      // sent back only to `by.provider` (see below).
      raw?: { provider: Provider; model: string; blocks: unknown[] }
    }

type UserPart =
  | { type: 'text'; text: string }
  | { type: 'tool_result'; callId: string; text: string; isError: boolean }
  // Custard's own note after a stopped round ("[Custard: ...]").
  | { type: 'note'; text: string }

type AssistantPart =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  // What the window shows for blocks only the writer can read. Never sent
  // to another provider; sent to the writer only through `raw`.
  | { type: 'thinking'; text: string }
  | { type: 'fallback'; from: string; to: string }
  | { type: 'compaction' }
```

**The parts:**

- **Text, tool calls and tool results** are the common ground. Every adapter converts them, as today.
- **A tool call and its result link by id,** as today: the result's `callId` is the call's `id`, and `actions` stays keyed by the same id. Ids keep the form the writing provider gave them (`toolu_…` from Claude, `call_…` from OpenAI). That already happens today.
- **Blocks only the writer can read sit in `raw`,** in the writer's own shape: Claude's `thinking` (with signature), `redacted_thinking`, `compaction` and `fallback`. Later, it could also hold an OpenAI reasoning item or compaction item.
- **The neutral `thinking`, `fallback` and `compaction` parts** exist so the window, chat notes and memory can read them without knowing any provider's shape. They are display copies, never sent.

**What a raw block means to its writer, and what others do with it:**

- **Claude `thinking`:** its reasoning, with a signature that ties it to the model and to the conversation before it. Other providers never see it.
  - Claude models that can't read it drop it themselves (see question 5).
- **Claude `redacted_thinking`:** the same, encrypted.
- **Claude `compaction`:** the API's summary of everything before it. On the next request, the API reads only from there on. It is sent to compacting Claude models only, as today.
- **Claude `fallback`:** an audit marker that a fallback model took over mid-reply. The API ignores it, and Anthropic's guide says to keep it or drop it. Blocks before it are already filtered (`echoableContent`).
- **OpenAI compaction item and OpenAI reasoning item:** encrypted state that only the same model may use. Today the compaction item stays in `compactions[]`. Moving it into `raw` is optional and can wait.

**Sending:**

- **To the provider that wrote a message:** the adapter sends `raw.blocks` when `raw.provider` is its own. This is today's behaviour for Claude, which sends its stored blocks as returned.
- **To any other provider:** it rebuilds the message from `parts`, leaving out display-only parts. This is today's behaviour too, because `toInput` keeps only text, tool calls and results.
- **Rewrites stay outgoing only:** the "tool no longer offered → text" rewrite and the files are applied to the copy being sent, never to the stored chat.

**Worked example 1, a plain chat:**

```json
{ "format": "custard-chat", "version": 1, "messages": [
  { "role": "user", "parts": [ { "type": "text", "text": "Hi" } ] },
  { "role": "assistant", "by": { "provider": "openai", "model": "gpt-6-astra" },
    "parts": [ { "type": "text", "text": "Hello." } ] } ] }
```

OpenAI's reply has nothing only OpenAI can read, so it has no `raw`.

**Worked example 2, a tool chat on Claude:**

```json
[
  { "role": "user", "parts": [ { "type": "text", "text": "What's in my vault?" } ] },
  { "role": "assistant", "by": { "provider": "claude", "model": "claude-opus-5-5" },
    "parts": [ { "type": "thinking", "text": "Claude thinks again." },
               { "type": "tool_call", "id": "toolu_list", "name": "vault_list", "input": {} } ],
    "raw": { "provider": "claude", "model": "claude-opus-5-5", "blocks": [
      { "type": "thinking", "thinking": "Claude thinks again.", "signature": "sig" },
      { "type": "tool_use", "id": "toolu_list", "name": "vault_list", "input": {} } ] } },
  { "role": "user", "parts": [ { "type": "tool_result", "callId": "toolu_list", "text": "…", "isError": false } ] },
  { "role": "assistant", "by": { "provider": "claude", "model": "claude-opus-5-5" },
    "parts": [ { "type": "text", "text": "You have 3 folders." } ],
    "raw": { "provider": "claude", "model": "claude-opus-5-5", "blocks": [ { "type": "text", "text": "You have 3 folders." } ] } }
]
```

**Worked example 3, a chat that switched twice (Claude → DeepSeek → Claude):**

```json
[
  { "role": "user", "parts": [ { "type": "text", "text": "round trip one" } ] },
  { "role": "assistant", "by": { "provider": "claude", "model": "claude-opus-5-5" },
    "parts": [ { "type": "compaction" }, { "type": "fallback", "from": "claude-opus-5-5", "to": "claude-sonnet-5-5" },
               { "type": "text", "text": "Claude found it." } ],
    "raw": { "provider": "claude", "model": "claude-opus-5-5", "blocks": [ "…the compaction, fallback and text blocks, as returned…" ] } },
  { "role": "user", "parts": [ { "type": "text", "text": "round trip two" } ] },
  { "role": "assistant", "by": { "provider": "deepseek", "model": "deepseek-flash" },
    "parts": [ { "type": "tool_call", "id": "call_ds1", "name": "vault_list", "input": {} } ] },
  { "role": "user", "parts": [ { "type": "tool_result", "callId": "call_ds1", "text": "…", "isError": false } ] },
  { "role": "assistant", "by": { "provider": "deepseek", "model": "deepseek-flash" },
    "parts": [ { "type": "text", "text": "DeepSeek found it." } ] },
  { "role": "user", "parts": [ { "type": "text", "text": "round trip four" } ] }
]
```

- **For the last request, Claude gets** its first reply from `raw`, unchanged. DeepSeek's turns are rebuilt from `parts` as `tool_use` and `tool_result`.
- **DeepSeek, in its turn, got** only text from Claude's reply: no compaction, fallback or thinking.
- **The result is what is sent today.**

**Two details that matter for identical requests:**

1. **Strings stay strings.** Today a typed user message and a cut-off reply are sent as plain strings, and everything else as block arrays. So a user message with exactly one `text` part, and an assistant message marked `partial`, must go out as strings. Otherwise the request bytes change, and so do the golden hashes and Claude's prompt cache.
2. **Claude's blocks keep every field the API returned.** That is why `raw` holds them as returned, rather than rebuilding them from `parts`. Today's code also echoes the returned blocks (`anthropic.ts:160`). Whether the live API adds fields the stand-ins don't is not verified.

## 5. Claude reading its blocks back

Keeping Claude's blocks unchanged is what lets Claude use them. Anthropic's current API guide says so, and also sets rules that Custard breaks today, independent of this workstream. All of the following comes from the guide; none of it is verified live.

**What the guide says (bundled API reference, cached 2026-10-06, sections "preserved thinking"):**

- **Thinking blocks are bound to the model.** An Opus 5.5 block is read only by Claude Fable 5.1 and Mythos 5.1. Any other model, including Sonnet 5.5 and Haiku, has it dropped by the API before the model sees it. The request still succeeds, and the dropped block isn't billed. The guide says to keep passing blocks back and **not** strip them yourself. Custard's current behaviour (sending them as is) fits that.
- **Thinking blocks are also bound to the conversation before them.** Opus 5.5's block records the top-level `system` prompt, the set of `tools` and every earlier message. If any of these has changed when the block is sent back, the block is invalid.
- **For accounts created on or after 31 August 2026, the conversation binding is enforced by default, and an invalid block makes the request fail with a 400.** Older accounts only see it recorded, unless they opt in. A new Claude API account for Custard would be on the enforced side.
- **Server-side compaction doesn't count as an edit.** After a compaction block, the checked conversation starts there.
- **Fallback:** blocks before the final `fallback` marker must not be echoed, and Custard already filters them. The marker itself may be kept or dropped.

**What that means for Custard, inferred from the code and not tested live:**

- **Custard rebuilds the system prompt and the tool list for every message.** The system prompt (`chat.ts:348-470`) carries today's date, vault notes, recent chats, automation questions and references. The tool list (`chat.ts:490-497`) depends on plugins, open questions and widgets. **So on an enforced account, a Claude chat whose system prompt or tools changed since an earlier Claude turn would likely get a 400 when that turn's thinking blocks are sent back.** The likely trigger is a later message on another day, or after another chat added a recent-chats line. The guide's fixes are:
  - send `thinking.block_binding.prefix_mismatch_behavior: "drop_block"` with the `thinking-binding-controls-2026-08-01` beta, so failing blocks are dropped rather than rejected; or
  - keep the system prompt and tools fixed for a chat, and append changes as mid-conversation system messages.

  **This is not part of B and is unverified, but I think it should be checked before Claude is used live.**
- **Other providers' turns in the middle** don't edit anything. They are appended, so they shouldn't break the binding by themselves. Whether Claude accepts its blocks back with another provider's turns in between is still the known unverified live item.
- **`history.ts` turns calls to tools that are no longer offered into text.** That rewrites earlier messages, so it would also invalidate later thinking blocks on an enforced account.
- **`claudeHistory` strips compaction blocks for a model that doesn't compact.** That edits history too, but the thinking is from another model and is dropped anyway.
- **What still needs a live check:**
  - the 400 itself;
  - whether `drop_block` is accepted on Custard's beta request path;
  - whether a compaction block from one Claude model is accepted by another compacting model;
  - whether a `fallback` block is accepted by a model sent without the fallback beta (Haiku 4.5, say).
- **Responses providers:** reasoning isn't stored, so nothing can be read back across turns. Storing OpenAI's encrypted reasoning in `raw` for the same model is possible later. It would change requests, so it is not in the plan below.

## 6. Old chats: clear on first launch, or show a notice

Every chat saved today has no `format` field. The new reader checks `format === 'custard-chat'` and a known `version` before treating a file as a chat. **Anything else is an "old or unknown" chat.** The reader also catches a file that can't be parsed: today `getConversation` throws on one (`store.ts:135-138`), and the window then opens nothing without a word (`ChatView.tsx:566-579`).

| | A. Clear on first launch | B. Show a notice (recommended) |
| --- | --- | --- |
| **What happens** | At startup, before anything else reads chats, delete every `conversations/*.json` that isn't the new format | History lists each old chat as "Old format". Opening it shows its title and "This chat was saved by an earlier Custard and can't be opened. Delete it to remove it." Nothing is sent from it |
| **Code** | Small: one pass at startup, plus the reader's check as a safety net | A little more: the History row, the notice view, and a guard so no send, Continue, reference or capture reads it |
| **Risk** | Deletes without asking. **Because of the existing startup sweeps, it also deletes those chats' attached files** (`attachments/index.ts:32`, which deletes folders of chats with no file) **and their Design outputs** (`design/index.ts:128`). Both are in app data, not the vault | Nothing is deleted until you choose. The old files stay on disk |
| **Old text is not rendered** | yes | yes (only the title is read) |

**What either option deletes, and what it leaves:**

- **Deleted:** the chat file only, which holds the messages plus its records: actions, notices, usage, `chatNote` and `memory` state. That is option A, or option B when you press Delete.
- **Also deleted by today's code, on the same launch or on Delete:** the chat's attachment bytes, Design outputs and widget records. Those happen in the delete handler (`index.ts:217-227`) and the startup sweeps.
- **Left alone:**
  - summary notes in Custard/Chats;
  - captures in Custard/Captures and plugin Activity notes;
  - memory and automation records;
  - usage.json, the monthly totals;
  - vault-edit records;
  - settings.
- **Do any of the left-alone files depend on the chat file?**
  - **Notes and captures are separate files.** They link back by chat id in their front matter and keep working.
  - **The summary note is never rewritten again,** because its write state lived in the chat file. Custard dequeues it (`chatNotes.ts:346-347`).
  - **History won't list chats whose file is gone,** even though their notes remain. History reads chat files only (`store.ts:59-67`).
  - **The model can still find those notes** through `chats_search` and `chats_read` (`earlierChats.ts:65-201`). But the note text tells the model to "open it from History", which no longer works.
  - **A reference to such a chat from the message box is refused** (`earlierChats.ts:289-290`).
  - **"Forget this chat" can't be reached for a deleted chat.** Its captures can only be removed by hand in Obsidian.

  All of this is already true when you delete a chat today.

**Recommendation: B.** It never deletes without your say, and it fits "never crash or half-load". It also avoids the question of whether attachments and Design outputs count as "stored message data". If you prefer A, it should run before the attachment and Design sweeps, and you should decide whether those two folders may go with the chats.

## 7. Tests and goldens

**Keeping requests identical is the proof of a behaviour-preserving change, and the existing pins already cover it:**

- the request hashes in `claude-turn` (×3), `responses-turn` and `provider-requests`;
- the request checks in `round-trip`;
- `longchat.test`.

**These must not change.**

**What would change:**

- the `chat` part and the `done` event's conversation in `claude-turn` (×3) and `responses-turn`, which record the stored format;
- about 15 e2e suites that open saved chat files and read `messages`;
- the unit tests that build Anthropic-shaped messages, listed in section 2.

**How to prove the requests stay the same:**

1. **Split each golden into "requests", which stay frozen, and "stored chat",** which is regenerated once and reviewed as a diff.
2. **Add a test-only helper** that turns today's stored messages into the neutral form. It is not migration code in the app.
3. **For every history in the goldens and in `longchat.test`,** assert that today's path and the new path produce byte-identical request bodies for Claude, OpenAI and DeepSeek.
4. **Run the full e2e suite.** Every request hash must match, and `round-trip` must still pass.

## 8. Adding a provider

**Before:**

- A new adapter reads Anthropic's blocks and has to know that `thinking`, `redacted_thinking`, `compaction` and `fallback` are not for it.
- `toInput` gets that right only because it has no branch for them.
- The unregistered template adapter shows the trap: it drops tool calls entirely (`template.ts:55-66`).
- A new Responses-API provider reuses `toInput`, so the cost is low. A provider with another API writes about 60 lines of conversion against Anthropic's types.

**After:**

- A converter handles three neutral part types: text, tool call and tool result. The rule "send `raw` only to its own provider" lives in one place.
- Claude gains a converter it doesn't have today, about 40 lines. Every other adapter's converter gets smaller.
- Profiles and models.json are unaffected: they describe models, not stored chats. The `by.model` field also gives the profile layer what it needs to say which model wrote what.

**On balance it helps,** and modestly: the conversion work per adapter is similar, but the "what is safe to send" rule is no longer each adapter's job.

## 9. Risks, plan and what to do first

**Risks:**

- **Byte-identical replay to Claude** (strings, field order, fields the API adds). This is guarded by keeping `raw` and the string rule, and checked by the request goldens. The live-API side is unverified.
- **The many index-based fields beside `messages`** (notices, sources, watermarks, upTo and the others). The format keeps one message per index, so they keep working, but every reader has to move at once.
- **The window renders blocks directly** (`MessageView`), so it has to switch in the same step as storage.
- **A wrong version check could hide new chats.** It needs a unit test for each case: new, old, unknown version, not JSON, and missing fields.
- **The Claude history-editing rule in section 5** is a live risk either way, and B doesn't fix it.

**Plan, each phase a reviewable draft PR:**

- **B2: types and converters, no behaviour change.**
  - Add the neutral types and pure converters (neutral → Claude, neutral → Responses, and reply → neutral for each).
  - Add the test-only helper and the "requests identical" tests over the goldens.
  - The app still stores the old format.
- **B3: switch storage.**
  - The turn log, the adapters and every reader in section 2 move to the neutral format.
  - The format and version tag are written, and the window renders parts.
  - Request hashes stay identical, and the stored-chat goldens are regenerated once for review.
- **B4: old chats.**
  - Your choice from section 6.
  - The reader's version check never crashes or half-loads.
  - e2e cases for an old chat, an unknown version and a corrupt file.
- **Later, only with your OK:** store OpenAI's encrypted reasoning in `raw` for the same model. This changes requests and needs a live check.

**What I recommend doing first:**

1. **Decide on section 6 (A or B).**
2. **Separately from B, decide whether to fix the history-editing risk in section 5.** The simplest fix is `drop_block` on Claude chat requests. That would need a small change and one live check, and I haven't built anything for it.
3. **Then B2.**

## Baselines on the base (cb8fd15)

| Check | Result |
| --- | --- |
| Unit | **1,304 pass**, 82 files |
| Typecheck (node and web) | clean |
| eslint `src test` | clean |
| eslint on the whole repo (`npm run lint`) | 14 errors and 531 warnings, all in `plugin/spotify/tests/*` (Neno's Spotify commit 918e9cb), none in `src` or `test` |
| e2e, suites run one at a time with nothing else running | **48 suites, 1,554 checks, 0 fail** |

My first e2e run failed to start every suite. The container's `npm ci` had removed the `playwright` package, which isn't in package.json. I installed it without saving (`npm i --no-save playwright`) and reran everything. No test failed on a real run.

## Not verified

- **Everything in section 5 about the live Claude API.** That covers the 400 on enforced accounts, `drop_block` on Custard's request path, a compaction block across Claude models, and a `fallback` block on a model without the fallback beta. It is all from Anthropic's guide, not from a request.
- **Claude accepting its own thinking blocks back after other providers' turns.** This is still open.
- **Whether `call_…` ids from OpenAI, and DeepSeek's ids, are always accepted by Claude as `tool_use` ids.** Today's code already relies on this.
- **OpenAI refusal parts in one-shot calls, DeepSeek's "too long" wording, and Windows.** These are unchanged from earlier phases.
- **Whether the live API adds fields to Claude's blocks that the stand-ins don't.** This matters for byte-identical replay.
- **Exact line counts** for the converters in section 8 are estimates.
