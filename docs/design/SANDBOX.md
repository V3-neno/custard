# HTML preview: threat model

Design's preview runs HTML, CSS and JavaScript the model wrote. That code is
untrusted: it may be wrong, or shaped by text from a web page, a plugin
result, a reference file or a skill. This is the threat model the preview
is built against. It was written before Phase 2; it now describes what
`src/main/design/html/preview.ts` does, and "Packaged build" below records
what was verified with Chromium's sandbox on (stabilization 4.1, 2026-10-09).

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

| Threat                            | Control                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reaching Custard's APIs           | Separate `WebContentsView` with **no preload at all**, `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, `webSecurity: true`. Its webContents is added to the IPC refusal list.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Reading local files               | The page is served from `https://<random>.preview.invalid/`. Only the preview's own session knows that origin: its `https` handler (`protocol.handle` on that session) serves only the files recorded on one version, hash checked, and answers 404 for anything else. `.invalid` never resolves anywhere. `file:` and every other scheme are cancelled.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Network requests                  | The preview session cancels every request whose scheme isn't the preview scheme, `data:` or `blob:` (covers fetch, XHR, WebSocket, images, fonts, iframes, navigations). A CSP header is added to every response too (`default-src` the preview origin plus `data: blob:`, inline styles and scripts allowed, `connect-src 'self' data: blob:` so a page can read its own files, `form-action 'none'`, and the CSP `sandbox allow-scripts allow-same-origin` with no `allow-modals`; see `PREVIEW_CSP` in `preview.ts`). WebRTC is limited with `setWebRTCIPHandlingPolicy('disable_non_proxied_udp')`. The session's proxy is a dead address with `proxyBypassRules: '<-loopback>'`: WebRTC's TURN-over-TCP isn't seen by `webRequest`, and without `<-loopback>` Chromium's implicit proxy bypass let it reach services on 127.0.0.1 (found and fixed in stabilization 4.3). Any exception later is a per-version, per-host allowlist the user approves. |
| Navigation and popups             | `will-navigate` and `will-redirect` are cancelled except same-document; `setWindowOpenHandler` denies. Links meant to leave the page are shown as not connected.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Downloads                         | `will-download` on the preview session is cancelled. Export is Custard's own action, never the page's.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Permissions and devices           | Permission request and check handlers deny everything (camera, microphone, geolocation, notifications, clipboard read, fullscreen, pointer lock, MIDI, HID, serial, USB). Device permission handler denies.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Persistence and cross-talk        | Non-persistent partition per preview and per check run (`custard-preview-<uuid>`), so no storage, cookies or cache survive or are shared with the app, plugins, widgets or other previews. Its storage is cleared on close, but Electron has no API to release a session, so each one stays in memory until Custard quits (about 0.7 MB each; see "Resource use").                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Hangs and resource use            | Its own renderer process; on `unresponsive` or a watchdog timeout, `forcefullyCrashRenderer()` and report it. Previews are only built from complete HTML, never re-run per streamed chunk.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Pretending to be Custard          | The preview sits inside a frame Custard draws, labelled as a generated preview; dialogs (`alert`, `confirm`, `prompt`, `beforeunload`) are suppressed. A form in the preview never sends anything (requests are cancelled).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Prompt injection through the page | Page text and runtime errors reach the model only as data, through Custard's own checks; the page can't call tools or change permissions.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Error reporting                   | Runtime errors come from the preview's `console-message` events, bounded in count and length; nothing is read through a bridge.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

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

| Check                                                                                                        | Result                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Own top frame, no opener                                                                                     | Pass                                                                                                                                                                                                                                                                                                                                                                                       |
| https to a LAN address and to 127.0.0.1, `file:`, `custard-media:`                                           | Refused                                                                                                                                                                                                                                                                                                                                                                                    |
| `%2e%2e`, `..%2f` and `..%5c` paths through the preview origin                                               | 404 (only recorded files are served)                                                                                                                                                                                                                                                                                                                                                       |
| EventSource, `import()`, a blob worker's fetch, CSS `@import` and `@font-face`                               | Refused; nothing reached the mock server                                                                                                                                                                                                                                                                                                                                                   |
| `navigator.clipboard.writeText`, `requestFullscreen`                                                         | Refused; clipboard and window unchanged                                                                                                                                                                                                                                                                                                                                                    |
| `postMessage` from the page and a nested frame                                                               | Nothing reached the app window                                                                                                                                                                                                                                                                                                                                                             |
| An `obsidian://` link click, `location = 'spotify:…'`, a `data:` navigation, `location =` to the mock server | No navigation; `shell.openExternal` never called                                                                                                                                                                                                                                                                                                                                           |
| Storage and cookies between the hidden check run and the visible preview                                     | Not shared                                                                                                                                                                                                                                                                                                                                                                                 |
| localStorage and IndexedDB between two previews                                                              | Not shared; one preview alive at a time                                                                                                                                                                                                                                                                                                                                                    |
| `window.print()`                                                                                             | **Fixed in A at 90b1dde** (re-run: 40/40). At ac9a4a2 it opens the system print dialog (GTK under xvfb) and freezes the preview; it isn't stopped or reported. Custard's main process and window keep answering, and choosing another output replaces the frozen preview. A added `sandbox allow-scripts allow-same-origin` to `PREVIEW_CSP` (no `allow-modals`), so print is now refused. |

