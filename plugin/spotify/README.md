# Spotify plugin

Uses only the public Custard plugin API. Development changes stay inside `plugin/spotify/`; no core changes.

## 1.6.0 — background sync of recently played (off by default)

When you turn it on (Plugins → Spotify → Manage → "Sync Spotify in the background"), Custard calls `sync_recent` by itself every 30 minutes while Custard runs, including hidden in the tray. It makes one request, `GET /me/player/recently-played` (the last 50 plays Spotify keeps), and adds the new plays to the event log as `played` entries (`source: "recently_played"`), oldest first. So listening history is kept while the player is closed.

- Needs the event log on too; with it off, the call fails with that reason and nothing is requested.
- Never polls playback: it reads only the history Spotify already keeps, at most every 30 minutes (Custard enforces 15 minutes as the floor, 96 calls a day, and backs off up to 6 hours after a failure).
- Only Custard's schedule runs it (`ctx.caller` is `background`); the assistant is never offered it and gets an error if it tries. The assistant still has `recently_played` for questions.
- Plays older than 23 hours aren't logged (the event log takes the last 24 hours only), at most 20 per call; a longer backlog goes in the next calls.
- New permissions to approve: `storage` (only where the sync got to, so a restart doesn't log a play twice) and "Run its sync_recent tool by itself every 30 minutes".
- `played` entries are Spotify's history: lagging, possibly incomplete, no skip or listened-duration data. They are not the same as the `track_change` entries the player logs.

Testing status: unit tests with a fake Spotify and a fake event log; Custard's side has an end-to-end test against a mock. Not run against the live Spotify API.

## 1.5.0 — playback event log (off by default)

Keeps a local, append-only log of playback actions in the vault, as raw material for working out music preferences later. Design: [docs/proposals/spotify-event-log.md](../../docs/proposals/spotify-event-log.md). Needs a Custard build with `ctx.caller` and `ctx.events`.

### What is logged

| Type | When |
| --- | --- |
| `skip`, `previous`, `pause`, `resume`, `seek`, `restart`, `volume` | A press in the player (`source: "widget"`) or an assistant call (`source: "assistant"`) that Spotify accepted, or whose answer was lost (`outcome: "unknown"`). A seek to 0 is `restart` |
| `queue_add` | Tracks Spotify accepted into the queue |
| `track_change` | The player's own refresh (or its Refresh button) saw a different track than its last read. Carries `previous` (track, last known position, whether it was estimated) and `cause`: `logged_action` (with `cause_id`), `likely_ended` (within 5 s of the end) or `unknown` |

Not logged: declined, refused, not-run or rejected (4xx) actions, a volume change that needed nothing, automation calls, and the assistant's own `now_playing` reads (which also never move the player's baseline). Each entry has UTC and local time, track title, artists, artist IDs and URI, position and duration, device name and type, outcome and the verification state from the existing single follow-up read.

### Where and how

- One note per day: `Custard/Plugins/Spotify/Events/YYYY-MM/YYYY-MM-DD.md`, day picked in the **Time zone** setting (default `Europe/Stockholm`).
- Custard writes the note, not the plugin: the plugin hands over a JSON record and Custard checks it, puts it on one line in a `custard-event` code block, and adds it to the end. Spotify text is therefore never a link, tag or markup. Records holding a secret or anything token-shaped are refused.
- The plugin can't read, change or delete the log, and the assistant can never be given access to an Events folder.

### Turning it on

**Settings → Plugins → Spotify → Manage → Event log in your vault.** Off by default. While on, Manage shows today's count and the last entry, the hub card says "Logging to vault", and the player shows "Logging to vault" (or "Event log not saving" if a write failed). Turning it off stops new entries at once; existing notes stay.

### Summing it up

The starter skill `spotify-preferences` (in `Custard/Skills/`) reads the log for a period and writes a new note, `Custard/Plugins/Spotify/Preferences/Inferred YYYY-MM-DD.md`, of likely likes and dislikes, every line marked *(inferred)*. It counts only quick widget skips (under 30 s) and songs played to the end, never assistant skips or unexplained track changes, and never edits an existing note.

