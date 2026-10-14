# Automations (Steps 2 to 5: scheduled runs, catch-up, questions, hostile text)

A skill the user has Custard run on a schedule, while Custard is open. Created
in Settings → **Automations**. Nothing here has been tested live, on Windows,
or with Obsidian running; it is covered by unit tests and an end-to-end test
against a mock provider.

## What the user sets

| Setting     | Meaning                                                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Name, skill | The skill is a folder under `Custard/Skills`; its `SKILL.md` is the run's instructions.                                                     |
| Model       | Any model Custard offers (Claude, OpenAI or DeepSeek). Its API key must be saved.                                                           |
| Effort      | Stored per automation (`effort`: low, medium, high, xhigh or max). Not set: no effort is sent and the provider uses its own default.        |
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
- A slot more than 10 minutes late (Custard was closed, or busy) is a
  **catch-up**; see below.
- A new automation, a turned-on one and a resumed one start looking from that
  moment: nothing from before counts.
- Runs go one at a time, in the order their slots fell due.
- DST: local times stay local. A time that doesn't exist (clocks jump
  forward) runs when the jump ends. A time that happens twice runs the first
  time; its `local` value carries the offset, so the first and second pass are
  different values. A day the month doesn't have (the 31st in June) is skipped that month.
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

## Catch-up (Step 3)

When Custard opens (or wakes from sleep), the first look covers everything since
the last one. Slots more than 10 minutes late are missed slots:

- The **newest N** of them run (N = the automation's catch-up setting, default
  3), **oldest first**, flagged `catch_up: true`, before any on-time slot. They
  count against the runs-per-day limit like any scheduled run.
- Older missed slots are **not run** but never dropped silently: they are listed
  in the context of the first catch-up run (`missed_slots`, newest 200, with
  `missed_slots_omitted` counting the rest), and a "skipped" record names how
  many were folded and which run carries them.
- N = 0 turns catch-up off: missed slots are recorded as skipped.
- Nothing before an automation was created, turned on or resumed counts, and a
  paused or turned-off automation catches up on nothing when it comes back.
- Each slot is looked at once: the window is closed before anything runs.

**Run context.** Every run's first message carries this JSON (names as Neno
confirmed), and the instructions say what the fields mean. The skill decides
what a window means and can record "data unavailable".

| Field                        | Meaning                                                                                                                                  |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `scheduled_for`              | `{local, utc}` of the slot (for Run now: the moment it was started). `local` is ISO 8601 with the offset then, `2026-10-25T02:30+02:00`. |
| `window_start`, `window_end` | `{local, utc}`: the slot before this one (null if none in the last 100 days) and this one.                                               |
| `last_successful_run`        | `{slot, finished_at}` of the newest completed run, or null. `slot` has its offset too.                                                   |
| `missed_slots`               | `[{local, utc}]` older slots folded into this run (empty for all but the first catch-up run).                                            |
| `catch_up`                   | true for a late run of a missed slot.                                                                                                    |
| `time_zone`                  | The automation's zone.                                                                                                                   |
| `configured_local_time`      | Only when the configured time didn't exist that day: that time, with the offset in force just before the clocks jumped.                  |

## Questions from a run (Step 4)

A run can't ask anything, so it has one more tool, `leave_question` (question,
and optionally context, the note it is for, and up to 4 suggested answers). It
saves the question and the run carries on or stops. At most 3 per run, 50 open
in all, identical open ones are merged, and the text is cut to its limits
(300 characters for the question, 500 for the context). Questions live in app
data (`automation-questions.json`), not in notes: a marker in a note would be
text any plugin or web page could imitate.

- Settings → Automations lists the open questions (with **Drop**) and keeps the
  answered ones with their answers.
- The next **Chat or Skills** chat is told the open questions (up to 5, the
  oldest first) in its instructions and is offered `automation_question`
  (close one as answered or dropped). It asks briefly, once per chat, after
  helping with what the user asked. When the user answers, Claude reads the
  note and changes it with `vault_edit` (version-checked), then closes the
  question. If the note isn't in a folder it may edit, it tells the user what to
  change instead. It can only close a question that was shown in that chat.
- **Outside text:** a question's text was written by a run that had read notes
  and plugin text, so a chat that was shown one counts as having outside text.
  The "Outside text" pill shows, and the edit that applies the answer shows its
  approval card with the diff, like any edit after a web page. To relax that,
  take the `questions` check out of `chatHasOutsideText`.

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

## Text from outside (Step 5)

