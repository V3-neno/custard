# Playback controls handoff — Spotify 1.2.0

Implemented with Custard plugin API v1 only. No widget, core edit, new network host, Bluetooth capability, background task or new polling loop. All paths here are relative to `plugin/spotify/`.

## Tool contract

Every mutation below has `effect: "write"` in `plugin.json`: Custard's existing per-tool action approval applies. Inputs use the existing manifest JSON Schema validation, `additionalProperties: false`, plus defensive runtime checks. All six accept optional `device_id: string` (1–100 characters) as a guard: it must match the active device returned by the preflight snapshot. Omitting it selects that active device. Inactive targets are refused rather than implicitly transferred.

| Full tool name | Additional inputs | Spotify request |
| --- | --- | --- |
| `spotify__next_track` | None | `POST /v1/me/player/next?device_id=...` |
| `spotify__previous_track` | None | `POST /v1/me/player/previous?device_id=...` |
| `spotify__pause_playback` | None | `PUT /v1/me/player/pause?device_id=...` |
| `spotify__resume_playback` | None | `PUT /v1/me/player/play?device_id=...`, **no body** |
| `spotify__seek` | Required `position_ms: integer`, 0–9007199254740991; must be less than known current track duration | `PUT /v1/me/player/seek?device_id=...&position_ms=...` |
| `spotify__adjust_volume` | Required `direction: "raise" \| "lower"`; optional `amount_percent: integer`, 1–100, default 5 | `PUT /v1/me/player/volume?device_id=...&volume_percent=...` |

- Previous uses Spotify's documented **previous track in the user's queue** semantics. It is not an always-restart-current-song operation. Explicit restart is `seek({position_ms: 0})` and does not also resume.
- Resume never supplies context, URIs, offset or position and refuses a missing playback item. It requests continuation of existing playback, not queue/context replacement.
- Seek only accepts a music track with known positive duration. At/beyond duration is refused: Spotify documents that seeking beyond the end advances to the next song. Track changes between preflight and command remain a race; Spotify offers no conditional seek tied to a track URI.
- Volume is a read/modify/write of **percentage points**, clamped to 0–100. It is not a multiplicative percentage or absolute-volume input. Current volume must be known. `supports_volume: false` is refused; an absent flag permits an attempt if volume is known, with API failures reported normally. At a clamped limit the tool reports a no-op and sends no write. Concurrent controllers can race this non-atomic calculation.
- Devices with `is_restricted: true`, inactive devices, missing device IDs, mismatched target IDs, and reported disallow flags are refused. Spotify can impose additional restrictions after preflight (Premium, development-mode account access, device/context support).

## Execution, outcomes and verification

Each new control makes one preflight `GET /v1/me/player`, then at most one write. There is no automatic post-command read, polling, action replay, open, transfer or queue mutation. Requests use the existing `SpotifyClient` and `auth: true`; tokens remain host-managed.

The SDK returns text, not a structured object channel: `{content: string, isError: boolean}`. Command messages distinguish:

- `Not run:` — validation/preflight/cancellation prevented a playback write; `isError: true`.
- `Spotify rejected ...` — an API client-error response; `isError: true`. Includes relevant auth, scope, account, device or rate-limit explanation and numeric Retry-After when provided.
- `Outcome unknown:` — server error or unreliable response after dispatch; `isError: true`. The write may have happened. Never blindly repeat next/previous or relative volume changes. Read/ask before retrying; a snapshot may not resolve ambiguity.
- `Spotify accepted ... Playback has not been verified.` — successful API response, `isError: false`; no verification claim.
- `No change needed ... No volume command was sent.` — volume already at limit, `isError: false`; not API acceptance.

A separately invoked `spotify__now_playing` may observe the requested state later. No automatic verification is claimed. State can lag, another controller can intervene, and equal URIs/repeat can make skips impossible to verify from a snapshot. Do not use a mismatch as permission to replay a command.

Plugin writes do not opt into the client's rate-limit retry. The existing host may refresh and retry a **rejected 401** once, which is different from replaying an uncertain write. Cancellation before dispatch prevents sending; cancellation/timeouts after dispatch cannot revoke a request already sent. Custard's host timeout/unknown-outcome handling remains authoritative.

## Exact playback metadata schema (v1)

`spotify__now_playing({})` keeps the existing human-readable summary and session track-URI registration. It appends **one final line**:

```text
playback_metadata: {"schema_version":1,...}
```

A future consumer should parse only the final line with that exact prefix and then JSON-decode the remainder, check `schema_version`, and tolerate future additive fields. Do not scan for the first matching line: Spotify titles can contain arbitrary text/newlines. This is an additive text-result contract, not a new SDK result type or widget API. The canonical exported TypeScript type is `PlaybackMetadata` in `src/playback.ts`:

```ts
type PlaybackCommand =
  | 'next_track'
  | 'previous_track'
  | 'pause_playback'
  | 'resume_playback'
  | 'seek'
  | 'adjust_volume'

type PlaybackMetadata = {
  schema_version: 1
  observed_at: string
  spotify_timestamp_ms: number | null
  playback_available: boolean
  currently_playing_type: string | null
  is_playing: boolean | null
  state: 'playing' | 'paused' | 'unavailable' | 'unknown'
  position_ms: number | null
  duration_ms: number | null
  track: {
    title: string | null
    artists: string[]
    album: string | null
    cover_artwork_url: string | null
    uri: string | null
    url: string | null
  } | null
  device: {
    id: string | null
    name: string | null
    type: string | null
    is_active: boolean | null
    is_restricted: boolean | null
    volume_percent: number | null
    supports_volume: boolean | null
  } | null
  actions: {
    disallows: Record<string, boolean> | null
    availability: Record<PlaybackCommand, boolean | null>
  }
}
```

