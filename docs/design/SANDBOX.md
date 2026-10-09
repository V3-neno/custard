# HTML preview: threat model

Design's preview runs HTML, CSS and JavaScript the model wrote. That code is
untrusted: it may be wrong, or shaped by text from a web page, a plugin
result, a reference file or a skill. This is the threat model the preview
is built against (Phase 2); none of it is implemented yet.

## What is being protected

- Custard's privileged surfaces: the app window's preload (`window.custard`),
  its IPC channels, the plugin and widget bridges, Node.js.
- The vault, the user's files, Custard's own files, extension folders.
- Credentials: API keys, plugin secrets, OAuth tokens, cookies of any session.
- The user's network position: no requests to the internet or the local
  network (routers, localhost services, cloud metadata addresses).
- The user's attention and trust: a page posing as Custard, or asking for a
  password, must not look like Custard asking.

## Runtime facts (Electron 39, as Custard uses it)

- Widgets already run untrusted plugin UI in a `WebContentsView` with
  Chromium's sandbox, context isolation, no Node, a locked session that
  cancels every request except `data:`, denied permissions, and no navigation
  or popups (`src/main/plugins/runtime.ts` `lockContents`, `lockedSession`).
- The app's IPC refuses plugin and widget contents (`src/main/ipc.ts`).
- An iframe in the app's own renderer would share its process and sit next
  to `window.custard`; it is not used.

## Design

| Threat                            | Control                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reaching Custard's APIs           | Separate `WebContentsView` with **no preload at all**, `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, `webSecurity: true`. Its webContents is added to the IPC refusal list.                                                                                                                                                                                                                                                                                                                    |
| Reading local files               | Served only through a custom scheme (`custard-preview://<random>/...`) registered on the preview's own session, mapping to one version's folder; the handler resolves paths and refuses `..`, links and anything outside that folder. `file:` is cancelled.                                                                                                                                                                                                                                                           |
| Network requests                  | The preview session cancels every request whose scheme isn't the preview scheme, `data:` or `blob:` (covers fetch, XHR, WebSocket, images, fonts, iframes, navigations). A CSP header is added to every response too (`default-src` the preview origin plus `data: blob:`, inline styles and scripts allowed, `connect-src 'none'`, `form-action 'none'`). WebRTC is limited with `setWebRTCIPHandlingPolicy('disable_non_proxied_udp')`. Any exception later is a per-version, per-host allowlist the user approves. |
| Navigation and popups             | `will-navigate` and `will-redirect` are cancelled except same-document; `setWindowOpenHandler` denies. Links meant to leave the page are shown as not connected.                                                                                                                                                                                                                                                                                                                                                      |
| Downloads                         | `will-download` on the preview session is cancelled. Export is Custard's own action, never the page's.                                                                                                                                                                                                                                                                                                                                                                                                                |
| Permissions and devices           | Permission request and check handlers deny everything (camera, microphone, geolocation, notifications, clipboard read, fullscreen, pointer lock, MIDI, HID, serial, USB). Device permission handler denies.                                                                                                                                                                                                                                                                                                           |
| Persistence and cross-talk        | Non-persistent partition per preview (`preview-<random>`), so no storage, cookies or cache survive or are shared with the app, plugins, widgets or other previews.                                                                                                                                                                                                                                                                                                                                                    |
| Hangs and resource use            | Its own renderer process; on `unresponsive` or a watchdog timeout, `forcefullyCrashRenderer()` and report it. Previews are only built from complete HTML, never re-run per streamed chunk.                                                                                                                                                                                                                                                                                                                            |
| Pretending to be Custard          | The preview sits inside a frame Custard draws, labelled as a generated preview; dialogs (`alert`, `confirm`, `prompt`, `beforeunload`) are suppressed. A form in the preview never sends anything (requests are cancelled).                                                                                                                                                                                                                                                                                           |
| Prompt injection through the page | Page text and runtime errors reach the model only as data, through Custard's own checks; the page can't call tools or change permissions.                                                                                                                                                                                                                                                                                                                                                                             |
| Error reporting                   | Runtime errors come from the preview's `console-message` events, bounded in count and length; nothing is read through a bridge.                                                                                                                                                                                                                                                                                                                                                                                       |

## Checks Phase 2 must prove

- A page can't see `window.custard`, `require`, `process`, or any IPC.
- fetch, XHR, WebSocket, `<img>`, `<link>`, `<iframe>`, `<form>`, `navigator.sendBeacon`
  and `location =` to the internet, localhost and a LAN address are all
  cancelled (seen at the session, not only by the page failing).
- `file:` URLs and `../` paths through the preview scheme are refused.
- `window.open`, `target=_blank`, downloads and permission prompts do nothing.
- An infinite loop is contained and reported; the app stays responsive.
- Nothing from a preview persists after it closes.

## Tests (Workstream D)

`test/e2e/design-security.mjs` with `test/e2e/mocks/d-security.mjs`, on top
of A's probe in `design-workspace.mjs`. Linux, xvfb, mock model, 2026-10-09,
against A's preview at ac9a4a2.

| Check | Result |
| --- | --- |
| Own top frame, no opener | Pass |
| https to a LAN address and to 127.0.0.1, `file:`, `custard-media:` | Refused |
| `%2e%2e`, `..%2f` and `..%5c` paths through the preview origin | 404 (only recorded files are served) |
| EventSource, `import()`, a blob worker's fetch, CSS `@import` and `@font-face` | Refused; nothing reached the mock server |
| `navigator.clipboard.writeText`, `requestFullscreen` | Refused; clipboard and window unchanged |
| `postMessage` from the page and a nested frame | Nothing reached the app window |
| An `obsidian://` link click, `location = 'spotify:…'`, a `data:` navigation, `location =` to the mock server | No navigation; `shell.openExternal` never called |
| Storage and cookies between the hidden check run and the visible preview | Not shared |
| localStorage and IndexedDB between two previews | Not shared; one preview alive at a time |
| **`window.print()`** | **Fails at ac9a4a2:** opens the system print dialog (GTK under xvfb), freezes the preview and wedged the app's shutdown. With `sandbox allow-scripts allow-same-origin` added to `PREVIEW_CSP` (no `allow-modals`), print is refused, and this suite (34 checks) and A's (67) pass. Sent to A. |

Not tested: WebRTC (UDP isn't visible to the mock server), drag and drop out
of the preview, and anything on Windows or macOS.

## Remaining risks

- A Chromium sandbox escape would be a browser bug outside Custard's control;
  keeping Electron current is the mitigation.
- Visual spoofing inside the preview frame can't be prevented entirely; the
  frame's labelling is the control.
- Timing side channels inside the preview process aren't addressed beyond
  process isolation.
