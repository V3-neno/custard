# Spotify in Custard

Custard can search Spotify, see what's playing, list your devices, add songs to your queue, open the Spotify app and move playback between devices. Custard's starter vault has no music skill or preferences note: the plugin's own instructions guide how it is used, and you can add your own skill or note in your vault if you want one. If you turn on the plugin's event log (Manage → Spotify), the starter skill `spotify-preferences` can sum it up into a new note of *inferred* likes and dislikes in `Custard/Plugins/Spotify/Preferences/`; it never edits your own notes. Existing vaults get the skill from Settings → Obsidian vault → **Add missing starter skills and notes**.

Spotify is a **plugin** (`plugin/spotify`), built only on the public plugin API: Custard's core has no Spotify code. See [plugins/README.md](plugins/README.md) for how plugins are reviewed, activated, disabled and rolled back.

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
5. In Custard, open **Plugins** mode → Spotify → **Manage**. Click **Review and activate**, read the permissions, tick them and click **Activate**.
6. Under **Configuration**, paste the Client ID and click **Save configuration**. Then click **Connect** under Account. Your browser opens Spotify's consent page; approve it and come back. Account shows _connected_.
7. Vaults made before this change may still have `Custard/Skills/music` and `Areas/Music Preferences.md` from the old starter vault. They are your files now: Custard doesn't update or remove them, and you can delete them in Obsidian.

**Upgrading from the built-in Spotify:** your Client ID and sign-in are moved into the plugin automatically the first time this version starts, but the plugin still has to be reviewed and activated (step 5).

Custard listens on port 43821 only while you're signing in. If something else uses that port, Connect fails with a clear error.

## How it's built

| Piece                                                                                 | File                                             |
| ------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Manifest: tools, schemas, permissions, OAuth settings                                 | `plugin/spotify/plugin.json`                     |
| Tools, validation, queue reporting                                                    | `plugin/spotify/src/tools.ts`                    |
| API client: retry reads after 429, error messages                                     | `plugin/spotify/src/client.ts`                   |
| Rules for the model while Spotify is enabled                                          | `plugin/spotify/instructions.md`                 |
| Tests                                                                                 | `plugin/spotify/tests/`                          |
| PKCE sign-in, token storage and refresh, network policy (generic, used by any plugin) | `src/main/plugins/oauth.ts`, `host.ts`, `net.ts` |

**Scopes:** `user-read-playback-state` (player and devices), `user-read-currently-playing` (needed to read the queue back), `user-modify-playback-state` (queue and transfer). No listening history, library or profile email.

**Tokens** are held by Custard's plugin host, encrypted with Windows secure storage (`safeStorage`) in Custard's app data folder. The plugin never sees them: it asks the host to add the token to requests for `api.spotify.com`. They never go into the vault, prompts or logs. Spotify has no token revocation endpoint, so **Disconnect** deletes the tokens on this computer; to remove Custard's access entirely, also remove it at [spotify.com/account/apps](https://www.spotify.com/account/apps/).

### Tools

| Tool                         | What it does                                                                          | Changes playback?  |
| ---------------------------- | ------------------------------------------------------------------------------------- | ------------------ |
| `spotify__search`            | Finds tracks (title, artists, album, explicit, length, URI)                           | No                 |
| `spotify__now_playing`       | Current track, play state, device                                                     | No                 |
| `spotify__devices`           | Available devices and which is active                                                 | No                 |
| `spotify__add_to_queue`      | Adds 1–10 tracks to the end of the queue, in order                                    | Adds to queue only |
| `spotify__open`              | Opens the Spotify desktop app (optionally on a track, album, artist or playlist page) | No                 |
| `spotify__transfer_playback` | Moves playback to a device; `play` must be set to true or false                       | Yes, when asked    |

Custard enforces these rules in code, not only in prompts:

- **You approve each action that changes something.** Queueing, opening the app and moving playback are write tools: Custard shows an approval card (Allow, Allow for this chat, Don't allow) before the plugin runs, unless you turn that off for a tool in Plugins mode (**Manage** on the plugin's card). Reading (search, now playing, devices) doesn't ask.
- **Inputs are checked by the host** against the manifest's schemas before the plugin runs, e.g. track URIs must match `spotify:track:` plus 22 characters.

