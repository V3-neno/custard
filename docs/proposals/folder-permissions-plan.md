# Folder permissions in Settings: Step 1 plan (investigation only)

**Base: `automation-thinking-p3` (PR #58, cb8fd15).** Nothing from the A1–A4 or
automation-thinking stacks is merged: `main` is still a2c934b (PR #35), and
PRs #52–#58 are open drafts, each on the previous one. #58 is the tip and
contains A4 and Phases 1–2, so I branched from it (`folder-permissions-7yg6yb`)
and the draft PR goes into it. No code is changed in this step.

## What I read

`src/shared/vaultGrants.ts` (+ test), `src/main/store.ts`, `src/main/ipc.ts`,
`src/main/index.ts`, `src/preload/index.ts`, `src/main/vault/edit.ts`,
`src/main/vault/outside.ts`, `src/main/chat.ts` (prompt, tool offer, approval
card), `src/main/automations/{index,run}.ts`,
`src/renderer/src/components/settings/{EditableFolders,Automations,CapabilitiesTab,ui}.tsx`,
`SettingsDialog.tsx`, `docs/vault-tools.md`, `docs/automations.md`, the two
vault-template Resources notes that quote this setting, and the five e2e
suites that set grants. I also ran the current Settings screen (screenshot
from `vault-edit.mjs`).

## Current behaviour

**1. Storage.** `settings.json` key `vaultGrants`: a list of
`{ folder: string, mode: 'create' | 'append' | 'edit' }`
(`vaultGrants.ts:9-10`, `store.ts:165`). One mode per folder. Every read and
every save goes through `normalizeGrants` (`store.ts:185`, `store.ts:226-230`,
`vaultGrants.ts:80-113`): unknown modes, `..`, hidden folders, drive letters,
`~` and more than 100 entries are dropped; the same folder twice (compared
without case and trailing dots) keeps **one** entry, the widest mode. Code and
docs (`docs/vault-tools.md` "Modes nest") agree.

**2. Enforcement. Edit already includes append, in the code.** Modes are
ranks, `create < append < edit`, and a tool is allowed when the folder's rank
is at least what it needs (`vaultGrants.ts:18-19`, `modeAllows`).
`vault_append` needs `append`, `vault_edit` needs `edit`
(`edit.ts:334-336`); a new note in any granted folder skips the card
(`createGranted`, `edit.ts:298-310`, `chat.ts:740-741`). The tools are offered
when any grant allows them (`chat.ts:486`, `automations/run.ts:200`). The path
is checked as written and where it really leads, and the narrower result wins
(`edit.ts:283-295`). A unit test already pins "an edit grant includes append"
(`edit.test.ts:211`). This matches your live test.

**So the "switch" is only in the UI.** The stored data is one rank, which is
the right shape for nested modes.

**3. Settings UI** (`EditableFolders.tsx`). A text box, a native `<select>`
(Create / Append / Edit, default Append) and an Allow button. Each grant is a
row: folder, the mode name in amber, Remove.

- Why it looks exclusive: the select shows three peer words and you pick one;
  the row shows one word ("Edit"). Nothing visible says Edit includes Append.
  The explanation ("New notes, and adding to the end…") exists only as the
  select's hover tooltip (`title`, line 110).
- What a click does: Allow sends the whole list with this folder's old entry
  removed and the new one added (`add`, lines 36-57). So choosing Append for a
  folder that is Edit **replaces** it: that is the switch you saw, and it is
  the only way to change a mode (retype the folder). There is no control on the
  row itself.
- Style: the select has its own classes (no `py-1.5`, no focus colour), unlike
  the `select` used elsewhere in Settings (`SettingsDialog.tsx:216`).

**Where your brief differs from the code:**

- There is **no in-chat flow that grants a folder.** Nothing outside
  Settings calls `vault:setGrants`. The chat approval card is per call: it
  shows the change, can't be allowed "for this chat", and writes no setting
  (`chat.ts:736-770`, `docs/vault-tools.md` "Outside text"). The chat prompt
  lists the grants with their mode and says create < append < edit
  (`chat.ts:382-388`), which is correct. So there is no second place with the
  same confusion. The automation form shows each folder as `Notes/ (edit)`,
  the raw id (`Automations.tsx:531`): read-only, not confusing, but not the
  Settings wording.
- The protected list is longer than your three: also `Custard/Chats`,
  `Custard/Plugins/<plugin>/Activity` and `…/Overview.md`
  (`vaultGrants.ts:40-56`).

**5. Protection.** `grantFor` ignores a grant on a parent of a protected place
(`vaultGrants.ts:135`); a grant covers it only when it names that folder.
`Memory.md` and `Overview.md` are files, so no grant can name them
(`f.length >= p.length` at line 134). Protection compares without case and
trailing dots. None of this reads the mode, and no option below touches it.

Who can write the setting: only `vault:setGrants`, through `handle`, which
refuses anything but the app's own page and frame (`ipc.ts:31-39`). The model
has no tool for it, plugins run in their own sandbox with no access to it,
and automations only read it (`automations/index.ts:145`, `run.ts:96-99`).
Notes, plugin results and web pages reach only the model, which can't call
it. Confirmed in code; not attacked live.

**6. Every reader and writer of `vaultGrants`.**

| Where | Reads / writes |
| --- | --- |
| `main/store.ts` | reads (normalized), writes (normalized) |
| `main/index.ts:262-263`, `preload/index.ts:109-111` | IPC get/set |
| `renderer/.../EditableFolders.tsx` | the Settings UI |
| `renderer/.../Automations.tsx` | lists grants as folder choices |
| `main/automations/index.ts`, `run.ts` | allow only granted folders; run gets the grant's current mode |
| `main/chat.ts`, `main/vault/edit.ts`, `main/vault/outside.ts` | prompt text, tool offer, card rule, enforcement, outside-text rule |
| Plugins | none |
| Docs | `docs/vault-tools.md`, `docs/automations.md`, vault-template `Custard Trust and Permissions Matrix.md`, `Custard Automation Skill Authoring.md` |
| Tests | `vaultGrants.test.ts`, `edit.test.ts`, `outside.test.ts`, `boundary.test.ts`, `automations/run.test.ts`; e2e `vault-edit`, `hostile`, `questions`, `catchup`, `automations` (these five pick the mode with `selectOption` on the select) |

## Options

All three keep the stored shape `{ folder, mode }` as it is. No migration:
your saved folders keep their meaning, an older build reads the file the same
way, and enforcement code doesn't change.

**A. Levels as one choice, shown as nested (recommended).** Replace the select
with the pill row Custard already uses for automation effort
(`Automations.tsx:440-458`, `aria-pressed`, rounded-full, amber border when
picked): **New notes · Add to end · Edit text**. Under it, one visible line
from the picked level, e.g. "New notes, adding to the end of notes, and
changing text in them." Each folder row gets the same pills, so you change a
folder's level in place (one click, saved at once) instead of retyping it.
The row reads "Edit text (includes add to end)" style through the pill state
plus the line.
- Pros: says plainly it is one scale; no dropdown, so nothing for your later
  dropdown redesign to undo; reuses an existing pattern; fixes "retype to
  change".
- Cons: three pills per row take more width (fine at the dialog's width; I'll
  check narrow); five e2e suites need their `allow` helper changed from
  `selectOption` to a click (their check counts stay the same).

**B. Cumulative checkboxes** (New notes / Add to end / Edit text, ticking
Edit ticks and locks Add to end).
- Pros: looks like a permission list.
- Cons: checkboxes say "independent", which the data isn't; a locked tick is
  extra explaining. Same storage only if the UI maps ticks to a rank. I don't
  recommend it.

**C. Keep the select, change only the words.** Options become "New notes
only", "Add to end (and new notes)", "Edit text (and add to end, new notes)";
the row shows the same long label.
- Pros: smallest change, no test helper change.
- Cons: still a dropdown (you plan to redesign those), still no change in
  place, the row gets long.

## Recommendation

**A**, with stored data unchanged. Also, if you agree (each is small, say
which):
1. Automation form shows the same level names instead of `(edit)`.
2. The Settings help text lists all protected places (it omits chat notes and
   plugin Overview notes, and says "unless you add that exact folder", which
   can never be true for `Memory.md`).

## Files I expect to change (A)

- `src/shared/vaultGrants.ts`: labels/help text in `GRANT_MODES` only.
- `src/renderer/src/components/settings/EditableFolders.tsx`.
- `src/renderer/src/components/settings/Automations.tsx` (only if 1).
- `test/e2e/vault-edit.mjs` (+ new checks), and the `allow` helper in
  `hostile`, `questions`, `catchup`, `automations`.
- `src/shared/vaultGrants.test.ts` (new tests).
- `docs/vault-tools.md` (Settings wording).

Not touched: `normalizeGrants`, `grantFor`, `modeAllows`, `edit.ts`,
`chat.ts`, `store.ts`.

## Test plan

- Unit: edit includes append and create (rank table); every protected place
  stays protected under parent grants of each mode; old/bad stored values
  (`"Edit"`, `"edit+append"`, `["append","edit"]`, a missing mode, a duplicate
  folder with a lower mode later) grant no more than today.
- e2e (`vault-edit`): add a folder with each level; the row shows the picked
  level and the explanation line; change a folder from Add to end to Edit text
  in place and see `settings.json` hold one entry with `edit`; then an append
  and an edit both work in it; lower it to New notes and both are refused;
  a hand-written settings file with an unknown mode shows no grant.
- All existing unit, e2e and golden results identical; typecheck, eslint,
  prettier clean.

## Risks

- A one-click change on a row saves immediately. Raising a level is then one
  click, as raising it is today with the Allow button. I won't add a
  confirmation unless you want one.
- The five suites' helper change is test code; if one of them used the select
  for something else it would show in the counts.

## Other things I noticed (not fixed)

1. Changing a mode requires retyping the folder (no row control).
2. Re-adding a folder with a lower mode silently lowers it, with no notice.
3. Typing `Notes.` when `Notes` is allowed shows "That folder can't be
   allowed", because the UI compares names with `toLowerCase` and the store
   with case + trailing dots (`EditableFolders.tsx:42-49` vs
   `vaultGrants.ts:32`). The grant itself is fine.
4. On a case-sensitive vault, `Notes` and `notes` are different folders but
   can't both be granted (normalize folds case), and the grant covers only the
   spelling kept.
5. The Settings help text's protected list is incomplete (see Recommendation 2).
6. The mode select keeps its last value after a refused folder.
7. The select's styling differs from other Settings selects.

## Baselines on cb8fd15 (this container, Linux, xvfb)

| Check | Result |
| --- | --- |
| Unit (vitest) | BASE_UNIT |
| Typecheck (node + web) | clean |
| eslint `src test` | clean |
| prettier `src test` | 5 warnings, all e2e golden JSON files (pre-existing; left identical) |
| e2e (one suite at a time) | BASE_E2E |

No live provider calls were made.

## Not verified

- Windows and macOS, the packaged build, and how the pills fit there.
- That no other program on your machine writes `settings.json`.
- The protection and IPC checks were read in code and covered by existing
  tests, not attacked live.
