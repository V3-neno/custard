# Spotify plugin

Uses only the public Custard plugin API (`custard-plugin-sdk`). All changes are inside `plugin/spotify/`; no Custard core changes.

## History-based Back investigation (1.2.1)

**History-based Back is not implemented.** This is a safety/documentation revision, not a completed Back feature. It updates assistant instructions and the native Previous description/label so “Back to the song I just heard” is not silently routed to Spotify's native Previous.

The exact contract is blocked by incomplete/non-immediate history plus gaps between foreground observations. Playing a selected URI also has no established queue/context preservation guarantee. A useful observed-history or user-confirmed replay could be a separate explicitly approved design, but is not presented here as exact actual-listening-history Back.

See [History Back blockers, research, proposed occurrence/cursor semantics, widget handoff, scope requirements, and TV manual plan](HISTORY-BACK-BLOCKERS.md). No collector, cursor, Back tool, listening-data retention, additional scope or storage permission was added. `tests/back-intent.test.ts` tests only the new manifest safety contract, not history navigation.

## Available tools and permissions

- **Read tools:** search, now_playing, devices, wait_for_device.
- **Write tools:** add_to_queue, open, transfer_playback, next_track, previous_track, pause_playback, resume_playback, seek, adjust_volume. Each retains Custard's normal action approval.
- **Network:** `api.spotify.com`, `accounts.spotify.com`.
- **Open links:** `spotify:`.
- **OAuth scopes:** `user-read-playback-state`, `user-read-currently-playing`, `user-modify-playback-state`.
- **No storage**, filesystem, vault, Bluetooth, background work or UI capability.
- **Sign-in:** host-managed OAuth PKCE; tokens never enter plugin code. Version 1.2.1 needs no new scope or scope-driven reauthorization. A future recently played integration would need `user-read-recently-played` and reconnection/reauthorization; that scope is not requested now.

## Playback controls (1.2.0 implementation, preserved)

| Tool | Use |
| --- | --- |
| `spotify__next_track` | Requested skip to next track |
| `spotify__previous_track` | Explicit Spotify native Previous request only; not listening-history Back or restart |
| `spotify__pause_playback` | Requested pause |
| `spotify__resume_playback` | Resume existing item; no context, URI list, offset or position supplied |
| `spotify__seek` | Absolute `position_ms` inside a music track; zero requests restart; refuses unknown duration and at/beyond-end positions |
| `spotify__adjust_volume` | `direction: "raise"` or `"lower"`, optional `amount_percent` in percentage points (default 5); clamps to 0–100 |

These controls require the current active controllable device; optional `device_id` must match. Each preflights playback and sends at most one write. There is no implicit open, transfer, queue replacement, post-command polling or automatic control retry. Cancellation before dispatch prevents a write; after dispatch it cannot revoke one.

Success means **API accepted, not playback verified**. One separately requested `now_playing` observation can check what Spotify reports later. Server/network failure after dispatch is **Outcome unknown** and must not be blindly repeated. The host can refresh and retry a rejected 401. Device restrictions, missing scopes, account limitations and rate limits are reported.

`now_playing` preserves its summary and session URI registration, appending a final `playback_metadata` JSON line (schema version 1). It reports track/artists/album/artwork/link, duration/position, state, device/volume support, observation time, Spotify timestamp and action restrictions. Unknown values remain null; episodes/ads do not masquerade as music tracks. This is not a listening-occurrence log.

**Bluetooth:** Spotify Connect devices are not Bluetooth connections; SDK v1 cannot enumerate OS Bluetooth state. No sandbox workaround was added.

- [Existing playback schema, outcome semantics and integration handoff](PLAYBACK-HANDOFF.md) — describes the 1.2.0 implementation; the Back distinction above supersedes any broader Previous wording.
- [Existing manual checklist](MANUAL-TESTS.md).
- Existing mocked control, metadata, readiness and queue tests remain unchanged. No new live verification is claimed.

## Existing startup readiness (1.1.0, preserved)

For “open Spotify and queue songs”, use `open({ wait_for_device: true })`, await readiness, then queue searched tracks on the intended returned ID. Searches may run independently; dependent writes must wait. Plain `open({})` remains launch-only.

The readiness timeout defaults to 30 seconds, configurable from 1–50. Checks happen immediately then one second after each response, exiting as soon as a controllable device matches. Open waits for a Computer device; standalone readiness can filter by ID or require active. Neither starts/transfers playback or queues tracks. The 60-second tool deadline remains unchanged.

Cancellation stops waits promptly; an already-started host read may finish. Empty lists, transient network/server failures can recover within the budget. Auth, permission and rate-limit failures stop immediately. Readiness never proves which Computer is this local app; ambiguous targets require asking. Explicit inactive queue targets do not implicitly activate them. Uncertain queue writes are never automatically retried.

Development references inspected: `docs/API.md`, `docs/MANIFEST.md`, SDK source. The referenced `examples/spotify` folder was unavailable; the installed plugin and tests were the baseline.
