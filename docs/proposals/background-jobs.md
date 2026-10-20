# Background jobs: what they would add (Step 1, design only)

Status: approved by Neno on 2026-10-20 ("i follow all your recommendations
just make sure that there are clear limits and notify when a failure
happens"). Step 1 is built; see **Step 1 as built** at the end. Based on `main` at 8b2bbce and the
Spotify event log design (`docs/proposals/spotify-event-log.md` on the
`spotify-event-log` branch, PRs #74 to #77).

## 1. Short answer: why scheduled runs work and "background jobs" were held back

The two words name different things.

- **A scheduled automation** is Custard's own code (the main process) waking
  every 20 seconds, finding a due slot and running a skill with a model. A
  plugin is touched only when that model calls one of the plugin's **read**
  tools. That is an ordinary tool call: the plugin's sandbox wakes for it,
  answers, and goes idle. So the plugin rule holds: "A plugin only runs inside
  a tool call. There are no background tasks" (`docs/plugins/API.md`).
- **"Background jobs"** in the Spotify event log design meant **plugin code
  running on its own**: a timer inside the Spotify plugin polling playback
  while the player widget is hidden, with nobody asking. That breaks the rule
  above, which every plugin security check rests on (budgets, timeouts, the
  caller being known, Stop working). It also breaks Spotify's own spec line
  "no assistant polling loops or background work" (`plugin/spotify/instructions.md`).
  That is why the event log design said "not now" (its section 7), and you
  approved that on 2026-10-20.

There is a second, separate gap that also sounds like "background": an
automation **only runs while Custard is open**. Closing the last window quits
the app on Windows (`app.on('window-all-closed')` in `src/main/index.ts`) and
also shuts the plugin host. Missed slots are caught up on the next start, but
nothing runs in between.

## 2. What automations already do (checked against the code and `docs/automations.md`)

| Area         | Today                                                                                                                                                                                                                                |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| When         | Daily local times, optional days of the month, per time zone, DST handled. Main-process tick every 20 s (`scheduler.ts`).                                                                                                            |
| App state    | Runs while Custard is open, **including minimised** (the timer is in the main process, not the window). Not while closed.                                                                                                            |
| Missed slots | Catch-up on start or wake from sleep: newest N (default 3) run oldest first; older ones are listed in `missed_slots`, never dropped silently.                                                                                        |
| Triggers     | Time only, plus **Run now**. No event triggers.                                                                                                                                                                                      |
| Tools        | Vault read/search/list; create/append/edit only in folders ticked for it (from Editable folders); plugin **read** tools of chosen plugins. No plugin write tools, no web, no widgets, no Design.                                     |
| Hostile text | Fixed `<tool_result trust="data">` envelope, escaping, size caps; writes refused if they carry a link seen in results or key-shaped text; 20 changes / 100k chars per run; tool list fixed at start.                                 |
| Limits       | Runs per day (24, up to 96), tool calls per run (30, up to 100), minutes per run (5, up to 30), auto-pause after 3 failures. The form showed only runs per day and catch-up; the other three could be changed only in settings.json. |
| Output       | Run records in app data, undoable edits, questions left for the next chat. No notification when a run fails.                                                                                                                         |

## 3. The real gaps

| #   | Gap                                                                                                                                                | Who would notice                                                                                        |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| G1  | Runs stop when the window is closed.                                                                                                               | Anyone with a daily 07:30 skill who closes Custard at night. Catch-up softens it, but runs happen late. |
| G2  | Runs never start at login.                                                                                                                         | Same, after a reboot until you open Custard.                                                            |
| G3  | No way for a plugin to collect data while nobody is looking (e.g. Spotify listening while the player is hidden).                                   | Spotify event log: outside skips are missed when the player isn't showing.                              |
| G4  | No event triggers ("when a note in folder X changes", "when the event log grows").                                                                 | Skills that should react, not run on a clock.                                                           |
| G5  | Runs can't use plugin write tools (e.g. queue a song, make a playlist).                                                                            | A weekly "make me a playlist" automation.                                                               |
| G6  | Three of the five limits weren't in the form (correction: the ceilings were already 30 min and 100 calls; this note first said they were missing). | Anyone who wants a longer run, or to see what an automation may do.                                     |
| G7  | No notification when a run fails or leaves a question.                                                                                             | You find out only in Settings.                                                                          |

Out of reach for any option here: running while the **computer** is off or
asleep, and running in Claude's cloud (no subscription login for third-party
apps, and the vault is on your machine).

## 4. Options and their security implications

### A. Keep Custard running in the tray (fixes G1, optionally G2)

Closing the window hides it to a tray icon instead of quitting; the main
process, scheduler and plugin host keep going. Optional "Start Custard at
login (hidden)" via `app.setLoginItemSettings`. The tray icon is already on
the roadmap (Phase 6).

- **Plugin rule:** unchanged. Plugins still run only inside tool calls.
- **No-polling rule:** unchanged. Nothing new polls; the existing 20 s
  scheduler tick is Custard's, not a plugin's, and costs nothing until a slot
  is due.
- **New risks:** spend and activity you can't see. Mitigations: tray icon
  shows a running dot during a run and the last run's status in its menu;
  **Quit** in the tray menu really quits; both settings **off by default**;
  the per-day caps still apply.
- **Data:** nothing new is exposed. Keys stay in `safeStorage`, readable only
  by your Windows user, as now.
- **Work:** small. Main-process lifecycle, tray menu, two settings, the plugin
  host must not shut down on last-window-close when the setting is on.

### B. Run when Custard is fully closed (OS scheduler or a service)

Windows Task Scheduler (or a separate always-on helper) starts Custard
headless for each slot.

- **Security:** a new entry point that starts the app with arguments, a
  second process that can read your keys, and a scheduler entry outside
  Custard that a Settings switch can't reliably remove if Custard is
  uninstalled badly. More to defend for little gain over A.
- **Recommendation:** no. A plus "start at login" covers the same need.

### C. Host-scheduled plugin sync calls (fixes G3 the safe way)

A plugin declares one **read** tool it allows the host to call on a slow
schedule, e.g. in `plugin.json`:
`"background": { "tool": "sync_recent", "everyMinutes": 30 }`.
The **host** calls it like any tool call, with `ctx.caller = "background"`.
No model is involved and the result goes nowhere except what the plugin
writes through `ctx.events` / `ctx.storage`.

- **Plugin rule:** kept to the letter. The plugin still runs only inside a
  call the host started, with the usual timeout, `ctx.signal`, Stop, budgets
  and permission checks. What changes is that the host, not a model or a
  click, starts some calls. That is a real change to the threat model and
  needs its own review: a plugin with this permission does network requests
  you didn't trigger.
- **No-polling rule:** this is polling, but slow and bounded. The Spotify
  design already named the acceptable shape: sync `recently_played` (the last
  50 tracks, which Spotify keeps; the `user-read-recently-played` scope is
  already in the manifest) every 30 minutes or more, **not** poll playback
  every few seconds. Minimum interval enforced by core (proposal: 15 min);
  no sub-minute timers ever.
- **Controls:** new manifest permission `background` that the user approves
  on update (like `events`); a core per-plugin switch, **off by default**, in
  Manage; a visible "Syncing in background" chip on the plugin card; a daily
  call cap; backs off on 429; stops when the plugin is disabled or the
  account disconnected; only read tools (core refuses a write tool); runs
  only while Custard runs (so it pairs with A).
- **Hostile text:** none reaches a model at call time. Whatever the sync
  writes to the event log is later read by skills as data, with the existing
  envelope rules, and the Events folder stays ungrantable.
- **Work:** medium. Manifest field, scheduler in the plugin host, caller value,
  switch and chip, docs, tests, then Spotify `sync_recent`.

### D. Free-running plugin timers or workers

Plugin code gets `setInterval`, a worker or a long-lived connection.

- **Security:** removes the "only inside a call" rule. Timeouts, Stop and
  budgets no longer mean anything; a plugin could hammer an API or hold a
  socket open forever. Every existing plugin check would need re-doing.
- **Recommendation:** no. C gives the useful part without this.

### E. Event triggers for automations (G4)

Core starts a run when something happens, e.g. a note changes in a chosen
folder, or the plugin event log gets new lines.

- **Plugin rule / polling:** unaffected if the trigger is a core file watcher.
- **New risks:** **loops** (a run's own write triggers itself or another
  automation), **amplification** (anything that can drop a file in the vault,
  such as sync or another app, can now start a model run on demand and pick
  what it reads), and cost bursts. Mitigations would be: ignore the run's own
  writes, debounce (e.g. 5 min), the same per-day cap, no chaining between
  automations, and triggers only on folders you ticked.
- **Recommendation:** later. A schedule every hour covers most of it with
  none of these risks.

### F. Plugin write tools in automations (G5)

Per automation, you tick specific write tools (e.g. `spotify__playlist_add`).

- **Security:** this is where hostile text bites. A note or plugin result
  could steer an unwatched run into calling a write tool with its own
  arguments; there is no approval card. The link/key checks don't cover tool
  arguments to third-party services.
- **Recommendation:** not now. If wanted later: only ticked tools, a per-run
  cap of calls, arguments refused if they contain text taken from tool
  results (as links are today), and each call recorded.

### G. All limits in the form, and a failure notification (G6, G7)

Show all five per-automation limits in the form with their ranges (the
ceilings of 30 minutes and 100 calls already exist), and an OS notification
when a run fails, pauses itself or leaves a question.

- **Security:** limits are a damage cap, so larger ones mean larger possible
  damage per run; defaults stay as they are. A notification shows only the
  automation's name and status, never run text (it could carry outside text).
- **Work:** small.

## 5. Recommendation

1. **Do A first**: close to tray and optional start at login, both off by
   default, with a running dot and a real Quit. It makes the automations you
   already have behave like background jobs, and changes no security rule.
   Add **G**'s failure notification with it, since an app in the tray needs a
   way to tell you something went wrong.
2. **Then C, only if you want Spotify history while the player is closed**:
   host-scheduled read-only sync calls, Spotify `recently_played` every 30
   min into the event log. Own permission, off by default, its own review stop
   as a security boundary.
3. **Not now:** B (OS scheduler), D (plugin timers), E (event triggers),
   F (plugin writes from automations).

One draft PR per step from `main`, review stop after each.

## 6. Decisions

Answered 2026-10-20: all as recommended, with clear limits and a
notification on failure.

1. **Close to tray:** OK to add, off by default? (Recommended: yes.)
2. **Start at login, hidden:** add it as a second setting, off by default?
   (Recommended: yes.)
3. **Failure notification** with Step 1? (Recommended: yes, name and status
   only.)
4. **Host-scheduled plugin sync (C):** build it as step 2, or leave plugins
   strictly model/click-triggered? This is the safety decision: it changes
   who can start a plugin call. (Recommended: yes, read tools only, 15 min
   minimum, off by default. Your call.)
5. **Run limits:** all five in the form, today's defaults and ranges kept.
   (Recommended: yes, small.)
6. Confirm **no** for B, D, E, F for now.

Nothing here is tested; it is a reading of the code and docs at 8b2bbce.

## Step 1 as built

- Close to tray, start at login (hidden), notifications, as in option A and
  G. Details in `docs/automations.md`, "Running in the background".
- "Clear limits": all five per-automation limits in the form with their
  ranges (out-of-range values are refused, not clamped), and a limits line on
  each automation's card. Two new limits on all automations together, both
  checked after the automation's own runs-a-day limit and never for Run now:
  at most 48 scheduled runs a day (1-200), and scheduled runs skipped once the
  month's estimated spend reaches the budget (on by default; nothing without
  a budget).
- Single-instance lock, so a second Custard can't run every automation twice.
- Step 2 (host-scheduled plugin sync, option C) followed on 2026-10-20 ("go
  ahead with step 2").

## Step 2 as built

- Manifest `background: { tool, everyMinutes }` (read tool, no required
  input, 15-1440 minutes), permission `background:<tool>@<minutes>`, a
  per-plugin switch in Manage (off by default), `ctx.caller` `background`.
- Host scheduler (`src/main/plugins/sync.ts`): one call at a time, first call
  a minute after turning on or starting, at most 96 a day per plugin (kept
  across off and on), doubling wait after a failure up to 6 hours, one
  notification a day on failure. The background tool is never offered to a
  model.
- Status in Manage, a "Syncing in background" chip, a tray menu line.
- Spotify 1.6.0: `sync_recent` reads recently played (one request) and adds
  new plays to the event log, oldest first, at most 20 per call, within the
  last 23 hours; `storage` keeps where it got to. It refuses any caller but
  `background` and does nothing with the event log off. Not run live.
