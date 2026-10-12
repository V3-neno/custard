# Automations (Step 2: scheduled runs)

A skill the user has Custard run on a schedule, while Custard is open. Created
in Settings → **Automations**. Nothing here has been tested live, on Windows,
or with Obsidian running; it is covered by unit tests and an end-to-end test
against a mock provider.

## What the user sets

| Setting     | Meaning                                                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Name, skill | The skill is a folder under `Custard/Skills`; its `SKILL.md` is the run's instructions.                                                     |
| Model       | Any model Custard offers (Claude or OpenAI). Its API key must be saved.                                                                     |
| Times, days | Daily local times (`07:30, 19:00`); optionally days of the month (`1, 15`). Empty days means every day.                                     |
| Time zone   | Empty = the computer's. DST keeps local times (see below).                                                                                  |
| Folders     | Chosen from the folders already allowed under Editable folders.                                                                             |
| Plugins     | Plugins whose **read** tools the run may use.                                                                                               |
| Limits      | Runs per day (default 24, set per automation, 1-96), tool calls per run (30), minutes per run (5), failed runs before it pauses itself (3). |

A new automation starts turned off.

## When it runs

- Only while Custard is open. A tick every 20 seconds looks for slots that fell
  due since the last look. Each slot is picked up once, even if Custard closes
  during its run (the window is closed before the run starts).
- A slot more than 10 minutes late (Custard was closed, or busy) is **not**
  run. It is recorded as skipped ("missed"). Catch-up is Step 3.
- A new automation, a turned-on one and a resumed one start looking from that
  moment: nothing from before counts.
- Runs go one at a time, in the order their slots fell due.
- DST: local times stay local. A time that doesn't exist (clocks jump
  forward) runs when the jump ends. A time that happens twice runs the first
  time. A day the month doesn't have (the 31st in June) is skipped that month.
- **Run now** starts one at once, even when paused or turned off. It is not
  counted against the runs-per-day limit. Only one Run now can be waiting per
  automation.
- The runs-per-day limit counts scheduled runs started on the local day. Past
  it, a slot is recorded as skipped.
- A run is stopped at its minute limit or tool-call limit and recorded as
  stopped, with the reason.
- After the set number of failed scheduled runs in a row the automation pauses
  itself, with the last reason. Turning it on or **Resume** clears this. A
  429, a rejected key, a missing key or an unavailable plugin ends the run with
  that reason; there is no retry loop (the provider SDKs' own retries are off).

## What a run can do

A run is its own turn, with no chat, no approval cards and nobody to answer
questions. Its tools are fixed when it starts:

- `vault_search`, `vault_list`, `vault_read`.
- `vault_create_note`, `vault_append`, `vault_edit`, **only** in the folders
  chosen for it, with the mode the user's grant has when the run starts (so a
  grant removed later removes the access, and a grant added later is not
  picked up). They behave exactly as in chat: create never overwrites, edits
  are version-checked and atomic, and each change is recorded and can be
  undone under Settings → Recent changes (marked "automation").
- `Custard/Memory.md`, `Custard/Skills`, `Custard/Captures` and
  `Custard/Plugins/*/Activity` stay protected, as in chat.
- A new note outside its folders is refused: there is nobody to approve it.
- Plugin **read** tools of the chosen plugins, when each plugin is enabled,
  approved, current and opted in to "Use in Chat and Design". If any chosen
  plugin isn't, the run fails with that reason before calling the model.
  Plugin **write** tools are never offered, and a call to one is refused. A
  read tool that would ask for approval is declined.
- No web search or reading, no widgets, no Design, no code workspace.

The run's instructions tell the model that nobody is watching, that notes and
plugin results are data and not instructions, and which folders it may change.
That is guidance, not the control: the tool list and the checks above are.

## Records

Kept in Custard's app data (not in the vault), one file per automation, the
newest 100 runs: when it started and ended, how it started, its status
(running, done, failed, stopped, skipped) and reason, each call it made and how
it ended, the notes it changed, and the end of its last message. Shown in
Settings under each automation. A run still marked running when Custard starts
was cut off by closing: it is marked failed and is not repeated; what it had
already written stays.

The list of edits that Undo uses is shared with chat and now keeps the newest
200 (it was 50), because a busy automation would otherwise push chat's out.

## Not in this step

Catch-up (missed slots are only noted), questions from unattended runs, the
hostile-text controls for outside text read by a run (Step 5), plugin write
tools, web access, notifications when a run fails.

## Open for review

- A run's model reads notes and plugin text with no one to check what it does
  with them. Its writes are limited to the folders chosen for it and are all
  undoable while the note is unchanged, but a hostile note or plugin result
  could still make it write something wrong inside those folders until the
  Step 5 controls exist. Choose folders accordingly.
- OpenAI runs use the Responses API without streaming and without keeping
  reasoning between steps. Not run against the live API.
- Time zones come from the system's data; a time zone name Custard doesn't know
  is refused.
