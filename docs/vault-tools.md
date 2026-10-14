# Vault tools

How Custard searches and reads the user's Obsidian vault, and what protects
the notes. Nothing here has been tested live, on Windows, or with Obsidian
running at the same time. Everything is covered by unit tests on a real
temporary folder and by an end-to-end test against a mock provider.

**Editing existing notes: only in folders the user allows (2026-10-12).**
By default the model can only create new notes, and each one needs the user's
approval. In Settings → Obsidian vault → **Editable folders** the user can allow
a folder with a mode: create, append or edit. Inside it, Claude changes notes
without a card for each change. Nothing is ever overwritten wholesale, renamed
or deleted. See "Editing in allowed folders" below.

**Approval and appends (hardening pass, 2026-10-08).**

- **Creating a note asks every time.** The approval card shows the note's path
  and its whole content, and "Allow for this chat" isn't offered. Notes in
  folders Custard reads into every chat (`Custard/Memory.md`,
  `Custard/Captures`, `Custard/Skills`, `Custard/Plugins`) get an extra
  warning line.
- **`vault_append` and `vault_edit` are off unless a folder is allowed** (they
  were off for everything in the hardening pass). With no allowed folder
  they are not offered, and a call to one is refused. Outside the allowed
  folders the model offers a new note instead, or asks the user to edit the
  note.
- **Links (M4).** Before any write, every part of the path below the vault is
  checked. A link must lead to something that exists inside the vault, and a
  broken link (one whose target doesn't exist yet) is refused. That covers
  model-created notes and automatic captures, at the note and at any folder
  above it. **Remaining race:** the check runs just before the write. New
  notes use exclusive create, which won't follow a link at the note itself,
  but another program swapping a parent folder for a link in between isn't
  prevented.
- **Retrieved notes stay untrusted.** Approving a note doesn't change how it
  is read later: it is still data, not instructions.
- **Automatic memory is unchanged.** It still writes one new note per capture
  with exclusive create, under its own settings and privacy rules, without
  asking.

## Search (`vault_search`, `src/main/vault/search.ts`)

The query supports:

- plain words;
- `"quoted phrases"`, matched in order across any spacing or line break;
- `folder:Projects` or `folder:"Area/Sub folder"` (also `path:`);
- `tag:music` or `#music`. These match frontmatter `tags:` (a list or inline)
  and inline `#tags`; a parent tag also matches its nested tags.

Matching ignores case and accents: text is normalized to NFD and the diacritics
are removed. Snippets quote the note as written.

Ranking:

1. Notes that match every word and phrase.
2. Then notes that match some, ordered by how many. These are labelled "(k of n
   terms)".
3. Within each group, a match in the note's path counts most, then how often the
   terms occur (up to 20 each), then the path.

Each note gets up to two snippets of about 160 characters.

The scan is asynchronous and bounded:

- 8 files are read at a time;
- notes over 2 MB are skipped and counted;
- the scan stops at 20,000 notes or after 5 seconds.

It never follows a link and skips hidden folders. A folder filter goes through
the same path check as every other tool.

### Counts, partial scans and pages

- **Complete scan.** The count is the number of matching notes in the vault (or
  folder) at the moment of the scan.
- **Partial scan.** When the scan stops at the time or note limit, the result
  says "matched … in a partial scan (not a total for the whole vault)". It gives
  how many notes were searched, and says that notes the scan didn't reach may
  also match. "No notes matched" becomes "No notes matched … in the part of the
  vault searched".
- **Pages.** Results come 20 to a page via `page`. Each page is a **new scan**;
  nothing is cached between calls. Pages are consistent with each other only
  when:
  - the vault doesn't change between calls;
  - and the scans are complete.

  If notes are added, edited or removed in between, the ranking can shift, so a
  note can appear on two pages or on none. A partial scan can stop at a
  different point each time; on a time stop that depends on disk speed. Its
  pages can then repeat or miss notes, and the result says so. The model is told
  all of this in the tool description. The way to complete results is a
  narrower query (`folder:` or more words).

## Reading in parts (`vault_read`, `src/main/vault/read.ts`)

Each call returns up to 40,000 characters, cut at a line break. The first line
gives:

- the note;
- its **version** (the first 12 hex characters of a SHA-256 of the whole note);
- the character range and the total;
- "more follows" or "end of note".

When more follows, the last line gives the `offset` and `version` for the next
call. If the note changed between parts, Custard says so and asks for the read to
start again from the beginning. Offsets are JavaScript string indices (UTF-16
code units).

The version check only detects a change between parts. It doesn't stop the note
changing afterwards, and nothing is written based on it.

**Parts that fit the cap.** A part is at most 40,000 characters, and a chat or a
run cuts a result that is too long (a chat at the model's limit, 38,760
characters for some models; a run at 40,000 characters after escaping `&`, `<`
and `>`). A cut would lose the part's last characters and its footer with the
offset to continue from, and the next part starts after them. So the caller asks
for a part that fits (`partSizeFor` in chat; a run reads again with a smaller
part until the escaped result fits), and no part is cut.

