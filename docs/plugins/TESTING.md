# Testing plugins and the plugin host

## Automated

```bash
npm test               # vitest: host, sandbox-free unit tests, and every plugin's tests
npm run test:electron  # the real sandbox inside Electron (needs a display, or xvfb on Linux)
```

**`npm test`** covers:

- `src/main/workspace/paths.test.ts`: the workspace boundary.
  - Traversal (`..`, `\`, absolute, drive letters, UNC, `~`, `:` streams, trailing dots, NUL)
  - Symlinked folders and files, inside and outside
  - Links used as parents for new files
  - Hard-linked writes, secret and VCS names, denied folders
  - Create, edit, rename and delete, plus read-only reference roots
- `src/main/plugins/manifest.test.ts`: manifest and schema validation.
  - Ids, API version, semver and entry paths
  - Unknown fields and permissions, IP and local hosts, unsafe link schemes
  - Duplicate, dotted and over-long tool names, unsupported schema keywords
  - Auth host rules, secret fields
  - Permission strings and tool naming
- `src/main/plugins/net.test.ts`: network policy.
  - Blocked address ranges, URL rules and loopback DNS
  - Redirect re-checks, the token not following redirects, POST→GET on 303
  - The redirect limit, dropped headers, redaction
- `src/main/plugins/oauth.test.ts`: PKCE.
  - The RFC 7636 challenge, authorize URL, state check and declined consent
  - No client secret, refresh-token retention, revoked tokens
  - Token endpoint permission
- `src/main/plugins/host.test.ts`: the host with real builds, running plugin code in a Node `vm` stand-in for the sandbox. The vm isn't a security boundary; it's only used to exercise the host's checks.
  - Validation, imports outside the folder, review diffs and the sandboxed test run
  - Permission approval, and an update asking for more
  - Automatic rollback when an update fails to load, missing handlers, manual rollback
  - Tool removal on disable, stale calls refused after disable or update, unknown tools, schema rejection
  - Write approvals, crash restart and cancellation
  - Host checks: network allowlist, token injection and redaction, 401 refresh, link prefixes, capabilities outside a call, secrets kept out of config, storage permission
  - Persistence across updates, uninstall, restart
  - The Spotify plugin through the host: token never visible, a declined queue sends nothing, malformed URIs refused at the host, `spotify:` links only
- `src/main/plugins/migrate.test.ts`: moving the old Spotify settings into the plugin without overwriting anything.
- `src/main/history.test.ts`: calls to tools that aren't offered any more are sent as text.
- `plugin/*/tests/*.test.ts` (Spotify: 23 tests), run through `src/plugin-sdk/plugin-tests.test.ts`.
  - Search, now playing, devices and rate-limited reads
  - Queue validation, order, partial success, no device, Premium
  - No retry after a 429, server error or dropped connection
  - Read tools never change playback, queueing never starts playback, `open` limits, transfer rules

**`npm run test:electron`** (`test/electron/sandbox.e2e.ts`) starts real plugin windows. It checks:

- no Node.js, Electron or IPC in plugin code
- that fetch, https, `file://`, XHR, WebSocket, images, iframes, beacons, navigation and popups don't reach a local server
- the capability bridge
- cancellation, timeouts, a busy loop being killed, a forced renderer crash, disposal (disable) ending in-flight calls
- tests running in the sandbox without network

On Linux as root it adds `--no-sandbox`, so the OS-level sandbox itself is not part of that run.

## Manual end-to-end checklist (the MVP demo)

Run with `npm run dev` on Windows, with an API key, a vault and a Spotify Premium account. See [../SPOTIFY.md](../SPOTIFY.md) for the Spotify app setup.

1. **Open the Plugins workspace and select Spotify.** Go to Code mode, choose Workspace **Plugins**, then pick **Spotify (spotify)**. The workspace line shows `Plugins · plugin/spotify` once you send.
2. **Edit only its folder.**
   - Ask: "Bump the version to 1.0.1 and make the search tool's default limit 6."
   - The stages show reads and writes under `plugin/spotify` only.
   - Then ask it to read `../../src/main/index.ts` or `C:\Windows\win.ini`. Both are refused.
3. **Validate and test without activating.**
   - Ask it to validate and test. It runs `plugin_validate` and `plugin_test` and reports the results.
   - In Settings → Plugins, Spotify still runs the old version, or is "Not activated".
4. **Review and grant permissions.**
   - Settings → Plugins → Spotify → **Review update** (or **Review and activate** the first time).
   - Check the version change, the file diff and the permission list. Tick each new permission.
   - **Run tests** shows every check passing.
5. **Activate and connect.**
   - Click **Activate**, enter the Client ID under Configuration and **Save configuration**.
   - Then **Connect**: approve in the browser, and Account shows _connected_.
   - If you used Spotify before this update, the Client ID and sign-in were carried over, but you still have to activate.
6. **Tools are available.** In a new Chat, ask "What's playing on Spotify?" You see _Checked what is playing_ with the right track.
7. **Ask for five songs using saved preferences.** Fill in `Areas/Music Preferences.md` (or let it ask you), then ask "Queue five songs for focused work." It reads the preferences note with the vault tools; the plugin itself has no vault access.
8. **Real tracks, queued on the intended device.**
   - Stages show one _Searched Spotify_ per song.
   - Then an approval card appears: _Spotify wants to: Spotify queue: 5 tracks_. Click **Allow**.
   - If several devices are available and none is active, it asks which one.
9. **Honest outcome.**
   - The reply lists what was accepted and what wasn't.
   - Spotify's queue shows the songs in that order, and nothing started playing.
   - Then ask "Recommend three more like that." It answers in chat, and no approval card appears.
10. **Disable.**
    - Settings → Plugins → Spotify → **Disable**.
    - In the same chat, ask to queue another song. The tools are gone, and the assistant says Spotify isn't available.
    - Nothing reaches Spotify, and the plugin's Health stays quiet.
11. **Roll back a faulty update.**
    - **Enable** again.
    - In the Plugins workspace, ask it to add `throw new Error('broken')` at the top of `src/index.ts`, bump the version to 1.0.2 and validate. Validation passes, because it can't run your code.
    - Review and **Activate**. It fails with "1.0.2 failed to start … 1.0.1 is still the active version", and Spotify keeps working.
    - Undo the change, activate a version that loads but behaves wrong, then click **Roll back to 1.0.1**. The earlier build is back without rebuilding.

Also check on Windows:

- **OS sandbox.** Task Manager → Details → enable the _Command line_ column. The plugin renderer processes (`--type=renderer` with a `custard-plugin-…` partition) must not have `--no-sandbox`.
- **General Code.**
  - Pick a project folder and ask for a change. Files outside it are refused.
  - Pick the Custard repository itself. A warning asks for core access. Cancel, and the folder isn't used.
- **Write approvals.** Click **Don't allow** on a queue card. The reply says nothing was queued, and Spotify shows nothing new.
- **Uninstall.** Afterwards Spotify shows "Not activated", the Client ID is gone, and `plugin/spotify` is still there.
