# Vault tools (Step 4)

How Custard searches, reads and edits the user's Obsidian vault, and what
protects the notes. Nothing here has been tested live, on Windows, or with
Obsidian running at the same time; everything is covered by unit tests on a
real temporary folder and an end-to-end test against a mock provider.

## Search (`vault_search`, `src/main/vault/search.ts`)

The query supports:
- plain words;
- `"quoted phrases"`, matched in order across any spacing or line break;
- `folder:Projects` or `folder:"Area/Sub folder"` (also `path:`);
- `tag:music` or `#music`. These match frontmatter `tags:` (a list or inline) and
  inline `#tags`. A parent tag matches its nested tags.

Matching ignores case and accents: text is normalized to NFD and diacritics are
removed. Snippets quote the note as written.

Ranking:
1. Notes that match every word and phrase.
2. Then notes that match some, by how many. These are labelled "(k of n terms)".
3. Within each group, a match in the note's path counts most, then how often the
   terms occur (up to 20 each), then the path.

Results come 20 to a page via `page`, with the total, the range shown and how to
get the next page. Each note gets up to two snippets of about 160 characters.

The scan is asynchronous and bounded:
- 8 files are read at a time;
- notes over 2 MB are skipped and counted;
- the scan stops at 20,000 notes or 5 seconds, and says the results may be
  partial.

It never follows a link and skips hidden folders. A folder filter goes through
the same path check as every other tool.

## Reading in parts (`vault_read`, `src/main/vault/read.ts`)

Each call returns up to 40,000 characters, cut at a line break. The first line
gives:
- the note;
- its **version**, the first 12 hex characters of a SHA-256 of the whole note;
- the character range and the total;
- "more follows" or "end of note".

When more follows, the last line gives the `offset` and `version` for the next
call. If the note changed between parts, Custard says so and asks for the read to
start again from the beginning.

Each read is recorded in the chat as `vaultReads[path] = {version, ranges, at}`.
A read at a new version replaces the old record. Offsets are JavaScript string
indices (UTF-16 code units).

## Targeted edits (`vault_edit`, `src/main/vault/edit.ts`)

Input: `path`, `version`, `old_text`, `new_text`. The edit is refused, nothing
is changed, and it is recorded as **not run** with the reason, when:
- the note wasn't read in this chat, or `version` isn't the one last read;
- the note has changed since that read;
- `old_text` appears 0 times, or more than once (the count is given);
- the passage lies outside the characters that were read;
- `old_text` is the whole note, or longer than 4,000 characters;
- `new_text` is longer than 20,000 characters;
- the path is outside the vault, hidden, not a `.md` note, a link, or one of
  Custard's memory records (`Custard/Captures/…`, `Custard/Plugins/*/Activity/…`);
- the vault folder can't be reached;
- the user didn't approve.

A note with Windows line endings is matched and written with `\r\n`. There is no
tool to delete, rename, create over, or overwrite a whole note.

**Automatic memory never uses this tool.** Capture still writes one new note per
capture with exclusive create, and never writes `Memory.md`. A test checks that
no file under `src/main/memory/` refers to the edit tool or the vault tool
runner. The model is told to use `vault_edit` only for a change the user asked
for, never to save memories.

### Approval

Every edit asks, every time, on a card showing:
- the note;
- the exact text replaced;
- the replacement.

There is no "Allow for this chat". The main process enforces this, whatever the
renderer answers, and it applies even when the plugin "ask before write actions"
setting is off. If the call repeats an earlier edit whose outcome is unknown, the
same card carries that warning.

### Writing

1. **After approval.** The note is read again and hashed. If it changed while the
   card was open, the edit is not run.
2. **The copy.** The current note is written to
   `<userData>/vault-history/<vault key>/<time>-<id>-<name>.md`, in Custard's app
   data and outside the vault. That copy is local to this computer and not
   synced. If it can't be written, nothing else happens (**failed**).
3. **The new version.** It goes to a hidden temporary file next to the note,
   `.<name>.custard-<id>.tmp`.
4. **Last check.** The note is hashed once more. If it changed, the temporary
   file is removed and the edit is not run.
5. **Rename.** The temporary file is renamed over the note. If the rename fails,
   the note is unchanged (**failed**).
6. **Read back.** The note is read back. If it doesn't hash to the edit, or can't
   be read, the outcome is **unknown**. The copy is kept and its path is given.

On success, the chat's read record moves to the new version, with the ranges
shifted, so a follow-up edit doesn't need a re-read.

### Undo

Each completed edit has **Undo** under its line in the chat. Undo:
- restores the copy only if the note still hashes to exactly what the edit
  left;
- also requires the copy to still hash to the version from before the edit;
- refuses in a different vault, or while that chat is answering.

