# Spotify plugin

Uses only the public Custard plugin API. Development changes stay inside `plugin/spotify/`; no core changes.

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

### Review and activate

1. Use a widget-v1-capable Custard build. `apiVersion: 1` alone does not imply widget support; older hosts reject `widgets`.
2. Open **Settings → Plugins → Spotify**, review **1.3.1**, changed files and widget allowlist.
3. Activate the update yourself. Editing, validation and mocked tests do not update the currently enabled player.
4. Ask to reopen the player if needed. Enabling alone never shows it; closing is respected until requested again.

The assistant cannot activate plugins. No live playback calls were made during this refinement. The user reported the prior player followed playback; this revision's layout/drag/volume behavior still needs live manual checking.

### Permissions

No new permission or OAuth scope. Widget allowlist expands to the already declared, approval-gated `adjust_volume` action.

- Widget: `widget:player`.
- Network: `api.spotify.com`, `accounts.spotify.com`.
- Open: `spotify:` (not available to widget).
- OAuth: `user-read-playback-state`, `user-read-currently-playing`, `user-modify-playback-state`. Tokens remain host-managed; no new reauthorization requirement.
- Existing writes: add_to_queue, open, transfer_playback, next_track, previous_track, pause_playback, resume_playback, seek, adjust_volume.
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

Incomplete/delayed recent history and gaps between foreground observations prevent reliable actual-predecessor selection. Historical URI replay has no established queue/context preservation guarantee. No collector/cursor/history scope/storage/approximation was added.

- [History Back blockers](HISTORY-BACK-BLOCKERS.md) — historical investigation; current widget docs supersede its no-widget statement.
- [Playback handoff](PLAYBACK-HANDOFF.md) — historical 1.2.0 implementation; current Back/widget guidance supersedes older wording.
- [Existing control manual checklist](MANUAL-TESTS.md).
- [Current widget manual checklist](WIDGET.md#manual-checklist--revised-behavior-not-live-verified).

## Startup readiness, preserved

For open-and-queue/play, await `open({ wait_for_device: true })` before dependent writes. Independent searches may run in parallel. Plain open is launch-only. Readiness defaults to 30 seconds (1–50 configurable), checks immediately then one second after responses; never starts/transfers/queues. Auth/permission/rate-limit failures stop promptly. An available Computer is not proof of the local computer; ask when ambiguous. Inactive devices can be explicitly queued to, not implicitly activated.

## Development

Inspected current API/manifest/widget references and existing implementation/tests. `examples/spotify` was requested but unavailable. Run `plugin_validate`, then `plugin_test`; review actual results rather than treating a code change as a passed check. Tests include existing service regressions, widget lifecycle/rendering tests and refinement tests for seek commits/cancellation, volume validation/mapping/guarding and concise output.
