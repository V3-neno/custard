# Neutral chat format, B3: switch storage, and old chats

**Base: `neutral-chat-format-b2`** (draft PR #63, head d33ae84). It is the branch closest to the tip that has B2 on it: it sits on the tip of `automation-thinking-p3` (77cbdfa), which has not moved, and nothing has been merged since B2. No merge was needed. Branch: `neutral-chat-format-b3`, draft PR into `neutral-chat-format-b2`. Nothing merged.

Status: done and stopped for review. Everything below was run against local stand-ins only; nothing was sent to a live provider.

## Where the brief differs from the B1 and B2 reviews

I re-read both. The brief follows the B2 "refined B3 plan" (B3 and B4 shipped together), with these differences:

1. **What Delete removes.** B1 section 6 says Delete removes "the chat file only". The code (`index.ts`, `conversations:delete`, unchanged since before B2) also sets the chat's widget records to none, removes its attached files and its Design outputs. The brief's wording matches the code; B1 was wrong. Delete all old chats does exactly what Delete does (below).
2. **The legacy helper.** B2 said `test/neutral/legacy.ts` and `unit-histories.json` "can go" after the switch. The brief says delete them only if the goldens and round-trip cover the same cases. They don't, so I kept them (see Tests).
3. **Readers B2 listed that did not need to move.** B2 listed `fromLastCompaction` and the estimates as readers to move. In the code they work on the request (Claude messages after conversion), not the stored chat, so they stay as they are. `claudeFilesFrom` did move.
4. **Old-chat wording.** B1 had one sentence. The brief's definition of an old chat also covers an unknown version and a file that can't be parsed, so there are three wordings (below).
5. **The startup sweeps** are new in the brief. B1 and B2 did not mention them; one of them would have deleted old chats' Design outputs (Surprises).

## Changes per sub-step

| Commit | What |
| --- | --- |
| 71ece56 | Steps 1-3 in one commit: the stored type, every writer and reader, the request path, the window, the old-chat list, view and delete, and the unit tests moved to neutral builders. |
| 583abcd | Step 4: new tests. Moves the window's placement of indexed records into `shared/chatLayout.ts` and chat deletion into `main/chatDelete.ts` so both can be tested. Delete all now carries on past a chat whose cleanup fails. |
| 1ff55cb | Docs. |
| e808e01 | e2e suites read stored chats as parts. New suite `old-chats.mjs`. An old chat opened from another mode's History now shows there (found while writing the suite). |
| (last) | Stored-chat parts of the four goldens, regenerated once after the hashes matched. The e2e-data parity check skips a file it can't parse. This review. |

**Why steps 1-3 are one commit.** `Conversation.messages` changes type from Anthropic messages to `Message[]`. Every writer, reader, the adapters and about 15 unit test files fail to typecheck until all of them move, so no smaller commit builds. Each later commit builds and passes the unit tests, typecheck and eslint.

## Decisions as built

1. **Storage.** `format: 'custard-chat'`, `version: 1`, written first in the file. `messages: Message[]`. `by` on every assistant message, including a cut-off reply (`partialReply` now takes the writer). `raw` only where the blocks differ from what `parts` rebuild (`fromClaudeReply` compares `partBlocks(parts)` with the blocks).
2. **The wire.** Plain strings stay strings; rewrites (files in front, calls to tools not offered as text, compaction stripped for a model that doesn't compact) stay outgoing only, inside the converters. Request hashes are identical in every golden (below).
3. **No migration.** No migration or backup code.
4. **Old chats.** `oldReason` in `shared/neutralChat.ts`: no `format` with a `messages` array is `old`; `format: 'custard-chat'` with another version is `newer`; anything else that fails `isStoredChat` (not JSON, not an object, missing or wrong fields, an unknown part) is `unreadable`. Only the title, mode and date are read from an old file (date: `updatedAt`, or the file's time when it has none).
5. **Delete all old chats.** One button at the foot of History when there are old chats, with an inline confirmation in History's own style (no new dropdown). Details below.
6. **Claude requests** are unchanged; the thinking-binding question is untouched.
7. **No OpenAI or DeepSeek reasoning is stored**, and no provider behaviour was added.

## Files touched

Source: `shared/neutralChat.ts`, `shared/chat.ts`, `shared/chatLayout.ts` (new, moved from the window), `main/store.ts`, `main/chatDelete.ts` (new), `main/index.ts`, `main/chat.ts`, `main/turn.ts`, `main/openai.ts`, `main/adapters/{types,anthropic,responses,responsesNeutral,template}.ts`, `main/attachments/request.ts`, `main/handoff.ts`, `main/chatNotes.ts`, `main/memory/{evidence,index}.ts`, `main/web/{index,provenance}.ts`, `main/design/index.ts`, `preload/index.ts`, `renderer/.../HistoryDrawer.tsx`, `ChatView.tsx`, `MessageView.tsx`, `chat/OldChat.tsx` (new).

Tests: 15 unit test files changed, 5 new (`shared/neutralChat.test.ts`, `shared/chatLayout.test.ts`, `main/store.test.ts`, `main/indexFields.test.ts`, `main/oldChats.test.ts`), `test/neutral/builders.ts` (new). e2e: 14 suites changed, 1 new (`old-chats.mjs`), the stored-chat parts of 4 goldens.

Docs: `providers.md`, `adding-a-provider.md`, `long-chats.md`, `attachments.md`. The format comments in `adapters/types.ts`, `openai.ts`, `anthropic.ts` and `template.ts` changed with the code in 71ece56.

## Every writer and reader

Writers:

| Where | Before | Now |
| --- | --- | --- |
| The user's message (`chat.ts`) | `{role:'user', content: text}` | `userMessage(text)` |
| Claude's reply (`anthropic.ts`) | `echoableContent(blocks)` | `fromClaudeReply(echoableContent(blocks), model)` |
| A Responses reply (`openai.ts`) | `toBlocks(output)` | `fromResponsesReply(output, provider, model)`; the round's inputs come from its `toolCalls` |
| Tool results and the note (`TurnLog.closeRound`) | `tool_result` blocks plus a text block | `toolResults(results, note)`; Claude blocks still returned for the adapter's own loop |
| Cut-off text (`TurnLog.interrupt`) | a string | `partialReply(text, by)` |
| Crash repair (`repairInterrupted`) | read `tool_use` blocks | reads `toolCalls`; a partial reply is not a round |
| Unregistered template adapter | stored blocks | `toStored` returns an `AssistantMessage` |

Request path: `TurnRequest.history()` returns the stored `Message[]`, with `files` and `available` beside it. chat.ts no longer calls `withFiles` or `withoutUnavailableTools`. The Claude adapter calls `toClaudeHistory`; `runOpenAI` calls `toResponsesInput` from `openaiStart`'s index, and with `to` for the messages before a refused compaction item (new option, tested against the old slice). The within-turn Responses input is unchanged. One-shot calls (`sendMessage`) still take Claude-shaped messages, as before.

Readers (B1 section 2):

| Reader | Now reads |
| --- | --- |
| Store: list, count, mode, update, all, get | Only chats in the format; old chats as `OldChat` (title, mode, date) |
| handoff (Continue) and continue.ts | `textOf`, `isToolResults`, `toolCalls` |
| Chat notes (`userWords`, `upTo`) | `textOf(m, ' ')`; `upTo` unchanged (message count) |
| Memory evidence, watermark and job | `textOf`, `isToolResults`, `toolCalls`; ranges unchanged |
| Web (`turnActions`, `searchExposure`), provenance (`userUrls`) | `toolCalls`; text and note parts |
| Earlier chats (references) | loads through the store, which refuses old chats |
| `claudeFilesFrom` | compaction parts |
| Compaction start (`openaiStart`), `fromLastCompaction`, estimates, `claudeHistory` | unchanged: indexes, or the request after conversion |
| Widgets, Design | message count; `chatExists` is now "a chat file exists" |
| Window: `MessageView` | `messageItems(m)`: text, tool call, thinking (none for redacted), fallback; compaction shows as the chat's line |
| Window: `ChatView` | `callOutcomes`, `turnSources`, `turnProposals`, `atMessage` in `shared/chatLayout.ts` |

`textOf` joins text and note parts and counts every other part as an empty string, which is what the old readers did with blocks. It differs only for a Claude block with no part (anything but text, tool_use, thinking, redacted thinking, compaction and fallback): the old readers counted it as an empty segment, so the joined text had one more separator. No such block is stored today (chat turns offer no server tools), and handoff collapses whitespace anyway.

The index fields (notices, sources, memory watermark and job, `chatNote.upTo`, `compactions.after`, references, proposals, attachments, actions) keep working because the format keeps one message per index: every writer adds exactly the messages it added before. `indexFields.test.ts` builds a chat with TurnLog and the converters and has one test per field, each read by the code that reads it (window placement and the main-process readers).

## Old chats at each entry point

| Entry point | Behaviour | Tested |
| --- | --- | --- |
| History list | Listed with title, mode and date, marked "· Old format", no Forget. A line at the foot counts them. History's Find matches old chats by title only. | store.test, old-chats.mjs |
| Open | Title, "Old format", one sentence by reason, and Delete. No messages. An old chat from another mode opens in that mode. | old-chats.mjs |
| Send | Refused with "That chat was saved in a format this Custard can't open, so nothing was done with it." Typing in the box while an old chat is shown starts a new chat (by reading the code; not tested). | oldChats.test |
| Continue | Refused, no summary asked for. | oldChats.test |
| Reference | Picking it refuses the message, even when its note is in the vault. | oldChats.test |
| Model picker, hub offer | Refused. | oldChats.test |
| Memory capture, Forget, memory for this chat | Capture never loads it; the two memory handlers refuse it. | oldChats.test |
| Chat note | Never loads it, never queues it. | oldChats.test |
| Search | `chats_search` and `chats_read` read notes in the vault, not chat files; an old chat's note from before B3 stays readable there (the brief says not to touch notes). Links between chats (`allConversations`) leave old chats out. | oldChats.test |
| Delete | As before: chat file, widget records, attached files, Design outputs. | store.test, old-chats.mjs |
| Delete all | Below. | store.test, old-chats.mjs |

Nothing crashes or half-loads: `isStoredChat` checks every message and part, so a file that fails anywhere is an old chat as a whole. `updateConversation` returns null for an old chat and writes nothing.

The three wordings: "This chat was saved by an earlier Custard and can't be opened. Delete it to remove it." / "This chat was saved by a newer Custard than this one and can't be opened here. Delete it to remove it." / "This chat's file can't be read, so it can't be opened. Delete it to remove it."

## Delete all old chats

`deleteOldChats` (`main/chatDelete.ts`) runs today's per-chat delete for each id from `oldChatIds()`. Exactly, for each old chat:

1. `deleteConversation`: the chat file.
2. `widgets().conversationDeleted`: unmounts its widget if shown, and sets its widget records to none.
3. `attachments().deleteChat`: removes `attachments/<chat id>/`.
4. `designChatDeleted`: its stored image results, Design artifacts, jobs, authorizations and job-store entries.

It does not touch the vault (memory, notes in Custard/Chats, captures), usage totals or settings. A chat whose cleanup throws is left and reported in the log; the others still go. The confirmation reads: "Delete all N old chats? For each one, Custard deletes the chat file, its attached files, its Design outputs and its widget records. Your memory, the notes in Custard/Chats, captures, usage totals and settings stay as they are. This can't be undone." Buttons: "Delete N old chats" and "Keep them".

It also deletes `newer` and `unreadable` files, since the brief defines them as old chats.

## The startup sweeps

- **Attachments** (`attachments/index.ts`): removes `attachments/<id>/` for any id not in `conversationIds()`, which comes from the file names in the chats folder. An old chat's folder is kept; after a delete whose cleanup never ran, the next start removes it. Unchanged code.
- **Design** (`design/reconcile.ts`): forgets a chat's Design data when `chatExists` is false. It was `getConversation(id) !== null`, which is now false for an old chat, so it would have deleted old chats' outputs at the first start. It is now `conversationExists` (a chat file exists).

Tested in `store.test.ts` (both, with the store's own functions) and in `old-chats.mjs` (attachments, in the app).

## Request hashes and goldens

- **Request hashes: identical in every golden.** In the first full e2e run on B3 (goldens still from B2), every `requests identical` check passed: 52 of 52 across `claude-turn` ×3 and `responses-turn`. Only the `chat` part and the `events` part (the done event's `conversation`) differed. Comparing each golden with that run's record without those two keys: 36 + 36 + 36 + 48 parts, 0 differ.
- **round-trip:** all its request checks pass, as before, plus 5 new checks on the stored chat (below).
- **Regenerated once** with `--update`, one suite at a time, then run again without it: 61, 61, 61 and 98 checks, 0 failures (the same counts as B2).
- **The stored-chat diff is exactly the format change.** For every scenario of the four goldens (12 + 12 + 12 + 16), the B2 golden's `chat.messages` turned into the new format by the B2 legacy converter equals the new golden's `chat.messages`, and `notices` and `actions` are byte-identical. One scenario (`claude-turn`, `tool`), before and after (ids are the golden's numbering):

  Before: `{"role":"user","content":"ct plain: go"}, {"role":"assistant","content":[{"type":"thinking","thinking":"Thinking it over.","signature":"sig"},{"type":"text","text":"Hello there."}]}, ... {"role":"assistant","content":[{"type":"text","text":"Looking."},{"type":"tool_use","id":"#3","name":"vault_list","input":{}}]}, {"role":"user","content":[{"type":"tool_result","tool_use_id":"#3","content":"Archive/...","is_error":false}]}`

  After: `{"role":"user","parts":[{"type":"text","text":"ct plain: go"}]}, {"role":"assistant","parts":[{"type":"thinking","text":"Thinking it over."},{"type":"text","text":"Hello there."}],"by":{"provider":"claude","model":"claude-opus-5-5"},"raw":{"provider":"claude","model":"claude-opus-5-5","blocks":[...the same two blocks...]}}, ... {"role":"assistant","parts":[{"type":"text","text":"Looking."},{"type":"tool_call","id":"#3","name":"vault_list","input":{}}],"by":{...}}, {"role":"user","parts":[{"type":"tool_result","callId":"#3","text":"Archive/...","isError":false}]}`

  The full diff is the PR's change to the four `*.golden.json` files.
- **The B2 parity tests, run one last time against the new storage** (`neutral.test.ts`, with `NEUTRAL_E2E_DIR` set to the full run): the goldens' stored chats (now neutral) 52 histories, 184,632 requests compared; the unit-test histories 172 (15,456 requests, and 74,340 with `is_error` added); the named cases, now built with TurnLog and the converters, 3,360 requests; every stored chat from the e2e run, 110 histories, 100,044 requests, all in a stored shape; logged request bodies 124 of 187 rebuilt byte for byte, 0 rebuilt differently (the same 124 of 187 as B2; the other 63 are within-turn Responses requests and other bodies not built from a stored chat, as in B2). 0 mismatches anywhere.

**`legacy.ts` and `unit-histories.json` are kept.** The goldens and round-trip cover 52 stored histories from four suites; the unit histories cover 172 more, from 10 test files, including `attachments/request.test` (files on earlier messages) and `history.test` (calls to tools no longer offered), which no golden scenario stores. The old wire path they compare against (`withFiles`, `withoutUnavailableTools`, `claudeHistory`, `toInput`) still exists, because one-shot calls use it, so the comparison stays meaningful.

## Tests against the baselines

| | Baseline (B2 tip) | B3 |
| --- | --- | --- |
| Unit | 1,333 passed, 2 skipped, 83 files | 1,378 passed, 2 skipped, 88 files (+45 new tests, 0 failures) |
| e2e | 49 suites, 1,582 checks, 0 failures | 50 suites, 1,624 checks, 0 failures |
| Typecheck (node, web) | clean | clean |
| eslint src and test | clean | clean |

e2e difference: `old-chats` is new (37 checks) and `round-trip` went from 33 to 38 (the stored-chat check now looks at `raw` blocks and parts separately, and checks only Claude replies have `raw`). Every other suite has the same count as the baseline.

How it was run: `npm run build`, then every suite one at a time (`e2e-run.sh`), never alongside the unit tests. In that run:
- `claude-turn` ×3 and `responses-turn` failed only on the stored-chat parts, as expected before regenerating; after regenerating they were run again, alone, and passed.
- `media-sizes` failed 9 checks ("saved", "renders at full size", "says so", "says why"); run again alone it passed all 41. Recorded as a failure under the full run that I did not reproduce; it doesn't touch stored chats.
- `old-chats` stopped at its own bug (it parsed the unreadable file it had written); fixed, run alone, 37 of 37.

An earlier attempt was discarded: I stopped a discovery run part way and a stand-in server it had started kept the port, so the next run's first suites talked to it. I stopped everything and ran all 50 again from the start; the numbers above are from that run.

**Unit tests moved to neutral builders:** 15 test files, about 62 test bodies edited directly, plus shared helpers in `memory.test`, `chatNotes.test`, `earlierChats.test`, `propose.test` and `continuity.test` that build chats for many more. No test was deleted or skipped. The number of `expect(` calls went up or stayed the same in every one of those files (for example `turn.test` 64 to 68, `request.test` 58 to 60, `neutral.test` 28 to 33). Wire-level assertions (what a request carries) stayed literal Claude or Responses objects.

**New tests:** `neutralChat.test` (7: new, old, unknown version, not JSON, missing fields, valid JSON but not a chat, a directory of many old chats and one new one), `chatLayout.test` (every part type in the window), `indexFields.test` (one per index field), `store.test` (listing, reading, refusing to update, delete, delete all, both sweeps), `oldChats.test` (each entry point, with the app's own handlers), and in `neutral.test` the refused-compaction range and the cut-off reply's writer.

## Screenshots

In `/mnt/project-files/custard/providers/b3-screenshots/` (from `old-chats.mjs`). What I looked at:

- `old-chats-02-history.png`: History with one new chat and four old ones (an earlier Custard's, a newer version, an unreadable file listed as "Untitled chat", an old Design chat). Old rows read "· Old format" in the row's own grey; the foot says "4 old chats can't be opened." with the button in Settings' danger style.
- `old-chats-03-open.png`: the old-chat view, centred like the empty-chat view: "OLD FORMAT", the title, the sentence, Delete.
- `old-chats-04-delete-all.png`: the confirmation at History's foot, with the count, what goes, what stays, "Delete 3 old chats" and "Keep them".
- `old-chats-01-normal-before.png`, `old-chats-05-normal-after.png`: a normal chat before and after Delete all, carrying on in the same chat.

## Surprises

- **The Design sweep** (above) would have deleted old chats' outputs at startup.
- **An old chat from another mode** opened from History switched modes and showed an empty chat; fixed in e808e01.
- **The template adapter** no longer sends stale-tool or file text, since its `historyWire` reads parts. It is unregistered and never called; its PROVIDER-SPECIFIC comments say what a real adapter must do.
- **Delete all and one bad id.** `attachments().deleteChat` throws on an id it doesn't accept; one such file would have stopped the loop part way. It now carries on.
- **The golden id numbering** is global across a run, so the stored part's `callId` had to be numbered like `tool_use_id`, or an id first seen in a stored result would shift every later request's numbering.

## What I chose not to do

- No migration, no backup (decision 3).
- No confirmation on the old-chat view's Delete, matching History's Delete.
- `legacy.ts` and `unit-histories.json` kept (Tests).
- Search does not hide an old chat's existing note in the vault.
- The thinking-binding fix, OpenAI/DeepSeek reasoning, models.json, plugin/spotify, the dropdown redesign.

**Effect on the binding question.** Easier: a Claude reply's blocks are now stored apart from the parts, with `by`, so a fix can decide per message which model's thinking goes back, and to whom, in one place (`toClaudeHistory`). Unchanged: Claude still gets its own `raw` blocks back exactly as before, so the open question (whether thinking from one Claude model binds to another) is where it was.

## Not verified

- Claude accepting its own thinking blocks back after other providers' turns.
- Whether the live API adds fields to Claude's blocks (decides how often `raw` is kept).
- The binding question.
- OpenAI refusal parts in one-shot calls.
- DeepSeek's too-long wording.
- Windows.
- Everything here ran against stand-ins: the unit tests, and the e2e suites against local mock servers.