Otherwise it refuses, changes nothing, and shows where the copy is. Undo writes
the same way as an edit: temporary file, last check, rename, read back. While an
Undo runs, that chat can't start a turn. After an Undo, the chat's read of the
note is dropped. The next turn's prompt tells the model which edits were undone.

## Concurrent editing: what is and isn't protected

Custard and Obsidian (or a sync client) write the same files with no shared
lock.

**Protected:**
- An edit is never made against text the model didn't read at the current
  version. That is checked three times: when the edit is asked for, after
  approval, and just before the write.
- A crash never leaves half a note: the rename is all-or-nothing on one disk.
- A conflicting write that lands before the read-back is caught and reported as
  outcome unknown.
- The previous version is always kept, and Undo never overwrites newer work.

**Not protected (the remaining race):**
- Another program writing in the milliseconds between Custard's last check and
  the rename. One of the two writes is lost. The read-back catches this only if
  the other write lands before it.
- Obsidian holding unsaved typing in an open note and saving it over Custard's
  change, or reloading around it. Custard can't see Obsidian's editor buffer.
- Sync from another device overwriting the note or creating a conflict copy.

Atomic rename and backups don't prevent a lost update; they only make one
recoverable from the saved copy. Closing the race fully would need Obsidian to
apply the change itself, through a companion Obsidian plugin using Obsidian's own
note-update API over a local connection. That would require:
- Obsidian running;
- a second plugin, kept in step with Custard;
- a secured local IPC channel.

Even then, cross-device sync conflicts would remain. That is not built; it was
put to the user as a decision.

## Other safeguards

- **One path check** (`resolveInVault`) is used by every vault tool, the skills
  list, `Memory.md` and capture writes. It refuses anything outside the vault,
  hidden folders, and links leading out of the vault.
- **`vault_list`** shows links that stay inside the vault. It leaves out links
  that lead outside or are broken, and says how many it left out.
- **Disconnected vault.** Every vault tool first checks that the folder is
  reachable; if it isn't, the tool is recorded as not run with a plain message.
  When the vault is set but missing at the start of a turn, the model is told,
  and that the user can reconnect it in Settings.
- **Injected memory is bounded, never silently cut:**
  - `Memory.md` beyond 12,000 characters keeps its first ~4,000 and its newest
    end. A marker gives the exact character range left out and the
    `vault_read` offset to read it.
  - Capture items and older capture notes left out for length are counted, with
    how to find them.
  - Skills beyond 60 are counted, with how to list them.
- **Write outcomes**, following Step 1:
  - checks that fail before anything is written: **not run**;
  - an error before the note was touched: **failed**;
  - an error after a write may have started: **unknown**. That covers an append
    failing part way, a new note left behind by a failed create, and an edit's
    read-back.

## Tests

**Unit** (`src/main/vault/vault.test.ts`, 43 tests, on real temporary folders):
- search:
  - query parsing, ranking and partial labels;
  - phrases, folder and tag filters, accents;
  - pagination and totals, snippet bounds;
  - links and hidden folders;
  - a 5,000-note vault: at most 8 reads at once, and the event loop is never
    blocked for 250 ms;
  - the time limit and notes too large to search;
- reading: parts that join back to the note exactly, a change between parts, bad
  offsets, range merging;
- edits:
  - every refusal, with the note unchanged and no card shown;
  - CRLF, and a successful edit with its copy and carried-over read;
  - a change after approval, just before the write, and at the read-back;
  - failures of the copy, the temporary file, the rename and the read-back;
- Undo: success, an intervening edit, a different vault, a changed copy, twice,
  and a change just before its write;
- safeguards:
  - a disconnected vault for all six tools;
  - list link handling;
  - create and append outcomes;
  - the `Memory.md` bound and its offset;
  - the counts left out;
  - capture code never referring to the edit tool;
  - Step 1 statuses ("Not run:", "Outcome unknown:") and repeat protection for
    an unknown edit.

**End-to-end** (`test/e2e/vault.mjs`, 22 checks, with `test/e2e/interrupt-mock.mjs`):
- the search result through the app;
- the edit card: the exact text, and no "allow for this chat";
- an edit, its copy in app data, and no temporary file left;
- Undo;
- a note changed while the card was open;
- an Undo refused after a later change;
- a declined edit.

## Limits

- Live providers, Windows (including rename over a note Obsidian has open, which
  can fail there), and Obsidian or sync running at the same time are untested.
- The remaining race above.
- The rename gives the note new file permissions and a new inode, and drops
  extended attributes.
- Copies in `vault-history` are never cleaned up automatically.
- Search reads every note on each query; there is no index (by design: no
  database). Large vaults hit the 5-second or 20,000-note limit and say so.
- Tags are read with simple patterns, not a full YAML parser.
