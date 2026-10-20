# Manual checks — Spotify 1.2.0

Run only after reviewing/activating the plugin in Settings → Plugins and explicitly approving each requested live action. Development tests use mocked Spotify only; this checklist is not a record of live verification.

1. **Permissions:** review the six new action grants (next, previous, pause, resume, seek, volume). Confirm no new network hosts or OAuth scopes. Decline one playback action; verify no change and no dependent fallback.
2. **Read snapshot:** on a known active device, call `now_playing`. Compare title/artists/album/artwork/link, device ID/name, state, duration and position with Spotify. Confirm final `playback_metadata` JSON, ISO observation time, action hints, and correct nulls for absent fields. With no playback, expect unavailable rather than paused-at-zero.
3. **Pause/resume:** note current track, position and visible queue/context. Request/approve pause; make one separate `now_playing` check. Request/approve resume; observe again and check in Spotify that context/queue were not replaced. Acceptance alone must not be reported as verification.
4. **Next/previous:** request/approve each separately, then observe once. Previous is Spotify's previous-track command, not a guaranteed restart. Do not retry merely because the same URI is visible (repeat/duplicate tracks are possible).
5. **Seek:** request 30 seconds and then an explicit restart (0 ms). Check state/position separately. At-duration and past-duration requests must be refused without advancing the song. Also check missing duration/non-track content safely refuses; zero should not implicitly resume paused playback.
6. **Volume:** request lower by 5 and raise by 10 percentage points; verify Spotify's device volume separately. Confirm clamp/no-op behavior at a limit only at a safe listening level—do not test 100% on loud hardware. Unsupported-volume devices must explain the limitation without changing Windows/Bluetooth volume.
7. **Device safety:** no active device, wrong device ID, inactive target and restricted device must not trigger implicit open, resume or transfer. Multiple devices/ambiguous user targets should lead to a clarification, not guessing.
8. **Failures:** use mocks for 401/403/Premium/scope errors, 429 (respect Retry-After) and transport/5xx uncertainty. Do not provoke real rate limits. An unknown next/previous outcome must never trigger an automatic replay. Cancellation during preflight must not send a write; after dispatch the result may remain unknown.
9. **Bluetooth:** ask to check Bluetooth connections. Expect an honest unsupported/core-capability explanation, not a claim that Spotify Connect devices are Bluetooth connections.
10. **Regression:** search, queue with approval, launch-only open, explicit transfer, and existing bounded startup-readiness flow still work. No new monitoring or background tasks should appear.

Record actual observations separately from API acceptance when these checks are performed. Do not claim this checklist passed without executing it.

## Event log — Spotify 1.5.0

Run after reviewing and activating 1.5.0 (the review lists "Keep an event log in your vault"). Open the vault in Obsidian alongside. Today's note is `Custard/Plugins/Spotify/Events/YYYY-MM/YYYY-MM-DD.md`. Not yet run live.

1. **Off by default:** before turning anything on, press Pause and Resume in the player. No Events folder appears; Manage shows the log off; the player shows no logging line.
2. **Turn on:** Manage → Spotify → tick "Keep an event log for Spotify". Status reads "Logging on · 0 entries today"; the hub card says "Logging to vault"; the player shows "Logging to vault" within one refresh. Toggling never closes or reloads the player.
3. **Skip:** press Next about 20 s into a song. One `skip` entry, `source: "widget"`, `position_ms` near 20000, the skipped song as `track`. After the next refresh, one `track_change` with `cause: "logged_action"` and `cause_id` equal to the skip's `id`.
4. **Seek and restart:** drag the bar to about 1:00, then press Restart. A `seek` with `to_ms` near 60000, then a `restart` with no `to_ms`.
5. **Pause, resume, volume:** one entry each; volume has `from_percent` and `to_percent`. At 100 %, pressing + writes nothing (no change was needed). Keep the volume at a safe level.
6. **Assistant vs you:** ask the assistant to skip and approve it. The entry says `source: "assistant"`. Decline a second request: no entry. Ask "what's playing?": no entry, and the next player refresh does not log a change because of that read.
7. **Queue:** ask the assistant to queue two found tracks and approve. One `queue_add` with both URIs.
8. **Song ends on its own:** let a song finish with the player open. The `track_change` has `cause: "likely_ended"`; `previous.last_position_ms` is near the duration.
9. **Change outside Custard:** skip on the phone or in the Spotify app. The next player refresh logs a `track_change` with `cause: "unknown"`, and nothing else.
10. **Hidden player:** collapse or hide the player and change tracks elsewhere. Nothing is logged while it is hidden (no polling). When shown again, at most one `track_change`.
11. **Untrusted text:** play a track whose title has `[[`, `#` or backticks if you can find one. In Obsidian the entry shows as plain text in a code block: no link, tag or broken fence.
12. **No secrets:** search today's note for your Client ID, "token" and "Bearer". Nothing found.
13. **Turn off:** untick in Manage. Press Pause: no new entry; the player's logging line disappears; earlier notes stay.
14. **Grants:** in Settings → Obsidian vault, under the folders you allow, try to allow `Custard/Plugins/Spotify/Events` to the assistant at any level. It is refused with a message and the choice resets.
15. **Failure:** with logging on, set Custard to a missing vault (or make the day note read-only). Press Pause: playback pauses as usual, the player shows "Event log not saving", and Manage shows the error.

Record what you actually saw. A skipped check is not a pass.

### Background sync — Spotify 1.6.0

Run after reviewing and activating 1.6.0 (the review lists "Store its own data in Custard" and "Run its sync_recent tool by itself every 30 minutes"). Not yet run live.

1. **Off by default:** Manage shows "Background sync" with the box unticked; nothing is requested.
2. **Needs the log:** event log off, sync on. Within about a minute Manage reads "the last call … failed: The event log is off …"; one "Background sync failed" notification.
3. **Works:** event log on. Play two tracks to the end on any device. Within 30 minutes (the first call is about a minute after turning on) today's note gets two `played` entries with `source: "recently_played"`, oldest first; Manage reads "Sync on · last HH:MM · N calls today"; the hub card says "Syncing in background"; the tray menu (if kept in the tray) lists "Background sync: Spotify, every 30 min".
4. **No duplicates:** quit and reopen Custard; after the next call no `played` entry repeats.
5. **Not the assistant's:** in a chat, ask Claude to run sync_recent. It isn't offered; recently_played still works.
6. **Turn off:** untick; no further calls (Spotify's developer dashboard or the mock log shows none).

### Inferred preferences skill (`spotify-preferences`)

Needs a few days of log, or one day with deliberate presses. Not run with a real model yet.

16. **Chat:** ask "what does my Spotify listening say about my taste this week?". The `spotify-preferences` skill is read, then the day notes. A draft is shown before anything is saved; saving asks with a card and creates `Custard/Plugins/Spotify/Preferences/Inferred <today>.md`.
17. **Rules:** quick player skips (under 30 s) show as dislikes, songs that ran to the end as likes, every line marked *(inferred)* with its evidence. Assistant skips, skips after 30 s and unexplained track changes appear only under "Not counted". An artist needs 3 or more over 2 or more tracks.
18. **Never edits:** run it twice the same day. The second note is `Inferred <today> 2.md`; the first is unchanged, and so is any preferences note of your own.
19. **Untrusted text:** a title with `[[`, `#` or a link appears without them in the note: no wikilink, tag or link.
20. **Automation:** schedule the skill weekly with a New notes grant on `Custard/Plugins/Spotify/Preferences`. A run creates the note; without the grant it ends with the draft and says the grant is needed.
21. **Empty log:** with the log off and no Events notes, it says so and writes nothing.
