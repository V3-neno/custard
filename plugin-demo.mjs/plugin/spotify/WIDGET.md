# Spotify player widget — 1.3.1

## This revision

User feedback: the existing player followed live playback, but visible diagnostic paragraphs and scrolling cluttered the player. This revision:

- Removes visible playing/estimated-progress text, raw tool outcomes, Back explanation paragraphs, seek-warning paragraph and snapshot/artwork footer.
- Keeps Back disabled with a reason in its tooltip/accessibility label. No native Previous substitution.
- Keeps seek's approval-time track-change warning in hover/accessible help rather than the main view.
- Hides the scrollbar (including Chromium's thumb) without disabling wheel/keyboard overflow access on narrow layouts.
- Removes the Seek button. Native timeline input previews; `change` requests one seek at pointer release or a native keyboard change. No write on intermediate `input`, no debounce, no pointerup duplicate, no timer-delayed write.
- Adds volume −/+ buttons, observed percent, and five-percentage-point adjustments through the existing `adjust_volume` write tool. Unknown/unsupported volume is disabled; end-limit buttons are disabled. This is Spotify device volume, not Windows/Bluetooth volume.
- Shows only concise actionable pending/refused/failed/unknown/stale notices. Routine success is silent, not a verification claim. Full tool results remain unchanged for chat; the controller does not display raw provider messages.

## Host contract and registration

Widget ID `spotify/player`; widget API 1; entry `widget/player.ts`; input empty object only. Custard owns placement, header, close, compact/expanded switch, approvals and secure bridge. Spotify owns its internal DOM/styles/state. No core modifications or invented APIs.

Compact 240 px, expanded 330 px; declared min/max 200–360. Internal overflow remains accessible but the scrollbar is hidden. Expanded adds Restart and larger/wrapping metadata. Very narrow widths can still need wheel/keyboard scrolling; Windows sizing must be checked manually.

Allowlist: `now_playing`, `pause_playback`, `resume_playback`, `next_track`, `seek`, **`adjust_volume`**. Local tool names, not prefixed names. No native Previous, queue, transfer or open in the widget allowlist.

Foreground refresh: host-triggered every 15 seconds, with a sliding 24-call/minute plugin budget beneath the host limit of 30. No independent network polling, workers, automated playback actions or history collector. Showing/updating/restoring never authorizes a playback write. Dismissal is respected.

Development references inspected: exposed API/manifest/widget documentation and existing plugin implementation/tests. `examples/spotify` was requested but unavailable. Core/Git/PR state cannot be inspected from this plugin-only workspace. Widget-capable SDK/build validation does not establish any PR merge status. Older hosts can reject the `widgets` manifest field despite `apiVersion: 1`.

## Data and security

`src/widget-data.ts` projects the final existing `now_playing` metadata into bounded widget-only `ToolResult.data`; no additional Spotify request. Chat content remains byte-for-byte unchanged. Fields are explicitly allowlisted, capped, and validated. New optional `volume` is an integer 0–100 or null; `volumeSupported` is true only on explicit reported support. Older/malformed data never enables volume control by assumption.

Provider text uses `textContent`, never interpolated HTML/CSS. No credentials/configuration/provider URLs cross into the widget. Payload size stays below the host's 64 KB limit. Artwork always uses the local musical-note fallback: the SDK still lacks a safe binary-response reader. No remote image, proxy, CDN permission, cache or sandbox bypass.

A future binary response capability is a separate core proposal, not part of this revision: bounded bytes, MIME validation, cancellation and explicit CDN permissions would be required before implementing artwork retrieval.

## Interaction and approval semantics

All writes call the existing guarded tools synchronously from a native click/change event. The bridge enforces a genuine recent input gesture, allowlist and normal write approval. No awaited preflight in the widget before `ctx.call`; tools perform their own existing preflight after approval.

- Pause/resume and Next are unchanged. Resume never replaces context or queue.
- Timeline `input` captures an unsent draft plus observed URI/device; animation does not overwrite the draft. `change` consumes it once. Duplicate change events cannot resend it. Hide, presentation switch, blur, pointer cancellation, stale state or observed URI/device changes discard it. Invalid positions and positions at/beyond duration are refused.
- Expanded Restart remains separate seek zero without resume.
- Seek is still **not atomically track-bound**. Draft checks only protect already observed changes before dispatch. Another track can begin during approval or after preflight; Spotify's endpoint does not accept a conditional track identity. Hover and accessible help retain the warning. Do not claim this revision resolves that race.
- Volume buttons request signed ±5 percentage-point changes; controller maps to `direction` + `amount_percent: 5` with observed `device_id`. The service reads fresh volume and clamps to 0–100, never treats the displayed value as an absolute command. Unknown support/value, missing/inactive/restricted device, stale data, pending action or active read disables controls. Paused playback can still adjust volume without resume. The existing service may permit older devices without a support flag; the widget deliberately disables unknown support.
- No optimistic volume update: UI changes only with a fresh snapshot. Playback progress is still a local estimate between snapshots, clamped at the end; reaching the end never sends a command.
- Back remains unavailable due to missing reliable listening occurrences. See `HISTORY-BACK-BLOCKERS.md`. No listening data, OAuth history scope, cursor or fallback was added.

## Lifecycle and outcomes

Mount is a synchronous hidden shell, including restore. Visibility/host refresh initiate reads only. One read at a time, generation guard ignores pre-hide or disposed results. An action locks all writes; repeated clicks do not enqueue actions. Controls stale after 45 seconds or a read failure. Provider rate-limit messages impose at least 60 seconds cooldown, extended by Retry-After; only a later host event can retry a read. The existing read tool's bounded retry remains unchanged.

Raw command outcomes stay internal; the player renders:

| Outcome | Visible UI / behavior |
| --- | --- |
| Pending | “Waiting for approval…”; approval/response shares one lock |
| Completed | No success paragraph; at most one immediate visible/in-budget read; not verified playback |
| Not run | “Action not run.”; no follow-up or retry |
| Failed | “Action failed. Check Spotify or your connection.”; no retry |
| Unknown (including lost bridge response) | “Result unknown — check Spotify before trying again.”; at most one read, no automatic write replay |

Both host status and plugin `Not run:`/`Outcome unknown:` prefixes are interpreted. Unknown notices are not erased by a later matching snapshot, since it cannot establish causality. No timer silently clears an uncertain result. Read failures keep state stale and produce a short availability notice, not raw diagnostics.

Unmount removes listeners, animation and draft references and ignores late results. Host cancels waiting approvals/reads; an already-dispatched write can still finish. There is no widget-side cancellation API. Hide stops new calls but cannot revoke dispatched writes. Animation is foreground-only and never performs network actions.

## Permissions and activation

Version 1.3.1 retains `widget:player` and existing network (`api.spotify.com`, `accounts.spotify.com`), open (`spotify:`), OAuth (`user-read-playback-state`, `user-read-currently-playing`, `user-modify-playback-state`) and write-action grants. **Only the widget tool allowlist expands**, to include existing `adjust_volume`; its `effect: write` and normal approval are unchanged. No new OAuth scope, reconnect requirement, storage, host or secret.

Open **Settings → Plugins → Spotify**, review 1.3.1 and the changed allowlist, then activate. The assistant cannot activate it. A build passing tests does not change the currently enabled player. Ask to reopen the player after activation if needed; do not auto-show after dismissal.

## Verification status

- Implemented in this revision: quiet UI, hidden scrollbar, release-to-seek, volume controls, bounded volume metadata, updated guidance and tests.
- Mock tests cover widget registration, safe metadata, lifecycle, old controls, concise outcomes, one-shot seek commit/cancel, observed device/track changes, volume mapping/value validation/support/limits/pending locks/uncertain failures, and existing playback-tool regressions. See actual validation/test tool results for completion status.
- The user's report confirms the **previous** widget followed playback. It does not verify this revised implementation, live volume controls, drag-release gesture approval or layout.
- No Spotify playback calls were made during these edits. Mock DOM/bridge tests do not prove native Chromium event order, gesture enforcement, real approval cards, Windows DPI/layout/focus or screen-reader behavior.

## Manual checklist — revised behavior not live-verified

Only make playback changes with explicit user permission.

- [ ] Review/activate 1.3.1 and reopen on request. Showing alone never opens Spotify, starts playback or changes volume.
- [ ] Check compact/expanded, light/dark themes, narrow widths, long metadata and Windows 100/125/150/200% DPI. No scrollbar/thumb or diagnostic paragraphs; all controls reachable by wheel/keyboard when overflow occurs.
- [ ] Drag timeline for longer than five seconds: only preview while dragging; release produces one normal approval. Check gesture acceptance in the real host. No extra Seek button or duplicate command. Decline and confirm no change.
- [ ] Allow one seek; compare a separate API snapshot and actual player position. Do not count acceptance as verification. Check queue/context before and after.
- [ ] Check touch cancellation, pointer cancellation, blur, hide, track/device changes and presentation switch during a draft: no stale automatic seek. Test native keyboard arrows/Home/End and pending key-repeat suppression. Host Tab-entry is a separate known limitation, not solved here.
- [ ] During approval change the track: document the existing seek-identity race, not a guarantee of track binding. Change device: existing tool should refuse mismatched active ID.
- [ ] Click volume −/+ once each with permission: one normal approval for five percentage points. Check actual Spotify volume, including 0/100, paused playback and a device with unsupported/unknown volume. No optimistic percentage, resume, transfer or OS-volume change.
- [ ] Decline/refuse/fail/unknown outcomes stay concise. Unknown results are not automatically repeated; pending double-clicks do not enqueue writes. Use mocks for dangerous fault injection.
- [ ] Restart while paused remains paused. Back stays disabled with tooltip; it is not native Previous.
- [ ] Verify Narrator/NVDA labels, focus indication, accessible seek warning, concise status and no per-frame time announcements. Native view Tab-entry/exit needs host-level testing.
- [ ] Minimize/hide/close during reads or approvals; no new hidden calls, dangling animation, spontaneous reopening or late DOM changes. Already-dispatched writes may finish.