- **Only real tracks are queued.** URIs must be valid track URIs _and_ must have been returned by `spotify__search` or `spotify__now_playing` while the plugin runs. A made-up or misremembered ID is refused before anything is sent.
- **Queueing never starts, pauses or replaces playback.** It only calls the queue endpoint.
- **Transferring requires an explicit `play` choice** and checks the device exists and isn't restricted.
- **Opening is limited to `spotify:` URIs.** The plugin's only link permission is `spotify:`, checked by the host, which uses Electron's `shell.openExternal`, with no shell commands.
- **The queue is never retried blindly.** Spotify's queue endpoint takes one track per call and isn't idempotent, so Custard adds tracks one at a time and never retries a queue call after a rate limit, server error or dropped connection, since that could add a song twice. Errors that would fail every later track (no active device, Premium required, expired sign-in, rate limit) stop the run. Remaining tracks are reported as _not attempted_. A track Spotify rejects on its own is reported and the rest continue.
- **Reports say only what Spotify confirmed.** After queueing, Custard reads the queue back with `GET /me/player/queue` and reports how many of the accepted tracks appear. "Accepted" is never reported as "playing". Spotify doesn't guarantee ordering when other playback changes happen at the same time.

The model decides _when_ to queue, transfer or open, guided by the plugin's instructions (added while it is enabled). A request to recommend is answered in chat. "Queue five songs for focus" leads to one queue call for all five, which you approve once. Playback is only started or moved when you ask.

## Tests

```bash
npm test
```

`plugin/spotify/tests/*.test.ts` run under vitest and in Custard's sandbox (**Run tests** on the review screen). They cover search, now playing, devices, a read retried once after a 429, queue validation (malformed and unsearched URIs, more than 10), order, partial success, no active device, Premium required, a rate limit with no retry, a server error or dropped connection marked unknown and stopped, read tools never changing playback, queueing never starting playback, `open` allowing only `spotify:` URIs, and transfer requiring `play` and refusing restricted or unknown devices. PKCE, token refresh after a 401 and keeping tokens out of results are tested in the host (`src/main/plugins/oauth.test.ts`, `host.test.ts`).

## Manual end-to-end test

1. Complete Setup with a Premium account. In Plugins mode → Spotify → Manage, check Account says _connected_.
2. Open Spotify on your computer or phone and play anything, then pause. This makes a device active.
3. In Custard Chat, ask: **"What's playing on Spotify?"** You should see _Checked what is playing_ with the right track and device.
4. Ask: **"Recommend three songs like this."** It should answer in chat with no queue or playback change, and say these are its own suggestions.
5. Ask: **"Queue five songs for focused work."**
   - If preferences are empty, it asks a couple of questions first. Answer them.
   - The stage lines show your music note being read (if you wrote one), then one _Searched Spotify_ per song, then an approval card for _Spotify queue: 5 tracks_. Click **Allow**.
   - The reply names what was added and anything that wasn't. Check Spotify's queue: the songs are at the end, in that order, and nothing started playing.
6. Close Spotify everywhere, then ask to queue two more songs. It should say there's no active device and offer to open Spotify. Say yes: Spotify opens, nothing plays.
7. With Spotify open on two devices, ask **"Move playback to my phone."** It should list devices and move playback there. It only starts playing if you asked it to.
8. In Plugins mode → Spotify → Manage, click **Disconnect**, then ask what's playing. It should say you need to connect Spotify again.
9. Click **Disable**, then ask to queue a song. The Spotify tools are gone and nothing reaches Spotify.

The full plugin walkthrough, including editing, review and rollback, is in [plugins/TESTING.md](plugins/TESTING.md).

## Known limitations

- Premium and your own developer app are required, and only 5 users can use it.
- Recommendations are the model's own picks checked against Spotify search, not Spotify's recommendation engine, which development-mode apps can't use.
- Listening history isn't used. It would need another scope (`user-top-read` or `user-read-recently-played`) and separate consent; it could be added later as opt-in.
- The `spotify:` link that opens the desktop app isn't documented by Spotify for desktop. It works when the Spotify app is installed and registered, which the Windows app does.
- Player error reasons such as `NO_ACTIVE_DEVICE` and `PREMIUM_REQUIRED` aren't in Spotify's current docs. Custard handles them when present and otherwise falls back to the HTTP status.
- URIs found by search are remembered while the plugin runs. After a restart, disable, update or crash, Custard searches again before queueing.
- None of this has been tried against the real Spotify API from this build. It was tested with a mock Spotify; the live checklist above needs your account.
