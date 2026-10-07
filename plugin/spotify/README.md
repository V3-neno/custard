# Spotify plugin

Uses only the public Custard plugin API (`custard-plugin-sdk`). Custard's core has no Spotify code.

- **Read tools:** search, now_playing, devices, wait_for_device.
- **Write tools:** add_to_queue, open, transfer_playback. Each retains Custard's action approval.
- **Permissions (unchanged):** network access to `api.spotify.com` and `accounts.spotify.com`; open `spotify:` links; Spotify OAuth scopes `user-read-playback-state`, `user-read-currently-playing`, `user-modify-playback-state`. No storage, vault, filesystem or additional network permission.
- **Sign-in:** host-managed OAuth PKCE. The plugin never receives tokens.

## Startup readiness (1.1.0)

For "open Spotify and queue songs", the assistant uses `open({ wait_for_device: true })`, awaits readiness, then queues the searched tracks on the intended returned device ID. Independent searches may happen in parallel; dependent actions must wait. A plain `open({})` remains launch-only and needs no API read.

The **Device readiness timeout (seconds)** setting defaults to **30**, configurable from **1–50**. Readiness checks immediately, then one second after each response, exiting as soon as a matching controllable device appears. Restricted and null-ID devices are excluded. Open waits for a Computer device; standalone `wait_for_device` can filter by device ID or require an active device. Polling never starts/transfers playback or queues tracks.

Cancellation stops polling promptly, including while waiting on an HTTP response. Empty lists, transient network failures and server errors can recover within the budget. Authentication, permission and rate-limit errors stop promptly instead of wasting the startup wait or hammering Spotify. Slow reads are bounded by the overall readiness deadline. The SDK has no per-request cancellation: an already-started read may finish in the host, but the plugin will not issue more polls after the wait exits.

### Limits and safety

- Spotify Connect availability is a readiness signal, not proof of the local app's identity or a guarantee a later command succeeds. Existing computers can already be listed; the assistant must not guess between ambiguous devices.
- An explicit inactive device can be passed to queueing. This does not automatically activate it; Spotify may still reject the command. No implicit playback transfer is performed.
- Queue writes remain non-retrying to avoid duplicates; readiness waits occur before dependent actions, not as automatic action replays.
- The tool timeout is 60 seconds, the host maximum. Readiness is capped at 50 seconds to leave reporting overhead. Open's launch time counts toward its readiness budget.
- Multi-minute waits and generic orchestration across all plugins need a separate core/SDK proposal: longer cancellable tool deadlines (including provider/client lifecycle handling), progress reporting, and ideally request-level cancellation. This plugin does not bypass sandbox limits.

### Manual checks after activation

1. Close Spotify; request "open Spotify and queue two songs". Verify the open call stays pending until a Computer device appears, then the queue approval occurs.
2. Repeat with Spotify ready: there should be no fixed 30-second delay.
3. Keep Spotify signed out/offline or use a missing device ID: verify a bounded timeout with no playback or queue writes by the wait.
4. Cancel a pending wait: verify no dependent action follows.
5. Test multiple Computer devices: verify ambiguous target selection asks rather than guessing.
6. Check queue failures are still reported accurately and never blindly replayed.
