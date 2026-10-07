# Spotify in Custard

Custard can search Spotify, see what's playing, list your devices, add songs to your queue, open the Spotify app and move playback between devices. It picks music using `Areas/Music Preferences.md` in your vault and the `music` skill.

## What you need

- **Spotify Premium.** Spotify's player endpoints (queue, transfer) only work for Premium accounts, and since February 2026 an app in development mode only works if its owner has Premium.
- **Your own Spotify developer app.** Custard has no shared app, so you make one (free) and paste its Client ID into Settings. There is no client secret: Custard uses the Authorization Code with PKCE flow.

### Development-mode limits (as of October 2026)

- Up to 5 Spotify users can use the app, and each must be added under **User Management** in the dashboard. Anyone else gets a 403.
- Extended quota is only for registered businesses with large audiences, so a personal app stays in development mode.
- Development-mode apps can't use Recommendations, Audio Features, Audio Analysis, Related Artists or Spotify's editorial playlists. Custard doesn't use them: the model picks songs itself and checks each one with Spotify search.
- Search returns at most 10 results per request.

Sources: [quota modes](https://developer.spotify.com/documentation/web-api/concepts/quota-modes), [Feb 2026 update](https://developer.spotify.com/blog/2026-02-06-update-on-developer-access-and-platform-security), [Feb 2026 changes](https://developer.spotify.com/documentation/web-api/references/changes/february-2026), [Nov 2024 changes](https://developer.spotify.com/blog/2024-11-27-changes-to-the-web-api).

## Setup

1. Go to [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard) and log in with the Spotify account you listen on.
2. **Create app.** Any name and description. Under **Redirect URIs** add exactly:
   ```
   http://127.0.0.1:43821/callback
   ```
   (Spotify doesn't allow `localhost`; the loopback IP is required.) Under APIs, tick **Web API**. Save.
3. Open the app's **Settings** and copy the **Client ID**.
4. If anyone other than the app owner will connect, add them under **User Management**.
5. In Custard, open **Settings → Spotify**, paste the Client ID, click **Save**, then **Connect**. Your browser opens Spotify's consent page; approve it and come back to Custard. Settings shows _connected as \<your name\>_.
6. If your vault was created before this feature, click **Add missing starter skills** under the vault in Settings. It adds `Custard/Skills/music/SKILL.md` and `Areas/Music Preferences.md` and never overwrites anything.
7. Optionally fill in `Areas/Music Preferences.md` in Obsidian. If it's empty, Custard asks a few questions first.

Custard listens on port 43821 only while you're signing in. If something else uses that port, Connect fails with a clear error.

## How it's built

| Piece                                                             | File                                                                                        |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| PKCE sign-in, token exchange and refresh                          | `src/main/spotify/pkce.ts`                                                                  |
| API client: refresh on 401, retry reads after 429, error messages | `src/main/spotify/client.ts`                                                                |
| Tools, validation, queue reporting, Spotify system prompt         | `src/main/spotify/tools.ts`                                                                 |
| Encrypted token storage, loopback server, IPC                     | `src/main/spotify/index.ts`                                                                 |
| Tool registration (both Claude and OpenAI)                        | `src/main/chat.ts`                                                                          |
| Settings UI                                                       | `src/renderer/src/components/SettingsDialog.tsx`                                            |
| Skill and preferences note                                        | `vault-template/Custard/Skills/music/SKILL.md`, `vault-template/Areas/Music Preferences.md` |

**Scopes:** `user-read-playback-state` (player and devices), `user-read-currently-playing` (needed to read the queue back), `user-modify-playback-state` (queue and transfer). No listening history, library or profile email.

**Tokens** are encrypted with Windows secure storage (`safeStorage`) in Custard's app data folder. They never go into the vault, prompts or logs. Spotify has no token revocation endpoint, so **Disconnect** deletes the tokens on this computer; to remove Custard's access entirely, also remove it at [spotify.com/account/apps](https://www.spotify.com/account/apps/).

### Tools

| Tool                        | What it does                                                                          | Changes playback?  |
| --------------------------- | ------------------------------------------------------------------------------------- | ------------------ |
| `spotify_search`            | Finds tracks (title, artists, album, explicit, length, URI)                           | No                 |
| `spotify_now_playing`       | Current track, play state, device                                                     | No                 |
| `spotify_devices`           | Available devices and which is active                                                 | No                 |
| `spotify_add_to_queue`      | Adds 1–10 tracks to the end of the queue, in order                                    | Adds to queue only |
| `spotify_open`              | Opens the Spotify desktop app (optionally on a track, album, artist or playlist page) | No                 |
| `spotify_transfer_playback` | Moves playback to a device; `play` must be set to true or false                       | Yes, when asked    |

Custard enforces these rules in code, not only in prompts:

- **Only real tracks are queued.** URIs must be valid track URIs _and_ must have been returned by `spotify_search` or `spotify_now_playing` during this app session. A made-up or misremembered ID is refused before anything is sent.
- **Queueing never starts, pauses or replaces playback.** It only calls the queue endpoint.
- **Transferring requires an explicit `play` choice** and checks the device exists and isn't restricted.
- **Opening is limited to `spotify:` URIs.** It goes through Electron's `shell.openExternal`, with no shell commands.
- **The queue is never retried blindly.** Spotify's queue endpoint takes one track per call and isn't idempotent, so Custard adds tracks one at a time and never retries a queue call after a rate limit, server error or dropped connection, since that could add a song twice. Errors that would fail every later track (no active device, Premium required, expired sign-in, rate limit) stop the run. Remaining tracks are reported as _not attempted_. A track Spotify rejects on its own is reported and the rest continue.
- **Reports say only what Spotify confirmed.** After queueing, Custard reads the queue back with `GET /me/player/queue` and reports how many of the accepted tracks appear. "Accepted" is never reported as "playing". Spotify doesn't guarantee ordering when other playback changes happen at the same time.

The model decides _when_ to queue, transfer or open, guided by the Spotify system prompt (added whenever Spotify is connected) and the music skill. A request to recommend is answered in chat. "Queue five songs for focus" is permission to queue those five. Playback is only started or moved when you ask.

## Tests

```bash
npm test
```

`src/main/spotify/*.test.ts` cover:

- **PKCE:** the RFC 7636 challenge, the authorize URL and its scopes, state mismatch, declined consent, no client secret sent, refresh-token rotation and revoked refresh tokens.
- **Validation:** malformed and unsearched URIs are rejected before any request, and more than 10 tracks is refused.
- **Queue results:** ordering, partial success, no active device, Premium required, a rate limit with no retry, a server error marked unknown and stopped, and a 401 refreshed once.
- **Permission boundaries:** queueing touches only the queue endpoint, open allows only `spotify:` URIs, transfer requires `play`, and restricted or unknown devices are refused.
- **Read-only tools:** no active player, now playing, no devices, and a read retried once after a 429.

## Manual end-to-end test

1. Complete Setup with a Premium account. In Settings, check it says _connected as \<name\>_.
2. Open Spotify on your computer or phone and play anything, then pause. This makes a device active.
3. In Custard Chat, ask: **"What's playing on Spotify?"** You should see _Checked what is playing_ with the right track and device.
4. Ask: **"Recommend three songs like this."** It should answer in chat with no queue or playback change, and say these are its own suggestions.
5. Ask: **"Queue five songs for focused work."**
   - If preferences are empty, it asks a couple of questions first. Answer them.
   - The stage lines show the music preferences being read, then one _Searched Spotify_ per song, then _Spotify queue: 5 tracks_.
   - The reply names what was added and anything that wasn't. Check Spotify's queue: the songs are at the end, in that order, and nothing started playing.
6. Close Spotify everywhere, then ask to queue two more songs. It should say there's no active device and offer to open Spotify. Say yes: Spotify opens, nothing plays.
7. With Spotify open on two devices, ask **"Move playback to my phone."** It should list devices and move playback there. It only starts playing if you asked it to.
8. In Settings, click **Disconnect**, then ask what's playing. It should say Spotify isn't connected.

## Known limitations

- Premium and your own developer app are required, and only 5 users can use it.
- Recommendations are the model's own picks checked against Spotify search, not Spotify's recommendation engine, which development-mode apps can't use.
- Listening history isn't used. It would need another scope (`user-top-read` or `user-read-recently-played`) and separate consent; it could be added later as opt-in.
- The `spotify:` link that opens the desktop app isn't documented by Spotify for desktop. It works when the Spotify app is installed and registered, which the Windows app does.
- Player error reasons such as `NO_ACTIVE_DEVICE` and `PREMIUM_REQUIRED` aren't in Spotify's current docs. Custard handles them when present and otherwise falls back to the HTTP status.
- URIs found by search are remembered until Custard restarts. After a restart, Custard searches again before queueing.