### Field semantics

- `observed_at`: ISO-8601 UTC local observation time, after the playback response is read. Not Spotify's state-change time or an ongoing clock.
- `spotify_timestamp_ms`: Spotify's response `timestamp`, when present; preserved separately, never substituted for observation time.
- `playback_available`: whether Spotify returned a playback object rather than a 204/null result. Does not guarantee a controllable device or item.
- `is_playing`/`state`: use Spotify's explicit boolean, or null/unknown if omitted. A 204 is `state: "unavailable"`, `is_playing: null`, not falsely paused.
- `position_ms`/`duration_ms`: non-negative safe integer milliseconds or null. Position is a snapshot, not extrapolated. Duration may describe a non-track item even when `track` is null. Do not seek non-track content through this tool.
- `track`: populated only for a `spotify:track:` item. Episodes, ads, null/unknown items yield null, not fabricated music metadata. Missing artists yield `[]`; missing album, artwork, duration or URL yield null. Artwork is the first non-empty album image URL Spotify returns. Link comes from `external_urls.spotify`; no fabricated link, no download. Track URI remains the source for session queue validation.
- `device`: Spotify identity/name/type and capability hints; absent fields are null. A Spotify Connect device is not proof of a Bluetooth endpoint or local desktop identity.
- `actions.disallows`: boolean flags from `actions.disallows`, or flat `actions` flags if no nested map is supplied. Unknown flag names are retained. `true` means disallowed. Missing actions yield null; a present empty map yields `{}`. Non-boolean fields are excluded.
- `actions.availability`: names correspond to the six new tool short names. Missing device, explicitly inactive device, or restricted device makes all false. Otherwise next/previous/pause/resume/seek map to `skipping_next`, `skipping_prev`, `pausing`, `resuming`, `seeking`: a present disallow map makes these true unless the matching flag is true; missing map makes them null. Volume comes from `supports_volume` (or null). These are **Spotify-reported hints**, not full input/device eligibility or guaranteed account entitlement. Tools additionally require a device ID, an explicitly active device, and command-specific item/duration/volume checks. True does not promise a write succeeds.
- Null is unknown/unavailable, never implicitly zero, false or an empty title.

### Example calls through the current tool system

```json
{"tool":"spotify__seek","input":{"position_ms":90000,"device_id":"<returned active device id>"}}
```

```json
{"tool":"spotify__adjust_volume","input":{"direction":"lower","amount_percent":10}}
```

These illustrate tool names/inputs, not a proposed JavaScript host API. Later UI integration must retain approval and unknown-outcome semantics. No UI transport, artwork loading permissions, subscriptions or widget API are introduced here.

## Permissions and authentication

New approval grants only:

- `action:next_track`
- `action:previous_track`
- `action:pause_playback`
- `action:resume_playback`
- `action:seek`
- `action:adjust_volume`

Unchanged: network `api.spotify.com`, `accounts.spotify.com`; open `spotify:`; no storage; OAuth via `accounts.spotify.com`, with `user-read-playback-state`, `user-read-currently-playing`, `user-modify-playback-state`. Existing action grants for `open`, `add_to_queue`, `transfer_playback` remain.

No new OAuth scopes and no scope-driven reauthorization are needed. If existing authorization is expired/revoked or was originally granted without configured scopes, reconnect in Settings → Plugins. Playback control requires Spotify Premium and applicable developer-app account access. No credentials are stored in plugin files or passed to tools.

## Bluetooth blocker — separate future proposal, not implemented

Spotify's Web API exposes Spotify Connect devices, not OS paired/connected Bluetooth devices or actual audio routing. SDK v1 has no Bluetooth/OS device capability. `spotify__devices` is explicitly documented not to answer Bluetooth connection checks. No fake Bluetooth-check tool is added.

A separate reviewed core/SDK extension would need a narrowly scoped, read-only OS capability (for example `ctx.bluetooth.listConnections()`), a dedicated user-visible permission, Windows host-side implementation, precise paired-vs-connected-vs-audio-route semantics, cancellation/error handling and privacy filtering. The plugin must not use Node, Electron, shell commands, local network requests or Web Bluetooth to bypass the sandbox. This proposal is a blocker report only; no core changes were made.

## Official semantics checked

- [Skip To Previous](https://developer.spotify.com/documentation/web-api/reference/skip-users-playback-to-previous-track)
- [Start/Resume Playback](https://developer.spotify.com/documentation/web-api/reference/start-a-users-playback)
- [Seek To Position](https://developer.spotify.com/documentation/web-api/reference/seek-to-position-in-currently-playing-track)
- [Set Playback Volume](https://developer.spotify.com/documentation/web-api/reference/set-volume-for-users-playback)
- [Get Playback State](https://developer.spotify.com/documentation/web-api/reference/get-information-about-the-users-current-playback)
