# Filesystem writes (stabilization 2.2, 2.3)

Every place Custard's main process creates, replaces or deletes files, what
protects it, and what is and isn't verified. Written 2026-10-09 on
`claude/stab-2-persistence` (from design-integration 9701117).

**Trust levels**

- **Private app data**: Custard's own folder (Electron `userData`). Only
  Custard writes there; another program running as the same OS user could,
  but it could then also change Custard itself, so that is out of scope.
- **Vault**: the user's Obsidian vault. Obsidian, sync tools and the user
  edit it at the same time, and the model chooses note paths. Links inside it
  are allowed only when they stay inside the real vault.
- **User-chosen**: any folder the user picks in a save dialog (export).
  It may be shared with other OS users (a shared drive, `/tmp`).

**Protections** (`src/main/fsafe`)

- `writeNew`/`writeNewSync`: real parent resolved, real target checked by a
  guard, exclusive create that doesn't follow a link at the name, identity
  re-checked before any byte is written, content written through the handle.
- `writeReplace`: the same into a fresh file beside the target, then rename
  over it (replaces a link instead of following it).
- `makeDirs`: in place of `mkdir -p`. One level at a time from a real base;
  each level, new or existing, must be a real folder at the expected real
  path, or a link whose real target the guard allows.

## Table

| Caller | Destination (trust) | Protection | Links / junctions | Race limits | Verified on |
| --- | --- | --- | --- | --- | --- |
| Export, single file (`design/html/export.ts`) | User-chosen | `writeNew`, or `writeReplace` after the user confirms; guard = Custard's protected places, checked on the path as written and on its real place | A link at the name is refused (new) or replaced (replace); a linked folder is judged by its real place | D3 residual (below) | Linux (unit, `design-workspace.mjs`) |
| Export, folder | User-chosen | Top folder: `mkdir` (not `-p`), then its real path must equal parent's real path + name and pass the guard. **Subfolders: `makeDirs` (was `mkdir -p`)**. Files: `writeNew`. A failed export removes the folder it made | As above | A stray empty folder is possible under a swap-and-undo race (below) | Linux |
| `vault_create_note` (`vault.ts create`) | Vault | `resolveInVault` (no `..`, no hidden folders, `.md` only, links must stay inside), then **`makeDirs` (was `fsp.mkdir -p`)** and `writeNew`, both with guard = inside the real vault + the mode's skills/plugin/app protection | Links inside the vault followed only where the real target passes the guard | D3 residual | Linux (`vault.test.ts`, `vault.mjs`) |
| Memory captures (`memory/write.ts writeCapture`) | Vault (`Custard/Captures`, plugin folders) | **Now `makeDirs` + `writeNewSync`** (was `mkdir -p` + `writeFileSync wx`), guard = inside the real vault | As above | D3 residual | Linux (`memory.mjs`, unit) |
| Vault id (`memory/write.ts vaultId`) | Vault (`Custard/.custard-vault-id`) | **Now `makeDirs` + `writeNewSync`** (was `mkdir -p` + `wx`) | As above | D3 residual | Linux |
| Forget a chat's captures (`memory/write.ts deleteNotes`) | Vault | `resolveInVault`, then **unlink by the real parent folder, checked inside the real vault just before** (was `rmSync` by path). A link at the note is removed, not followed | Linked parent followed only inside the vault | Check-then-unlink: a swap in that instant could remove a same-named file elsewhere in the vault's real tree | Linux (unit) |
| Plugin Overview note (`memory/plugins.ts ensurePluginFolder`) | Vault | `resolveInVault`, `mkdir -p`, `writeFileSync wx` | `wx` refuses a link at the name; `mkdir -p` follows a swapped parent | **Not moved yet** (file outside this thread; request to the integration owner) | Linux |
| Starter vault / starter skills (`vaultTemplate.ts`) | User-chosen folder / Vault | `mkdir -p`, `wx` for notes; `.obsidian` config written plainly into a folder Custard just created | Follows links | Runs only on the user's explicit action; not changed in this batch | Linux |
| Design version files (`design/store.ts writeFiles`) | Private app data | IDs and file paths validated (`safeFilePath`); **files written into a staging folder and renamed into place (new)**; files `wx`, read-only; a settled version refused (new) | Not expected in app data | Out of scope (same-user tampering) | Linux (unit) |
| Design indexes (`artifacts.json`, `jobs.json`) | Private app data | `writeSettingsFile`: temp file + rename | — | **No fsync** before rename: a power cut (not a process crash) can lose the last change on some filesystems. `settingsFile.ts` isn't this thread's | Linux |
| OpenAI image results (`images/results.ts`) | Private app data | **Whole entry written in a staging folder (both files fsynced), renamed into place, folder fsynced (new)**; 0700/0600, `wx` | — | — | Linux (unit) |
| Attachments (`attachments/store.ts`) | Private app data | Content-addressed, `wx` | — | Not changed in this batch | Linux |
| Conversations, settings, API keys | Private app data | Temp + rename; keys encrypted with `safeStorage` | — | Not changed | Linux |
| Code workspace tools (`workspace/tools.ts`) | User's code folder (Code mode only) | Own boundary checks; folders one at a time | Re-checked per level | Not Chat/Design; not changed in this batch | Linux |
| Deletes: chat data (`store.ts deleteChat`, results `remove`, staging cleanup) | Private app data | `rmSync` recursive on validated IDs | — | Out of scope | Linux |

