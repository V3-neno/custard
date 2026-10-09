# Main window: sandbox investigation (stabilization, Amendment 5)

Written 2026-10-09 by Thread 4, from `design-integration` at 9701117 plus
Thread 4's commits. **Nothing in production was changed.** The production
decision is Neno's.

## Four different things

|                       | What it is                                                                   | State                                                                                                                                             |
| --------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Main-window sandbox   | `webPreferences.sandbox` on the app's own window (`src/main/index.ts`)       | **Off** (`sandbox: false`)                                                                                                                        |
| Preview sandbox       | Design's HTML preview views (`design/html/preview.ts`)                       | On; verified at kernel level in the packaged build (SANDBOX.md)                                                                                   |
| Plugin sandbox        | Plugin and widget windows/views (`plugins/runtime.ts`, `sandboxPreferences`) | On (`sandbox: true`, no Node, locked session); behaviour verified packaged (widgets 65/65), kernel level not separately recorded                  |
| Global `--no-sandbox` | A Chromium switch that turns the sandbox off for every process               | Not used by Custard. Added by Playwright unless `chromiumSandbox: true`, and needed when running as root. Every e2e run before this batch had it. |

One does not prove another: the preview being sandboxed says nothing about
the main window, and the main window's setting says nothing about previews.

## Current configuration

- **Why it's off:** `sandbox: false` is the electron-vite template's default.
  It has been there since the window was created (first seen in 6ad8b04,
  2026-10-07). No commit or doc gives a reason.
- `contextIsolation`: not set, so Electron's default, **true**.
  `nodeIntegration`: not set, so **false**. The renderer itself has no Node.
- **Preload** (`src/preload/index.ts`) exposes two globals:
  - `window.custard`: about 70 functions over IPC. They cover API keys
    (set, clear), settings, the vault, plugins (create, test, review,
    **activate with a list of approved permissions**, rollback, config,
    secrets reset, uninstall), memory, widgets, Design (export, jobs, preview),
    conversations (delete), attachments, and chat (send, **approve**).
    **The renderer is where user approval comes from**: a script running in
    it can approve cards and activate plugins as if it were the user.
  - `window.electron` (from `@electron-toolkit/preload`): the raw
    `ipcRenderer` (send, invoke and listen on **any** channel), `webFrame`,
    `webUtils`, and `process.env`, a **full copy of the environment**. The
    renderer doesn't use it anywhere (`grep window.electron src/renderer` is
    empty). Measured: with a test variable `MY_SECRET_TOKEN` set, a renderer
    script could list it among 185 variables. Only names were printed, not
    values.
- **IPC sender checks** (`src/main/ipc.ts`): a deny-list. It refuses plugin,
  widget and preview contents. It doesn't check that the sender is the app
  window, or check the frame's URL (`senderFrame`). Anything else that ever
  gets the preload counts as the app.
- **Navigation and windows:** `setWindowOpenHandler` denies new windows and
  sends only `http(s)` links to the OS browser. There is **no `will-navigate`
  handler** on the main window. Measured: a renderer script setting
  `location.href = 'http://127.0.0.1:8777/'` navigated the main window
  there, and **the remote page had `window.custard` and `window.electron`**.
  Drag and drop doesn't navigate (`navigateOnDragDrop` defaults to false).
  Markdown links open externally (`target=_blank`).
- **Content that reaches the renderer:**
  - model text, rendered by react-markdown without raw HTML, with its
    default URL sanitising;
  - web search titles, URLs and cited text;
  - plugin tool results (text);
  - vault note text;
  - attachment and Design media, as images or video from `custard-media:`
    (the CSP allows `custard-media:` and `data:` images);
  - widget and preview content runs in separate views, not in this renderer.

  No HTML from the model, the web or a plugin is inserted as HTML: there is no
  `dangerouslySetInnerHTML`. No XSS path was found. The hardening below
  matters if one ever appears.

## Dependence on unsandboxed preload behaviour

The only dependence: the built preload does
`require("@electron-toolkit/preload")`. A sandboxed preload can only
`require` `electron` and a few built-ins, so with `sandbox: true` as the only
change, the preload fails and **the app shows nothing**. Measured: no
`window.custard`, no composer. Everything else the preload uses
(`contextBridge`, `ipcRenderer`, `process.platform`) works sandboxed.

## Changes needed to enable it

1. Remove `window.electron` and the `@electron-toolkit/preload` import. The
   renderer doesn't use it, and removing it also closes the
   environment-variable and raw-IPC exposure. Bundling it instead would keep
   both exposures.
2. Set `sandbox: true` on the main window.
3. Rerun the whole e2e suite (results below).

Strongly recommended either way, sandbox or not:

- a `will-navigate` / `will-redirect` handler that keeps the main window on
  its own `file://…/renderer/index.html` (or the dev server URL in
  development);
- IPC that only accepts the main window's own top frame at the expected URL
  (an allow-list on `senderFrame`) instead of the deny-list.

## The non-production experiment

Run in a throwaway worktree, never committed. Variant 1 was `sandbox: true`
only. Variant 2 was `sandbox: true` plus step 1 above. Development build,
mock model.

| Variant                      | Result                                                                                                                                                                                        |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1: `sandbox: true` only      | Preload fails; blank app                                                                                                                                                                      |
| 2: plus no `window.electron` | App works; `window.custard` present; `window.electron` gone. Still navigable to a remote page that gets `window.custard`, because the sandbox doesn't stop navigation. e2e suites: see below. |

Variant 2, development build (Chromium globally `--no-sandbox` because the
container runs as root, so this checks the sandboxed **preload environment**,
not OS confinement), all against the mock model: attachments 34,
design-attachments 17, design-images 33, design-media 21, design-security
43, design-workspace 67, hardening 29, interrupt 29, memory 51, modes 27,
plugin-demo 26, vault 11, web 18, widgets 65, longchat 35: **15 suites, all
pass, none failed**. (One design-workspace run died when xvfb lost its X
server; the rerun passed 67/67.)

Variant 2, packaged Linux build, non-root, sandbox on
(`test/platform/sandbox-evidence.mjs`): the main window renderer runs with a
seccomp-bpf filter and its own user and net namespaces, like the preview;
the app starts, takes a key, connects the vault and opens a Design preview.
Windows and macOS: not run.

## What each option guarantees

- **Sandbox on (changes 1–2):** a compromised main renderer is confined by
  Chromium's OS sandbox. It can't read files or start processes directly.
  It **can still do everything `window.custard` allows**, including approving
  cards and activating plugins. So the sandbox limits damage from renderer
  exploits, not from script injection.
- **Navigation lock and IPC allow-list:** stop a navigated-away or foreign
  frame from inheriting the app's API.
- **Removing `window.electron`:** closes raw IPC and environment exposure on
  its own, and is a prerequisite for the sandbox.

Recommendation: do all three, as one reviewed step. These are production
security changes, so this thread hasn't made them.
