# Previous-track and volume discrepancies — open investigation

## Reported live observations

The user reports that Next moved from Marbella to Heartbreaker, but Previous then showed REA rather than returning to Marbella. A requested volume change from 11% to 6% was accepted, but the subsequent playback snapshot reported 5%.

These are unresolved behavior discrepancies, not successful exact-target verification. This document does not establish that the inspected workspace build was the active build during that test. The original per-call inputs, raw responses, timestamps and host request trace were not available in this investigation.

## Source-level checks

- `src/index.ts` delegates each tool invocation once.
- `src/playback.ts` maps Previous to `POST /me/player/previous`, not Next, Seek or Play. It supplies the device ID from its preflight snapshot; an explicit guard must match. It does not compute/select a previous track URI or keep playback history.
- With preflight volume 11 and lower amount 5, integer arithmetic computes 6. `SpotifyClient` serializes `volume_percent=6` without a float conversion, rounding or percentage-to-fraction conversion.
- `playbackMetadata` copies valid integer Spotify volume values unchanged. A valid 5 is not derived from rounding a received 6.
- New playback writes do not opt into the client's retry. They do not implicitly replay, transfer or replace context/queue.
- The SDK contract permits host refresh/retry after a rejected 401. Host behavior and duplicate assistant tool invocations cannot be ruled out from plugin source alone; source inspection is not a trace of the original run.

`tests/reported-mismatches.test.ts` adds synthetic public-handler tests for the exact volume arithmetic/request URL, preservation of a discrepant readback, and one Next plus one Previous request without a hidden history replacement or correction write. These tests do not emulate the TV or prove why Spotify returned the reported states.

## Evidence still needed

Before changing command behavior, inspect the original chat's actual tool calls if available: number/order of calls, inputs, acceptance text, device IDs, track URIs, observation timestamps, shuffle state and volume snapshots. Confirm the active plugin version/build matches the reviewed source. The plugin filesystem workspace cannot read Custard's core logs or active-build registry.

A controlled live reproduction requires explicit approval for playback writes, not merely permission to inspect source:

1. Previous: user establishes a known starting track/context on the TV and confirms whether tracks were manually queued. Record one playback snapshot. Request Next once, observe once; request Previous once, observe once. Keep the explicit TV device ID guard, avoid other controllers, and record what the TV itself displays. Do not attempt a corrective second Previous or force-play the remembered track.
2. Volume: at a safe low level, record Spotify's volume and the TV's displayed volume. Send one explicitly approved small relative change and record the returned target; take one subsequent snapshot and compare with the TV display. Do not automatically compensate with +1 or repeat until the numbers match. If further trials are needed to identify rounding/step patterns, agree on each trial rather than introducing polling or automatic calibration.
3. Compare native Spotify/TV behavior using a separately agreed equivalent setup. A controlled comparison helps separate plugin request issues from Spotify's history selection and TV volume mapping; it must not be treated as an identical state unless the setup actually is equivalent.

No live playback writes were used for this investigation. Device quantization, stale state, concurrent control, queue/context history and duplicate calls remain hypotheses, not findings. No speculative rounding adjustment or history-emulation fix has been applied. No new permissions are requested.