## D3 residual risk after 2.3

**Attacker preconditions.** Another program (or another OS user with write
access to the destination, such as a shared export folder) must swap a folder
on the path for a link to a place of its choosing, and swap it back, inside a
window of a few system calls while Custard is writing. A link placed in
advance is always caught. A program running as the same user can already
write those places directly, so the race only adds something against a
*different* user who can write the destination folder.

**Possible effects.**

| Effect | Linux | macOS | Windows |
| --- | --- | --- | --- |
| Content written to the wrong place | Never (written through the checked handle) | Never (same code, not run) | Never (same code, not run) |
| An **empty file** with Custard's chosen name left where the link pointed | **Removed** through `/proc/self/fd` (tested) | Possible (no way to find it from Node) | Possible; NTFS junctions not run |
| An **empty folder** left where the link pointed (`makeDirs`, export top folder) | Possible | Possible | Possible |
| Removing a stray file removes a different file | Only an empty file with the same name, only if swapped again in the instant between the identity check and unlink | Same | Same |

**Alternatives** (none taken; each needs Neno's call):

1. Accept the residual above (recommended: low impact, no new dependency).
2. A native addon with `openat`/`mkdirat`/`unlinkat` (Linux, macOS) and
   handle-relative `NtCreateFile` (Windows): closes the race, but adds native
   code to build and sign per platform.
3. Refuse exports into folders writable by other users (check owner and
   mode on POSIX; ACLs on Windows): removes the only realistic attacker, but
   blocks legitimate shared-drive exports and is unverified on Windows.

**Platform verification.** Everything above ran on Linux only (container,
ext4/overlay, as root for e2e). macOS and Windows behaviour (junctions,
`realpath.native`, NTFS file ids, no `O_NOFOLLOW`, read-only file deletion)
is unverified.

## Recovery and retention (2.1)

- OpenAI images stay in `design/openai-images/<remoteId>` until Design has
  stored them on their version, or the job's chat is deleted; startup prunes
  the rest. An image whose job never recorded it is matched by the job's
  idempotency key, so it is kept and recovered instead of pruned.
- A staging folder (`.staging-…`) left by a crash is finished on restart if
  complete; an incomplete one is never used and is removed once no job needs
  that id.
- A version staging folder (`<version>.partial-…`) or an unrecorded version
  folder is replaced by the next write for that pending version; otherwise it
  goes when the chat is deleted.
- Recovery records (`meta.json`, `jobs.json`) hold the job id, model, MIME
  type, name and times: no API key (tested).
- At startup, jobs of a chat that no longer exists (deleted before Custard
  stopped) are forgotten with their outputs and stored images, so recovery
  never brings a deleted chat back. A chat file that can't be read counts as
  existing.
