# Folder permissions, Step 2: review

Branch `folder-permissions-7yg6yb` (draft PR #60, into `automation-thinking-p3`).
Built what Neno approved on 2026-10-14: option A, extras 1 and 2, the
trailing-dot comparison bug and the stale level after a refused folder.
Left as they were: case-sensitive vault behaviour and silent lowering on re-add.

## What changed

- **Settings → Editable folders.** The dropdown is gone. Each level is a pill
  button: **New notes · Add to end · Edit text**. They are the same buttons as
  the automation effort picker. Under the picked one, a line says what it
  allows, e.g. Edit text: "New notes, adding to the end, and changing text in
  place. Includes everything Add to end allows." The intro also says "The
  levels nest". Every folder row has its own pills, so one click changes that
  folder's level and saves it (no confirmation, as you asked). The add row has
  the same pills under the folder box and Allow.
- **Stored data unchanged.** `settings.json` still holds `vaultGrants:
[{ folder, mode }]` with `create | append | edit`. Enforcement, the chat
  prompt (which lists the mode ids) and `normalizeGrants` are untouched.
- **Extra 1.** The automation form shows `Notes/ (Edit text)` instead of
  `Notes/ (edit)`.
- **Extra 2.** A new small line lists every protected place: Memory.md,
  Skills, Captures, Chats, and each plugin's Activity folder and Overview.md.
  It also says which of them can only be allowed by naming that exact folder,
  and that Memory.md and Overview.md can never be allowed.
- **Trailing dots.** The Allow box now tidies what you type the way Windows
  reads it (`Notes.` → `Notes`). It compares folders with the same key the
  saved list uses (`folderKey`), so typing `Notes.` no longer shows "That
  folder can't be allowed". A name that would become empty (`.`, `..`, `...`)
  is kept as typed, so it is still refused. Values already stored are not
  rewritten.
- **Stale level.** After every Allow, accepted or refused, the add row goes
  back to Add to end. A refused folder stays in the box so you can correct it.

## Files touched

- `src/shared/vaultGrants.ts`: labels and help in `GRANT_MODES`, `grantLabel`,
  `folderKey`, `cleanFolderInput`.
- `src/renderer/src/components/settings/EditableFolders.tsx`: pills, rows,
  help text, add flow.
- `src/renderer/src/components/settings/Automations.tsx`: level name in the
  folder choice (one line plus the import).
- `src/shared/vaultGrants.test.ts`: 11 new tests.
- `test/e2e/folder-levels.mjs`: new suite, 28 checks.
- `test/e2e/{vault-edit,hostile,questions,catchup,automations}.mjs`: the one
  line that picked a mode now clicks a pill instead of using `selectOption`.
  No checks were added or removed in them.
- `docs/vault-tools.md`: the Settings wording and the test list.

## Results against the baselines

| Check                                     | Base (cb8fd15)                      | After                                                                              |
| ----------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------- |
| Unit (vitest)                             | 1,304 passed, 82 files              | 1,315 passed, 82 files (+11, 0 failed)                                             |
| Typecheck (node + web)                    | clean                               | clean                                                                              |
| eslint `src test`                         | clean                               | clean                                                                              |
| prettier `src test docs/vault-tools.md`   | 5 warnings, golden JSON only        | the same 5, files unchanged                                                        |
| e2e (my ✓/✕ counter, one suite at a time) | 48 suites, 1,554 checks, 0 failures | 49 suites, 1,582 checks (+28), 0 failures after one re-run                         |
| Goldens                                   | —                                   | identical: no golden file changed, and the suites that compare against them passed |

e2e notes:

- In the full run, `memory.mjs` failed 6 checks, all in its restart and
  plugin-off steps. The suite never touches Editable folders. Re-run alone, it
  passed 51/51. xvfb also reported a temp-directory cleanup error on that run.
- `media-sizes` passed first time this run. On the base run it needed one
  re-run (1-second stall timing check).

**New unit tests (11):** the level order, labels and nesting; `grantLabel`; an
edit grant covers append and create; `folderKey` matches the saved list;
`cleanFolderInput` tidies trailing dots and keeps `.`/`..`, which are then
still refused. Old or bad stored modes (`"Edit"`, an array, `"edit+append"`,
an object, missing, a number) grant nothing. A stored `Notes.` keeps exactly
its old reach. Every protected place stays uncovered by a parent grant at
each of the three levels.

**New e2e suite `folder-levels` (28 checks):**

- the three pills, the default, and that the section has no dropdown;
- the help line and the protected list;
- allowing with a level, and what `settings.json` holds;
- a refused folder resets the level and keeps the text;
- `Notes.` is Notes;
- raising Journal in place with one click;
- an append and an edit both work in Edit text folders;
- lowering in place makes both refused, with the notes unchanged;
- the automation form wording;
- the narrow window;
- a hand-written settings file with bad modes shows no folder and refuses an
  append.

## Narrowest Settings width

The window can't be narrower than 720 × 480 (`minWidth`), and the Settings
dialog is a fixed 480 px. At 720 × 480 all three pills fit on one line in
every row, with room to spare. The longest label is "Add to end", and the
suite checks that no label is cut or wrapped. The level line wraps to two
lines for Edit text. Screenshots:
`/mnt/project-files/custard/automations/folder-permissions-shots/`
(`folder-levels-narrow*.png` at 720 × 480, `folder-levels-settings.png` at
1280 × 900).

## What surprised me

- `memory.mjs` failing in the full run, then passing alone (see above).
- The add row's level reset also covers a successful Allow, which the old UI
  didn't do either. It seemed the same bug, so both reset.

## What I chose not to do

- No "included" highlight on the lower pills. Only the picked level is lit,
  and the line under it says what it includes.
- No shared pill component. The class string is the automation effort
  picker's, kept in a small local `LevelPicker` in `EditableFolders.tsx`.
- Not touched: case-sensitive vault behaviour, silent lowering on re-add,
  `normalizeGrants` (so a stored `Notes.` is not rewritten, and grants no
  more than before), the chat prompt wording, the vault-template Resources
  notes (they quote the refusal message, which is unchanged).

## Not verified

- Windows, macOS and the packaged build: how the pills look and wrap there.
  The screenshots are Linux under xvfb.
- Anything live. No provider calls were made; the e2e used the local mock.
- Running this against your own `settings.json`. The shape is unchanged, and a
  stored value test covers old and bad modes, but your file itself wasn't read.