**Every cut says so.** A result Custard shortens ends with a note saying what was
left out: the chat and run caps, a plugin result over 50,000 characters, `fs_read`,
`fs_list`, `fs_search` (30 matches, or 5,000 files scanned), a web search (results
past 20, a long passage or summary) and a web page (links past 50).

## Safeguards

- **One path check** (`resolveInVault`) is used by:
  - every vault tool;
  - the skills list and `Memory.md`;
  - capture writes.

  It refuses anything outside the vault, hidden folders, links that lead out
  of the vault, `:` in a path (a Windows stream name) and Windows short names
  such as `OBSIDI~1`.

- **`vault_list`** shows links that stay inside the vault. It leaves out links
  that lead outside or are broken, and says how many.
- **Disconnected vault.** Every vault tool first checks that the folder is
  reachable. If it isn't, the call is recorded as not run with a plain message.
  When the vault is set but missing at the start of a turn, the model is told,
  along with the fact that the user can reconnect it in Settings.
- **Injected memory is bounded, never silently cut:**
  - **`Memory.md`** over 12,000 characters keeps its first ~4,000 and its newest
    end. A marker gives the exact character range left out and the `vault_read`
    offset to read it. **`Memory.md` should record a time zone name
    (`Europe/Stockholm`), not an offset (`UTC+2`)**: an offset goes out of date
    when the clocks change, and nothing in Custard rewrites a stored one (the
    chat is told the zone by name and trusts that over a note's offset).
  - **Capture items and older capture notes** left out for length are counted,
    with how to find them (`vault_search folder:Custard/Captures`).
  - **Skills** beyond 60 are counted, with how to list them.
- **Write outcomes** (note creation) follow Step 1:
  - a check that fails before anything is written is **not run**;
  - an error before the note was touched is **failed**;
  - an error after a write may have started is **outcome unknown**. That covers
    a new note left behind by a failed create.
- **Continuity is unchanged.** Automatic memory writes one new note per capture
  with exclusive create, and never writes `Memory.md`. It doesn't go through
  the model's vault tools (a test checks this).

  Capture notes are ordinary notes. The user can edit them in Obsidian, and
  Custard reads back whatever the user wrote. Custard's own automatic writes
  never change an existing capture note.

## Editing in allowed folders

**What the user controls.** Nothing is allowed by default. The user adds a
folder (inside the vault) and a mode, listed and removable in Settings. Which
folders can be allowed is the user's choice: core has no list. Modes nest:

- **create**: new notes, with no approval card, never overwriting;
- **append**: also add text to the end of an existing note (`vault_append`);
- **edit**: also change an existing note in place (`vault_edit`).

The most specific folder wins. `vault_append` and `vault_edit` are offered
only when some folder allows them, and a call outside every allowed folder is
refused with nothing written. The path is checked as given and where it really
leads, so a link inside an allowed folder can't reach a place the grants don't
cover. The mode's own protection still applies: Chat and Design can't change
skills or plugin files, whatever the grants say.

**Protected places.** A grant on a parent folder does not cover
`Custard/Skills`, `Custard/Captures`, `Custard/Chats`, `Custard/Plugins/<plugin>/Activity`,
`Custard/Plugins/<plugin>/Overview.md` or `Custard/Memory.md`. A grant covers a
folder among them only when it names that folder (or something inside it).
`Memory.md` and `Overview.md` are files, so no folder grant can name them.

**One reading of a path.** A backslash means a folder boundary on every system
(`resolveInVault` turns it into `/` first), so the grant check, the protected
places and the file system all see the same folders; on Linux and macOS a
backslash used to be a letter of a name that the grant check read as a boundary.
A folder or note name that ends in a dot or a space is refused everywhere
(Windows drops them). Protected places are matched without case. A grant covers
a path by its exact spelling where the vault's file system tells `Notes` from
`notes` apart (found by trying it on the vault, `caseSensitiveVault`), and
without case where it doesn't (Windows, usually macOS).

**`vault_edit`.** The model reads the note, then sends its `version` and a list
of at most 20 edits: replace text that appears exactly once, insert after a
heading, or append at the end. An insert after a heading lands at the end of
that heading's section, just before the next heading of the same or a higher
level (headings inside code fences don't count; the heading must appear
exactly once). Every edit is matched against the note as it was read, edits may
not overlap, and all are applied together or none are. A stale version, a note
over 200,000 characters, an edit over 20,000 characters, or an edit that would
leave the frontmatter (the leading `---` block) unclosed or with a line that
isn't `key: value` all write nothing. The frontmatter check is a heuristic,
not a YAML parser. The note is replaced with an atomic write, after the
version is checked again just before.

**Record and undo.** Each change in an allowed folder, from a chat or an automation, (including a new note)
is listed under Settings → Recent changes, with what changed. The previous
text of an appended or edited note is kept in Custard's app data (not in the
vault, so nothing hidden syncs), for the newest 200 changes (shared with automations; see automations.md). **Undo** restores
it only if the note is still exactly as the edit left it; otherwise the note
is left alone. A created note has no undo, because nothing is ever deleted.

