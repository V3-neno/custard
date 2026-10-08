# Player availability and manual Refresh

Follow-up patch to the staged 1.3.1 widget. Same manifest version, new source/build hash; review the newly staged build rather than assuming the previously activated 1.3.1 contains this patch.

## Changes

- Prominent **No active Spotify device** title for fresh inactive/missing-ID/unavailable playback snapshots, rather than a generic missing-song title. Track metadata is hidden in that state.
- Short guidance: start playback in Spotify, then Refresh. An available Connect device is not automatically an active one.
- **Refresh** in compact and expanded layouts calls only existing `now_playing`. It does not enumerate/activate devices, open Spotify, start playback, or transfer it.
- Button says **Checking…** during a read; status says **Checking Spotify…** unless an actionable write outcome needs to remain visible.
- Separate concise stale/read-error/rate-limit/unknown-state messages. No raw diagnostics or routine success paragraphs restored.
- Refresh cancels an unsent seek draft and respects existing foreground visibility, overlapping-read and pending-write guards, provider cooldown and 24/minute call budget. No new polling or retry loop.
- A refresh never erases a pending/unknown/failed/refused action notice or implies that an uncertain write was resolved. Normal controls continue to use the existing device guards and approvals.

## Scope and permissions

Only plugin UI/helper/tests/docs changed. No manifest/allowlist changes, new permissions, storage, OAuth scope or reauthorization. Existing network hosts, `widget:player` and action approvals remain. The automatic foreground read lifecycle remains 15 seconds.

## Verification

New mocked tests cover no-active rendering, manual recovery, checking indicator, rapid clicks/overlapping host refresh, hidden/pending/disposed states, stale/error recovery, cooldown and preserved unknown action notices. Existing regression suite must also pass; see actual validator/test results in the conversation.

Separately, with the user's explicit permission, Spotify accepted transfer/start on EMAX. One subsequent live read observed ENOUGH TO BE by Presley Regier playing on EMAX. That checks playback, not this revised widget's rendering or refresh button.

After validation/tests, open Settings → Plugins, review and activate the new staged build. Reopen the player on request. Manually check compact/expanded sizing, Refresh changing briefly to Checking, and recovery after starting playback externally. An immediate response can make Checking very brief. Real Chromium layout/accessibility and live button interaction remain unverified. Never stop or transfer live playback merely to create a no-device test without permission.