WebRTC, keyboard focus, crashes and repeated previews are covered by
`test/e2e/preview-platform.mjs` (below). Not tested: drag and drop out of the
preview (Playwright can't drive a drag between two native views), and
anything on Windows or macOS (docs/design/PLATFORM-CHECKLIST.md).

## Remaining risks

- A Chromium sandbox escape would be a browser bug outside Custard's control;
  keeping Electron current is the mitigation.
- Visual spoofing inside the preview frame can't be prevented entirely; the
  frame's labelling is the control.
- Timing side channels inside the preview process aren't addressed beyond
  process isolation.

## Packaged build (stabilization 4.1)

Checked 2026-10-09 on the packaged Linux build (`npm run build:unpack`,
`dist/linux-unpacked`), Electron 39.8.10, Chromium 142.0.7444.265, Node
22.22.1, run as a non-root user under xvfb, **without** `--no-sandbox`, through
`test/platform/packaged-linux.sh`. Chromium used its namespace sandbox
(unprivileged user namespaces available; `chrome-sandbox` not setuid).

Note: Playwright's Electron launcher adds `--no-sandbox` by itself unless
`chromiumSandbox: true` is passed. Every e2e run before this batch therefore
ran without the sandbox, root or not. `test/platform/launch.mjs` now passes it
for packaged runs, and the harnesses assert the switch is absent.

Kernel view per process (`test/platform/sandbox-evidence.mjs`, `/proc/<pid>`):

| Process              | Seccomp filter        | Own user / net namespace | Launch flags                  | Notes                                                                |
| -------------------- | --------------------- | ------------------------ | ----------------------------- | -------------------------------------------------------------------- |
| Preview renderer     | yes (`Seccomp: 2`)    | yes / yes                | none                          | no preload; sees no `window.custard`, `require`, `process`, `Buffer` |
| Main window renderer | yes (`Seccomp: 2`)    | yes / yes                | none                          | `sandbox: true` in `src/main/index.ts` (see "Main window")           |
| GPU                  | no (`NoNewPrivs` set) | no / no                  | `--no-zygote-sandbox`         | software GL under xvfb; recheck on real hardware                     |
| Network service      | no                    | no / no                  | `--service-sandbox-type=none` | Chromium's default on Linux                                          |

With the sandbox on, the same checks pass as in development:
`design-security.mjs` 46/46, `widgets.mjs` 65/65, `preview-platform.mjs`
all, `media-sizes.mjs` all.

Binary fuses as packaged (`@electron/fuses`): RunAsNode **on**,
EnableNodeOptionsEnvironmentVariable **on**, EnableNodeCliInspectArguments
**on**, EnableEmbeddedAsarIntegrityValidation off, OnlyLoadAppFromAsar off,
EnableCookieEncryption off, GrantFileProtocolExtraPrivileges on. Turning
these off is a release decision (the inspect fuse is what the e2e harnesses
drive the app through); see the stabilization report.

## Resource use (stabilization 4.3)

`test/e2e/preview-platform.mjs`, 200 show/hide cycles of one preview,
packaged, sandbox on: no webContents or renderer process is left behind, but
the browser process grows linearly, about **0.7 MB per preview** (260 MB at
25 cycles, 376 MB at 200). Every `design_html` call adds one more (its check
run). The growth is the in-memory sessions Electron keeps. Options are in the
stabilization report; none is applied here, because reusing sessions changes
the isolation model above.

A page that fills its memory is stopped by Chromium's heap limit in about
30 s and reported as stopped; a page that never yields is stopped by the
watchdog. The app keeps answering in both.

## Keyboard

Tab moves from the composer into the preview, and through the page's own
controls in order, but never back out: the page keeps focus. **F6** returns
focus to the app; it is handled before the page sees the key, so a page can't
block it.

## Main window (sandboxed since this change)

`src/main/index.ts` creates the app window with `sandbox: true`.
`contextIsolation` (true) and `nodeIntegration` (false) are Electron's
defaults and are not overridden; no bypass flag is set. Verified on the
packaged Linux build as a non-root user without `--no-sandbox`: the main
renderer has a seccomp-bpf filter and its own user and net namespaces, and
sees `window.custard` but no `window.electron`, `require` or `process`
(`test/platform/sandbox-evidence.mjs`).

**What the preload exposes** (`src/preload/index.ts`): only
`window.custard`, about 70 functions, each a thin `ipcRenderer.invoke` /
`send` / listener wrapper (API keys, settings, vault, plugins incl. activate,
memory, widgets, Design, security, workspace, conversations, attachments,
chat incl. approve). It uses `contextBridge`, `ipcRenderer` and
`process.platform`, all of which sandboxed preloads provide, and no Node
module. Everything the renderer does beyond rendering goes through IPC to
the main process, which holds the filesystem, network, keys and processes.

**Removed:** `window.electron` (`@electron-toolkit/preload`): raw
`ipcRenderer` for any channel plus a copy of `process.env`. The renderer
never used it, and a sandboxed preload cannot `require` the package. The
dependency is gone.

**Dev:** nothing hard-codes sandbox flags. `--no-sandbox` is only added by
Playwright (unless `chromiumSandbox: true`) or needed when running as root;
pass it on the command line when needed. `--inspect` and the inspect fuse
are unchanged.

**Residual trust assumptions**

- The preload is delivered from `app.asar` (integrity validation is off, see
  fuses above); whoever can modify the install can change it.
- The sandbox limits damage from a renderer exploit, not from script
  injection: a script in the renderer can still call everything
  `window.custard` offers, including approving cards and activating plugins.
- IPC sender checks remain a deny-list; the main window can still navigate
  to remote pages that would receive `window.custard` (no `will-navigate`
  lock yet). Both are tracked as separate, unconfirmed follow-up commits.
- GPU and network service processes are not sandboxed on Linux (above).
- Windows and macOS: not run.

Tests with the main window sandboxed: unit 762/762, `test:electron` 25/25,
20 e2e suites all pass (dev build, mock model, xvfb, root container so
Chromium itself ran `--no-sandbox`); packaged non-root sandbox-on:
`sandbox-evidence`, `design-security`, `widgets` pass.