**Accepted risk (Neno, 2026-10-12).** Custard and Obsidian (or a sync client)
still write the same files with no shared lock. The version check catches
changes already saved to disk, not typing that is unsaved in Obsidian, and
another program saving between the last check and the replace can lose one of
the two changes. Neno: there shouldn't be unsaved changes in Obsidian, so the
risk is accepted. This replaces the 2026-10-07 decision to defer editing.

**Outside text (Neno, 2026-10-12).** A page or a plugin result can carry
instructions, so in chat the no-card rule has one condition. Once a chat holds
outside text, every change inside an allowed folder (a new note, an append, an
edit) shows the approval card with what would change, for the rest of that chat:

- Outside text means a result from `web_search` or `web_read`, or from any
  plugin tool. A call that never ran doesn't count. Calls in the same round as
  such a call count, because they run together.
- A chat continued from another one counts, because it carries that chat's text.
- Reading a note counts, unless the note is `Custard/Memory.md`, a skill, a
  plugin's `Overview.md`, or in an allowed folder: any other note may hold
  something the user pasted. A search that finds something counts. This is a rule
  about where a note is, not about what it says; a granted folder the user pastes
  web text into is still trusted by it. Listing a folder doesn't count (names
  only). Captures, chat notes and plugin activity always count, even under a
  grant that names them.
- A chat shown captures that were made from a chat with outside text counts.
  New captures say so in their frontmatter (`outside: "true"` or `"false"`); a
  capture without the field (made before it existed, or edited) is treated as
  made from outside text, because nothing says it wasn't. Only captures that
  contribute a line to the prompt count.
- Chats without outside text keep no-card changes.
- A top-bar pill, "Outside text", shows when the chat on screen has some. A new
  chat clears it.
- The card is the same as for a note outside the grants: it can't be allowed for
  the whole chat, and a call that would be refused is refused without a card.
- Unattended automations are not chats and stay card-free; they rely on the
  hostile-text controls of Step 5.
- `Custard/Memory.md` can't be allowed (it is a file), and Skills, Captures and
  Chats stay protected under a parent grant. There is no way to grant them by accident.

**Capture text.** What the summarizer writes into a capture note (preferences,
decisions, titles, uncertainties, and action labels, which are cut at 300
characters) has links, `[[wikilinks]]`, HTML tags and key-shaped text removed
(`plain` in `src/main/memory/render.ts`). This is a heuristic: it removes the
address syntaxes it knows, not every way to write one.

The indicator reads the saved chat, so it can show up once the turn that brought
the text has finished. The card doesn't wait for that: it already applies within
the same turn.

## Tests

**Unit** (`src/main/vault/vault.test.ts`, 26 tests, on real temporary folders):

- search:
  - query parsing, ranking and partial labels;
  - phrases, folder and tag filters, accents;
  - pagination and totals, and snippet bounds;
  - links and hidden folders;
  - a 5,000-note vault: at most 8 reads at once, and the event loop is never
    blocked for 250 ms;
  - partial-scan labels on a time stop and on a file-limit stop, and none on a
    complete scan;
  - notes too large to search;
- reading: parts that join back into the note exactly, a change between parts,
  and bad offsets;
- safeguards:
  - a disconnected vault, for every tool;
  - list link handling;
  - create outcomes, recorded through the Step 1 turn log;
  - the `Memory.md` bound and its offset;
  - the counts of what was left out;
  - no edit tool offered (until a folder is allowed);
  - capture code never using the vault tools.

**End-to-end** (`test/e2e/vault.mjs`, 11 checks, with `test/e2e/interrupt-mock.mjs`):

- the search result through the app (ranking, partial labels, accents);
- no note-editing tool offered (until a folder is allowed);
- a long note read in two parts that join back exactly;
- nothing in the vault changes.

**Editing** (`src/main/vault/edit.test.ts`, `src/shared/vaultGrants.test.ts`,
`test/e2e/vault-edit.mjs`): grants and protected places, every edit type,
atomic failure, stale version, frontmatter, links, limits, records and undo; and
in the app, no card inside an allowed folder, refusal outside, Settings add and
remove, Recent changes and Undo, and the outside-text rule (cards with the diff
after a web page, indicator, new chat clears it). `src/shared/outsideText.test.ts`
covers what counts as outside text.

## Limits

- Not tested: live providers, Windows, or Obsidian or sync running at the same
  time.
- Search reads every note on each query, with no index (by design: no database).
  So:
  - large vaults reach the 5-second or 20,000-note limit, and the result says so;
  - pages aren't stable across changes or partial scans.
- Tags are read with simple patterns, not a full YAML parser.