Automations are created by the user and are **read-only by default**: a new
one can change nothing until the user ticks folders for it, and it can use
only what was granted to it. Plugins that offer background work (Spotify
among them) say so in their own notes; core does not grant it for them, so a
plugin's "no background work" line is for its author to update when the
plugin supports it.

Everything a run reads is treated as data, by code and not by asking the model
nicely (`src/main/automations/untrusted.ts`, enforced in `run.ts`):

- **Fixed envelope.** Results of `vault_search`, `vault_list`, `vault_read` and
  plugin tools come back as `<tool_result source="…" trust="data">…</tool_result>`.
  Inside it `&`, `<` and `>` are escaped (so the text can't close the envelope
  or fake another one) and control and bidirectional characters are dropped.
  Reads are cut at 40,000 characters and plugin results at 12,000, with a note
  of how much was left out.
- **No links taken from outside text.** A write (create, append, edit, or a
  question) is refused if it contains a link that appeared in a tool result
  and not in the skill itself. Web links are matched by host, so changing the
  path doesn't get around it; `javascript:`, `vbscript:` and `data:` links are
  always refused; relative link targets seen in results are refused; a
  `[[wikilink]]` is refused if it came from a plugin result (a wikilink from
  one of the user's own notes is allowed, since linking notes is normal).
  Links written in the skill are allowed.
- **No keys in notes or records.** A write containing something shaped like a
  key or token (`sk-…`, bearer tokens, GitHub, AWS and Slack keys, JWTs,
  private key headers) is refused, and the same patterns are blanked in a
  run's recorded summary, reason and call labels.
- **The tools can't grow.** The tool list, the granted folders and their modes
  are fixed when the run starts and are identical at every step; text in a
  result can't add a tool, a folder or a wider mode, and protected notes stay
  protected.
- **A cap on what one run writes:** at most 20 changes and 100,000 characters.
- Chat is separate: there, outside text makes granted-folder edits show their
  approval card.

These are heuristics for the content (a key in an unusual shape, or a link
written out in words, isn't caught) and exact rules for the structure. Not run
against a live provider.

## Records

Kept in Custard's app data (not in the vault), one file per automation, the
newest 100 runs: when it started and ended, how it started, its status
(running, done, failed, stopped, skipped) and reason, each call it made and how
it ended, the notes it changed, and the end of its last message. Shown in
Settings under each automation. A run still marked running when Custard starts
was cut off by closing: it is marked failed and is not repeated; what it had
already written stays.

Each run record also keeps the automation's model and effort when the run
started (`model`, `effort`; no effort when none was set). Records written
before these were kept, and skipped slots, have neither. Settings doesn't
show them yet.

The list of edits that Undo uses is shared with chat and now keeps the newest
200 (it was 50), because a busy automation would otherwise push chat's out.

## Effort and thinking

Each step sends the automation's effort as its model's profile says, the
same rule as a chat (`sentLevel`):

- **Claude** (`adapters/anthropic.ts`, `sendMessage`): adaptive thinking
  (`thinking: {type: "adaptive"}`) for a model whose profile thinks (Opus 5.5,
  Sonnet 5.5), whether or not an effort is set, and `output_config.effort`
  when one is. Haiku 4.5 gets neither. The output limit is 64,000 tokens,
  thinking and text together (a model with a lower limit gets its own).
  Thinking text isn't asked for (no `display`) and isn't kept: each step's
  thinking is dropped before the next, as before.
- **OpenAI and DeepSeek** (`adapters/responses.ts`): `reasoning.effort` when an
  effort is set (DeepSeek's levels: a stored medium or xhigh sends high). No
  output limit, as before.
- **Not set** (every automation saved before there was a choice): no effort is
  sent. Claude still gets adaptive thinking and the 64,000 limit.

The form doesn't offer the choice yet; an effort is stored only when one is
saved. An older Custard that saves settings drops it.

## Not in this step

Plugin write tools, web access, notifications when a run fails.

## Open for review

- A run's model reads notes and plugin text with no one to check what it does
  with them. Its writes are limited to the folders chosen for it and are all
  undoable while the note is unchanged, but a hostile note or plugin result
  can still make it write something wrong (not a link or key) inside those
  folders. The Step 5 controls limit the damage, they don't remove it. Choose
  folders accordingly.
- A catch-up run for an old slot runs with today's vault and today's plugin data. Whether that makes sense for a past window is the skill's call (the window fields tell it); Custard can't recover data a plugin only offers live.
- OpenAI runs use the Responses API without streaming and without keeping
  reasoning between steps. Not run against the live API.
- Time zones come from the system's data; a time zone name Custard doesn't know
  is refused.
