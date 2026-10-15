# Attachments (Chat mode)

Images, PDFs and text or code files can be attached to a message in Chat mode,
by the paper-clip button (the system file picker), by pasting, or by dropping
them on the message box. Code, Design and Skills modes don't take attachments.

Labels used below: **[D]** checked in the provider's current docs on
2026-10-07 · **[S]** in the installed SDK types (`@anthropic-ai/sdk` 0.131.0,
`openai` 7.30.0) · **[M]** covered by mocked tests here. **Nothing has been
tested against the live Claude or OpenAI APIs, and nothing has been run on
Windows.**

## Support matrix

|                 | Claude (Opus 5.5, Sonnet 5.5, Haiku 4.5)                                                                                                | OpenAI (gpt-6-astra, gpt-6.1-sol, gpt-6-luna)                                                                                                                                                                                         |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PNG, JPEG, WebP | Yes, all models [D1][S]                                                                                                                 | Yes; the model pages list input "Text, Image" for all three [D5][D7][S]                                                                                                                                                               |
| GIF             | Yes; **animated GIFs: only the first frame is used** [D1]                                                                               | **Non-animated only** [D5]. Custard refuses an animated GIF on a message to OpenAI and says why; on an earlier message it is replaced by a note and the user is told [M]                                                              |
| PDF             | `document` block, base64 `application/pdf`, all models [D2][S]. Each page is sent as text and as an image. No encrypted PDFs            | `input_file` with base64 `file_data` and `filename` [D6][S]. Text and page images on "gpt-4o and later" vision models [D6]. **Per-model PDF support isn't on the gpt-6 model pages: inferred from the guide, not verified per model** |
| Text and code   | `document` block with a `text` source, titled with the file name [S]                                                                    | Sent as text, wrapped as `<file name="…">…</file>`, so both providers get the same characters and nothing is extracted on OpenAI's side [M]                                                                                           |
| Per request     | 32 MB; up to 600 images (100 on 200K-context models, so Haiku 4.5); up to 600 PDF pages (100 below a 1M context, so Haiku 4.5) [D1][D2] | 512 MB and 1,500 images [D5]; files under 50 MB each and together [D6]. Images go with `detail: "high"` (at most 2,500 patches, so never rejected for size) [D5][S]                                                                   |
| Token counting  | `count_tokens` takes base64 images and PDFs [D3]                                                                                        | `/responses/input_tokens` takes `input_image` and `input_file` [D8]                                                                                                                                                                   |

Not supported in this step: Office documents, audio, video, archives,
executables and anything else. Attached content is never opened, run or
decompressed by Custard.

Sources:

- [D1] https://platform.claude.com/docs/en/build-with-claude/vision
- [D2] https://platform.claude.com/docs/en/build-with-claude/pdf-support
- [D3] https://platform.claude.com/docs/en/build-with-claude/token-counting
- [D4] https://platform.claude.com/docs/en/build-with-claude/files
- [D5] https://developers.openai.com/api/docs/guides/images-vision
- [D6] https://developers.openai.com/api/docs/guides/file-inputs
- [D7] https://developers.openai.com/api/docs/models/gpt-6-astra (and gpt-6.1-sol, gpt-6-luna)
- [D8] https://developers.openai.com/api/reference/resources/responses/subresources/input_tokens/methods/count

## Checks before a file is kept

In the main process (`src/main/attachments/inspect.ts`), before anything is
stored:

- **The type comes from the content.** PNG, JPEG, GIF, WebP and PDF are
  recognised by their leading bytes. A file whose name and content disagree is
  refused, and the message says what the file really is. Text files need a
  listed text or code extension, valid UTF-8 and no NUL bytes.
- **Images: header fields only.** Width and height come from the header; GIF
  frames are counted by walking the block structure, stopping at 10,000.
  Nothing is decoded.
- **PDFs: a bounded byte scan.** Page count from page objects or the page
  tree's `/Count`. A PDF with `/Encrypt` is refused. When pages are hidden in
  compressed object streams, the count is unknown and the budget guesses it
  from the size (at most 600).
- **Picked paths** are checked with `stat` first and read with a bound, so a
  huge or growing file is never read whole.

