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
