# Vault tools (Step 4)

How Custard searches and reads the user's Obsidian vault, and what protects
the notes. Nothing here has been tested live, on Windows, or with Obsidian
running at the same time. Everything is covered by unit tests on a real
temporary folder and by an end-to-end test against a mock provider.

**Targeted editing is deferred, not built.** Custard's tools still only create
new notes and append to notes. Nothing is ever replaced in place, overwritten,
renamed or deleted. See "Deferred: targeted editing" below for why.

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

## Safeguards

- **One path check** (`resolveInVault`) is used by:
  - every vault tool;
  - the skills list and `Memory.md`;
  - capture writes.

  It refuses anything outside the vault, hidden folders, and links that lead out
  of the vault.
- **`vault_list`** shows links that stay inside the vault. It leaves out links
  that lead outside or are broken, and says how many.
- **Disconnected vault.** Every vault tool first checks that the folder is
  reachable. If it isn't, the call is recorded as not run with a plain message.
  When the vault is set but missing at the start of a turn, the model is told,
  along with the fact that the user can reconnect it in Settings.
- **Injected memory is bounded, never silently cut:**
  - **`Memory.md`** over 12,000 characters keeps its first ~4,000 and its newest
    end. A marker gives the exact character range left out and the `vault_read`
    offset to read it.
  - **Capture items and older capture notes** left out for length are counted,
    with how to find them (`vault_search folder:Custard/Captures`).
  - **Skills** beyond 60 are counted, with how to list them.
- **Write outcomes** (create and append) follow Step 1:
  - a check that fails before anything is written is **not run**;
  - an error before the note was touched is **failed**;
  - an error after a write may have started is **outcome unknown**. That covers
    an append failing part way, or a new note left behind by a failed create.
- **Continuity is unchanged.** Automatic memory writes one new note per capture
  with exclusive create, and never writes `Memory.md`. It doesn't go through
  the model's vault tools (a test checks this).

  Capture notes are ordinary notes. The user can edit them in Obsidian, and
  Custard reads back whatever the user wrote. Custard's own automatic writes
  never change an existing capture note.

## Deferred: targeted editing

A tool to replace one exact passage of a note was built, then taken out of this
PR before review. It is not in the code.

The reason is the cross-editor race. Custard and Obsidian (or a sync client)
write the same files with no shared lock. The design had:
- the version checked three times (when requested, after approval, and just
  before writing);
- a write to a temporary file, renamed over the note;
- a read-back;
- a copy of the previous version;
- an Undo that refused if the note had changed.

All of that reduces the risk, but none of it guarantees that a concurrent edit is
preserved:
- Another program saving between the last check and the rename loses one of the
  two changes. The read-back catches this only if that save lands before it.
- Obsidian can hold unsaved typing in an open note and save it over the edit, or
  reload around it. Custard can't see that buffer.
- Sync from another device can overwrite the note or create a conflict copy.

A saved copy of the note from before the edit would not make every such loss
recoverable:
- it holds the note as it was when Custard read it;
- it doesn't hold an external save that landed after Custard's last check;
- it doesn't hold typing that was never saved.

Closing the race would need Obsidian to apply the change itself (for example, a
companion Obsidian plugin using Obsidian's own note-update API). That is a
materially different integration. It is not being started.

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
  - create and append outcomes, recorded through the Step 1 turn log;
  - the `Memory.md` bound and its offset;
  - the counts of what was left out;
  - no edit tool offered;
  - capture code never using the vault tools.

**End-to-end** (`test/e2e/vault.mjs`, 11 checks, with `test/e2e/interrupt-mock.mjs`):
- the search result through the app (ranking, partial labels, accents);
- no note-editing tool offered;
- a long note read in two parts that join back exactly;
- nothing in the vault changes.

## Limits

- Not tested: live providers, Windows, or Obsidian or sync running at the same
  time.
- Search reads every note on each query, with no index (by design: no database).
  So:
  - large vaults reach the 5-second or 20,000-note limit, and the result says so;
  - pages aren't stable across changes or partial scans.
- Tags are read with simple patterns, not a full YAML parser.