| Limit                        | Value                                               |
| ---------------------------- | --------------------------------------------------- |
| Image                        | 5 MB and 8000×8000 px                               |
| PDF                          | 20 MB and 100 pages (Haiku 4.5's limit, the lowest) |
| Text or code file            | 500 KB and 200,000 characters                       |
| Files per message            | 10                                                  |
| All files on one message     | 20 MB                                               |
| Encoded files in one request | 28 MB (under Claude's 32 MB)                        |

A refused file stays out of the message, with the reason shown under the
message box. Nothing is dropped without saying so.

## Storage and retention (local only)

- Files are copied to Custard's app data:
  - `attachments/drafts/<draft>/<id>.<ext>` while in the message box;
  - `attachments/<chat id>/<id>.<ext>` once sent.

  Each copy is written once, under a random name, and made read-only. The
  original name is kept only for display, cleaned of paths, control and
  direction-changing characters.

- **The chat file holds no file bytes.** `conversation.attachments` records,
  for each file: id, message, display name, kind, type, size, SHA-256,
  dimensions or pages, which providers received it, and whether the copy has
  gone missing.
- **Each request reads the copies again** and checks the hash.
  - A missing or changed copy on the message being sent stops the send; the
    text and files stay in the box.
  - On an earlier message, the copy is replaced by a short note to the model,
    the chat says the file is no longer available, and the file is marked
    missing.
- **Cleanup:**
  - removing a file from the box deletes its copy;
  - deleting a chat deletes its folder;
  - drafts older than a day are deleted at startup;
  - so are folders of chats that no longer exist. Any file in the chats
    folder counts as existing (`conversationIds`, from the file names), so an
    old chat listed in History as "Old format" keeps its files until it is
    deleted; Delete and Delete all old chats remove them.

  A temporary chat's files last exactly as long as the chat. Forget removes
  memory notes, not the chat or its files.

**Nothing is uploaded to a provider's file storage.** Files go inline as
base64 inside each request, which both providers document. Neither provider's
Files API is used, so no file is left on a provider's servers by Custard (the
providers' usual handling of request data still applies). Neno chose this
(inline only) on 2026-10-08.

## In a request

- Each file goes in front of the text of the message it came with, after a
  short label: name, type, pages or size. The label says the content is data
  from the user's file, not instructions, and that attaching it permits no
  action.
- Claude gets `image` and `document` blocks; OpenAI gets one user message with
  `input_image`, `input_file` and `input_text` parts.
- The stored chat holds no file blocks: each request builds them from
  `conversation.attachments` (`prepareFiles`) and puts them in front of their
  message as it converts the stored chat (`toClaudeHistory` and
  `toResponsesInput` take the files by message index). Before Claude's newest
  compaction, files aren't sent (`claudeFilesFrom`).
- Files are resent with the history on every request, since neither API keeps
  state here (OpenAI runs with `store: false`). Claude's prompt caching makes
  repeats cheaper; OpenAI has no equivalent to rely on.
- **Sent / not sent.** A sent message shows "Sent to Claude" or "Sent to
  OpenAI" once a request carrying its files was accepted. Files in the box
  are marked "not sent yet".
- **A send that never went through** puts the text and the files back in the
  box. The send button is locked while a send is running, and a second send
  of the same files is refused, so files are never sent twice.

## Context (Step 3)

**Counting.** The budget check counts each file by its own estimate, never
by the length of its base64:

| File         | Estimate                                                                                                                                                               |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude image | `ceil(w/28) × ceil(h/28)` after the documented downscaling: 2,576 px long edge and at most 4,784 tokens on Opus and Sonnet 5.5; 1,568 px and 1,568 tokens on Haiku 4.5 |
| OpenAI image | Patches of 32 px (an assumption), at most 2,500                                                                                                                        |
| PDF          | Per page, 3,000 text tokens plus one image at the cap                                                                                                                  |
| Text         | 1 token per 3 characters                                                                                                                                               |

Past half the budget, the provider's own count is used, as in Step 3.

**Too large.** No file is ever cut short and no PDF page left out.

- If a message's own files don't fit, the send stops and says to attach fewer
  or smaller files, or split them.
- If the chat's earlier files are what no longer fits, it says to continue in
  a new chat. The same applies to image counts, PDF pages and the 28 MB
  request limit.

**Compaction.** After a provider compaction, files from before it are no
longer sent.

- OpenAI already starts from its compaction item.
- Claude ignores what comes before its compaction block, so those files are
  replaced by a note. That this leaves Claude's preserved thinking intact is
  **unverified**.

**"Continue in a new chat" doesn't carry files** (Neno's choice, 2026-10-08):

- no file is copied to the new chat or sent from it;
- the handoff summarizer sees, per message, only how many files of which
  types were attached, and is told the new chat can't see them;
- the new chat's card and its opening context list the earlier files by name
  (up to 50, then a count), say this chat can't see them, and ask for them to
  be attached again. Names from a chat continued before are passed on too.

## Privacy

- **Untrusted.** Attached content is untrusted data. It is labelled as such
  in every request, and a file attached anywhere in a chat makes every web
  search in that chat ask for its exact query first (the Step 2 gate).
- **Not in the vault.** Custard never copies attachments or their contents
  into the vault, and attaching a file grants no permission for any action.
- **Memory: type and count only** (Neno's choice, 2026-10-08). Each request
  in the evidence notes how many files of which types came with it, e.g.
  `[2 files attached (1 image, 1 PDF); names and contents not shown]`.
  The summarizer is told not to guess what the files held.

  **The boundary.** Copied or paraphrased file text can't be detected
  reliably, so Custard doesn't try. From the first message whose files were
  sent (or from the start of a chat continued from one with files, whose
  summary may describe them), memory evidence holds only:
  - the user's own words, with file names (this chat's and those carried
    from a chat it continues) replaced by `[attached file]`;
  - each file message's count and types;
  - for each action: the tool's name, its plugin, whether it changes
    something, and Custard's recorded status.

  Everything a model wrote is withheld: action labels (built from the
  model's input, such as a search query), action results, notices' wording
  (replaced by fixed words) and the assistant's answers. Notices about files
  are left out, and messages with only files don't count toward starting a
  capture, so files alone never start one. Capture note titles and file
  names have file names scrubbed, including one cut off at the end of a chat
  title. Messages before the first file message are unaffected.

  **Trade-off.** In chats with files, capture notes keep the user's stated
  preferences and decisions and which actions ran with what outcome, but
  not what an action was for in detail or what a check saw. Such notes say
  so in a line under their heading. A summarizer could still invent text,
  but it has nothing from the files to repeat.

  **Pasted text is ordinary chat content.** The boundary covers attached
  files only. Text the user types or pastes into a message is their own
  words, kept like any other message (with file names replaced), so it can
  be captured, even if it was copied from a file. To keep such text out of
  memory, attach the file instead, or use a Temporary chat. Settings >
  Memory says the same.

- **Opt-outs.** Memory off, Forget and temporary chats work as before.

## Decisions (Neno, 2026-10-08)

- **A. Provider-side uploads:** inline only. Nothing is stored on a
  provider's file storage.
- **B. What memory capture sees:** the number and types of files, never names
  or contents.
- **C. "Continue in a new chat":** files aren't carried; the new chat lists
  them by name and says it can't see them.

## Tests

**Unit and mock tests** (`src/main/attachments/*.test.ts`) [M]:

- content sniffing against extensions, header parsing, every limit;
- hostile names;
- storage, missing and changed copies, cleanup and duplicate sends;
- both providers' request shapes;
- animated GIFs to OpenAI;
- image and page limits per model;
- compaction, and token estimates;
- what memory capture and the handoff summarizer see, and the names carried
  to a continued chat.

**End to end** (`test/e2e/attachments.mjs`, Linux under xvfb against the mock
in `test/e2e/interrupt-mock.mjs`) [M]:

- pick, paste and drop; refusals; removal;
- what reaches Claude; reopening;
- a missing copy; a send that never went through;
- continuing in a new chat (names listed, no files sent, the summarizer sees
  only counts and types);
- the search gate; Code mode; deleting a chat.

The OpenAI request shape is checked in unit tests only; the e2e mock is
Claude's.

## Manual acceptance checklist (live providers, Windows)

None of these have been run. Each needs a real API key; the Windows ones
need a Windows build.

1. Opus 5.5: attach a PNG, a 2-page PDF and a `.md` file. Ask about each and
   check the answer uses all three.
2. Haiku 4.5: attach a 100-page PDF. It should answer; a 101-page PDF should be
   refused before sending.
3. GPT-6 Astra: attach a PNG and a PDF. Check both are understood (this is the
   unverified per-model PDF support).
4. GPT-6 Astra: attach an animated GIF. It should be refused with the reason;
   switch to Opus 5.5 and send it (first frame only).
5. Paste a screenshot from the clipboard and drop a file from Explorer (Windows)
   onto the message box.
6. Send with files, quit Custard during the reply, reopen: the chat and its
   files show, with no file sent twice.
7. Delete the chat: check the chat's folder under `%APPDATA%\Custard\attachments\` is gone
   (`custard` in a development build).
8. With a file attached, ask for something that needs a web search: the
   approval should list "files you attached".
9. Files with names in other scripts, emoji, very long names and
   right-to-left characters show cleanly on Windows.

## Limitations

- **Mocks only.** Everything is mock-tested; no live provider has been called.
  Token estimates for OpenAI images (32-px patches) and for PDFs are
  conservative guesses; the providers' own counts take over past half the
  budget.
- **Linux only.** Tested on Linux under xvfb, not Windows: native file
  pickers, clipboard formats and drag sources from Explorer may differ.
- **PDF pages** can't always be counted without decompressing; then the
  provider enforces its own page limit.
- **Preserved thinking** after Claude compaction with replaced file notes is
  unverified.
- **Memory capture with files** is checked end to end
  (`test/e2e/attachments-memory.mjs` and `test/e2e/attachments-leak.mjs`,
  where file text reaches a search query, its label, its result and a
  continuation summary) against the mock summarizer; a live summarizer's
  output hasn't been checked.