### Guarantees

- No new requests: logging uses the reads each tool already makes. No polling, no background job.
- No change to playback, to tool results or to what the assistant may do. A failing log never fails the tool.
- New permission: `events` (shown in the review as "Keep an event log in your vault"). No new scopes, hosts or actions.

### Testing status

Mocked tests only, plus the Electron e2e with a mocked Spotify (a player Pause lands in today's note as `source: "widget"`). **Nothing was run live**: real Spotify timing for track changes, Windows paths and a vault open in Obsidian while writing are unverified. Manual checks: [MANUAL-TESTS.md](MANUAL-TESTS.md#event-log--spotify-150).

## 1.4.0 — read-only history, top items, genre lookup, accepted vs verified

Phase 2 of the Spotify listening design. Read-only additions plus clearer reporting; nothing new can change playback.

### New read tools

| Tool | What it returns | Limits |
| --- | --- | --- |
| `spotify__recently_played` | Recently played tracks as `listening_history_v1` JSON: `played_at_utc`, `played_at_local`, track, artist names and IDs, context | 1–50 entries (default 20); optional `after` or `before` (ISO 8601 with Z or offset, not both). **Lagging and possibly incomplete.** No skip, completion or listened-duration data |
| `spotify__top_items` | Top artists or tracks as `top_items_v1` JSON, ranked by Spotify's affinity calculation | `type` artists/tracks; `time_range` short_term (about 4 weeks), medium_term (about 6 months, default), long_term (about 1 year); limit 1–50, offset 0–49. **Not play counts**; no popularity |
| `spotify__artist_genres` | Genres for up to 5 artists as `artist_genres_v1` JSON, one `GET /artists/{id}` per artist | `genres_status` is `present`, `empty` (unclassified) or `absent` (field not sent). The last two mean *unknown*, not "no genre" |

`now_playing` is unchanged apart from additive JSON fields: `observed_at_local`, `time_zone` and `track.artist_ids`. It still makes one request and returns no genre; pass `artist_ids` to `artist_genres`.

All Spotify text is treated as untrusted data. Results are labelled `lagging` / `possibly_incomplete` / `untrusted_spotify_metadata` where that applies. Nothing is stored (`storage` stays off).

### Times

Every timestamp keeps its UTC value and adds a local one: for example `2026-10-09T16:35:00Z` and `2026-10-09T18:35:00+02:00`. The new **Time zone** setting (IANA name, default `Europe/Stockholm`) controls the local rendering, including the change to UTC+1 on 2026-10-25. An invalid zone falls back to Stockholm with a note. If the runtime has no time-zone support, results are UTC only; no offset is ever guessed. Timestamps without Z or an offset are refused as input.

### Accepted vs verified

Writes now report two separate facts. The first line is still `Spotify accepted …`; a `verification:` line follows, from **one** follow-up read about 1 second later (never a loop, never a retry, never another write):

| State | Meaning |
| --- | --- |
| `confirmed` | The follow-up snapshot matched the check |
| `not_observed` | It did not match; this is **not** proof of failure, state can lag |
| `inconclusive` | The read failed, the device or track changed, or the value was unreported |
| `not_checked` | The call was cancelled first |

Checks: pause/resume (playing state), seek (position near the target, allowing for elapsed time), volume (equals target), transfer (target device active, and playing if requested), next/previous (the track changed; which track is **not** checked, and causality is not claimed), queue (a read before and after: per track, position in the visible queue and whether a new entry was observed; duplicates already queued are `inconclusive`). Failed or unknown-outcome writes are not verified and are never retried. Each write costs one extra request (two for the queue).

### History cannot tell heard from skipped (re-checked 2026-10-09)

The recently-played response has a track, `played_at` and context, and **no** duration-played or skipped field. So the finding in [HISTORY-BACK-BLOCKERS.md](HISTORY-BACK-BLOCKERS.md) still stands: A → B and A → X(skipped) → B can produce identical data. These tools therefore do no deduplication, no adjacency, no skip or completion inference and no Back. History URIs are not added to the queue allow-list.

### Genre status (to be checked on your account)

Spotify's [Get Artist](https://developer.spotify.com/documentation/web-api/reference/get-an-artist) reference still lists `genres` but marks it **deprecated** (empty when unclassified). The [February 2026 changelog](https://developer.spotify.com/documentation/web-api/references/changes/february-2026) keeps `GET /artists/{id}` and does not list `genres` as removed, but one [third-party report](https://github.com/marcelmarais/spotify-mcp-server/issues/73) says Development Mode apps get no `genres` on top artists. Run `artist_genres` once and look at `genres_status` before relying on genre. If it is empty or absent, logs should say genre unknown or label any guess as inferred. Development Mode also requires the app owner to have Premium and allows five authorized users ([Spotify](https://developer.spotify.com/blog/2026-02-06-update-on-developer-access-and-platform-security)).

### Review, activate and reconnect

1. Open **Settings → Plugins → Spotify**, review **1.4.0**, the changed files and the permissions below, and activate it yourself. The assistant cannot.
2. **Disconnect, then Connect** Spotify there. An existing token does not gain new scopes, and Spotify's consent screen will list the two new ones. Until you do, the new tools answer "Reconnect Spotify in Settings → Plugins"; the existing tools keep working.
3. Optionally set **Time zone**.

### Permissions (1.4.0)

- New OAuth scopes: `user-read-recently-played`, `user-top-read` (so five in total, with the existing `user-read-playback-state`, `user-read-currently-playing`, `user-modify-playback-state`). They show as two new `account-scope:` lines.
- No new `action:` entries (the three new tools are `read`), no new network host, no storage, no new widget permission or allowlist entry.
- Unchanged: network `api.spotify.com`, `accounts.spotify.com`; open `spotify:`; widget `widget:player`; writes add_to_queue, open, transfer_playback, next_track, previous_track, pause_playback, resume_playback, seek, adjust_volume.

### Testing status

Mocked tests only (scripted fetch): time conversion including the 2026-10-25 change, history/top/genre mapping and failures, hostile text, verification states for every write tool, and queue before/after. **Nothing was run live.** Suggested manual checks after reconnecting: `artist_genres` on one artist; `recently_played` with limit 5; `top_items` artists short_term; one pause or resume to see the verification line; compare a queue result with Spotify's visible queue.

The widget calls the same write tools, so its actions now make one extra read each. The first sentence of each result is unchanged; widget logic is covered by its existing mocked tests, but the live widget has not been rechecked.

## 1.3.1 — quieter player, direct seeking and volume

The `spotify/player` widget now has:

- No visible diagnostic paragraphs or routine tool-success output. Short actionable error/unknown/pending notices remain.
- Hidden scrollbar/thumb, retaining wheel/keyboard overflow access on narrow layouts.
- Timeline drag preview; release requests one seek through the normal approval flow. Native keyboard changes also request seek. **No separate Seek button.**
- **Volume −/+**, changing Spotify volume by five percentage points, with observed percentage. Unsupported/unknown volume is disabled; no optimistic update or Windows-volume control.
- Pause/resume, Next, and expanded Restart unchanged.
- **Back still disabled**, with tooltip rather than an explanation paragraph. No native Previous substitution.

Seek remains subject to track changes during approval. Its warning is in hover/accessible help, not visible boilerplate. Existing service rechecks device, duration and restrictions, but cannot atomically bind to the displayed track.

See [widget architecture, compatibility, outcomes, verification boundaries and manual checklist](WIDGET.md).

### Permissions as of 1.3.1 (superseded by 1.4.0 above)

- Widget: `widget:player`.
- Network: `api.spotify.com`, `accounts.spotify.com`.
- Open: `spotify:` (not available to widget).
- OAuth: `user-read-playback-state`, `user-read-currently-playing`, `user-modify-playback-state`.
- Widget allowlist: now_playing (read); pause_playback, resume_playback, next_track, seek, adjust_volume (write).
- No storage, filesystem, vault, OS Bluetooth, background worker, remote image/CDN or additional secret.

## Widget contract

Compact 240 px / expanded 330 px, bounds 200–360. Custard owns placement/header/close/presentation/approval/lifecycle/bridge; plugin owns internal UI. Empty object input only. Safe text nodes and bounded validated metadata; no provider URLs/credentials/configuration in widget data. Local artwork fallback remains because the SDK lacks a safe binary-response reader.

Synchronous hidden mount, visibility/restoration reads, host-driven 15-second foreground refresh. No independent polling. Stale/device/capability checks, one pending action, bounded calls, late-response guards and cleanup remain. At most one immediate visible/in-budget read after completed/unknown actions; no automatic write retry. Command acceptance is not verified playback.

Windows native view layout, focus entry/exit, real gesture enforcement and screen readers require manual testing. Mock DOM/bridge tests only verify plugin logic. No core Git/PR merge status is asserted.

## Existing playback controls

| Tool | Use |
| --- | --- |
| `spotify__next_track` | Explicit requested next/skip |
| `spotify__previous_track` | Explicit Spotify native Previous only, not history Back or restart |
| `spotify__pause_playback` | Requested pause |
| `spotify__resume_playback` | Resume existing item, no context/URI/offset/position supplied |
| `spotify__seek` | Absolute milliseconds within current music; zero restarts without resume |
| `spotify__adjust_volume` | Relative Spotify percentage-point change, default five, clamped 0–100 |

Tools preflight active controllable device; optional device_id must match. No implicit open, transfer, queue replacement or write retry. A rejected 401 may be refreshed/retried by the host; uncertain writes are not replayed. Cancellation before dispatch prevents a write; after dispatch it cannot revoke one.

`now_playing` preserves summary and final `playback_metadata` JSON v1, adding bounded `ToolResult.data` for the widget. Unknown values remain null. Data is a snapshot, not a listening-occurrence log.

## History-based Back remains unavailable

Incomplete/delayed recent history and gaps between foreground observations prevent reliable actual-predecessor selection. Historical URI replay has no established queue/context preservation guarantee. 1.4.0 adds read-only history access but no collector/cursor/Back tool/storage/approximation.

- [History Back blockers](HISTORY-BACK-BLOCKERS.md) — historical investigation (1.2.1). Its "no history scope" statements describe that revision; 1.4.0 now requests `user-read-recently-played` for read-only listing only. Its conclusion about heard vs skipped is unchanged.
- [Playback handoff](PLAYBACK-HANDOFF.md) — historical 1.2.0 implementation; current Back/widget guidance supersedes older wording.
- [Existing control manual checklist](MANUAL-TESTS.md).
- [Current widget manual checklist](WIDGET.md#manual-checklist--revised-behavior-not-live-verified).

## Startup readiness, preserved

For open-and-queue/play, await `open({ wait_for_device: true })` before dependent writes. Independent searches may run in parallel. Plain open is launch-only. Readiness defaults to 30 seconds (1–50 configurable), checks immediately then one second after responses; never starts/transfers/queues. Auth/permission/rate-limit failures stop promptly. An available Computer is not proof of the local computer; ask when ambiguous. Inactive devices can be explicitly queued to, not implicitly activated.

## Development

Inspected current API/manifest references, the Spotify Web API changelogs and the existing implementation/tests. `examples/spotify` was requested but unavailable. Run `plugin_validate`, then `plugin_test`; review actual results rather than treating a code change as a passed check. Tests cover service regressions, widget lifecycle/rendering, and (1.4.0) time conversion, the three read tools and accepted/verified reporting.
