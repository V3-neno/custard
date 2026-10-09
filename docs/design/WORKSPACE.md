# Design workspace (Phase 2, Workstream A)

What Design shows beside the conversation, how HTML outputs are made and
run, export, and how skills are recorded. The threat model is
[SANDBOX.md](SANDBOX.md); skill rules are [SKILLS.md](SKILLS.md).

## Layout

- The workspace appears only once the chat has an output. Before that,
  Design looks like any other mode.
- Wide windows: conversation on the left, outputs on the right, with a
  divider that can be dragged or moved with the arrow keys. Its width is
  kept across chats.
- Narrow windows (under 900 px): a Conversation / Outputs switch. A new or
  changed output switches to Outputs.
- One tab per output (only when there are two or more). Each output has
  its versions as chips: `v2` is a revision, `◇ v3` a variation (another
  option beside its parent). Failed or cancelled versions are shown dashed
  and can't be selected; when the newest one failed, a line says so and
  that the last version that worked is still shown.
- Selecting a version is saved (`design:select`) and survives a restart.
- HTML: Preview or Code; Desktop (fills the pane), Tablet (820 px) or
  Phone (390 px). A width wider than the pane is scaled down to fit, and
  the status line says so.
- "Revise", "Variation" and the skill buttons only put text in the message
  box. Nothing is sent or generated without the user sending it.
- Images and video use Workstream B's and C's viewers.

## design_html

`src/main/design/html/handler.ts`, schema in `html/schema.ts`.

- Input: the complete document (`html`), optional local text files
  (`files`: CSS, JS, SVG, JSON, more pages), images attached in the same
  chat (`references`, by attachment id or exact name, copied into the
  version), and every skill considered (`skills`).
- Refused before anything is stored: a fragment, a document that doesn't
  end with `</html>`, over 2 MB, bad paths (the store's own rules), other
  file types, more than 20 files or 10 images, or a missing attachment.
- A revision or variation keeps the files of the version it starts from
  unless it replaces them; `index.html` is always the new document.
- A storage failure on an existing output adds a failed version and the
  last good one stays selected.
- The result lists only checks that ran:
  - **Local files**: a static scan of the document and its CSS for
    relative references, and whether each is a file of the version.
  - **External references**: counted; they can't load (no network).
  - **Preview**: the stored version is loaded once in a hidden preview
    sandbox; it reports loaded or not, the time, runtime errors seen while
    loading, requests blocked and files not found. A page that doesn't
    finish within 10 s is stopped and reported.
    It never claims accessibility, responsiveness or visual checks.

## Preview

`src/main/design/html/preview.ts`. One `WebContentsView` per shown preview,
laid over the box the workspace reports, hidden when anything covers that
box (as with widgets).

- No preload; Chromium sandbox, context isolation, no Node, no webview, no
  devtools, dialogs disabled, muted, visual zoom locked.
- A new in-memory session per preview (`custard-preview-<random>`). On it,
  every `https` request goes to Custard's handler (`protocol.handle`), which
  answers only for `https://<random>.preview.invalid/` and serves only files
  recorded on that version, hash-checked, with a CSP header,
  `nosniff` and `no-store`. Every other request (http, ws, wss, file, other
  schemes or hosts) is cancelled in `onBeforeRequest`, and the session's
  proxy is a dead address.
  - Why not a `custard-preview://` scheme as SANDBOX.md first said: a
    standard custom scheme needs `protocol.registerSchemesAsPrivileged`,
    which can only be called once and is already called for
    `custard-media`. Intercepting `https` on a throwaway session gives the
    page a normal secure origin and needs no global registration.
  - `.invalid` is reserved and never resolves, so nothing outside the
    handler can answer for that host.
- CSP: the page's own origin plus `data:` and `blob:` for everything;
  inline scripts and styles allowed; `connect-src 'self'` so a page can
  fetch its own JSON (still only the version's files); `form-action 'none'`;
  `object-src 'none'`.
- Navigation only within the version's own files; popups, downloads,
  permissions, device access, display capture and `beforeunload` prompts
  are refused. WebRTC is limited to proxied UDP (none).
- Runtime errors come from `console-message` (level error), at most 20, 300
  characters each. Blocked requests are counted.
- A crash, an unresponsive page or a load over 10 s stops the preview and
  says so; the app window is a separate process and stays responsive.
- Closing a preview crashes its renderer first (a looping page can block a
  normal close), then clears its session's storage and cache. Sessions
  themselves stay allocated until the app quits (Electron has no way to
  free one), which costs a little memory per preview shown.
- The preview's contents are refused on the app's IPC channels
  (`refuseContents` in `src/main/ipc.ts`), though without a preload it has
  no IPC at all.

## Export

`src/main/design/html/export.ts`, `design:export`.

- Any kind (HTML, image, video). One file is saved as a file; a page with
  local files is saved as a **new** folder (never merged into one that
  exists).
- Refused: the skills folder, plugin folders and Custard's own source
  (`extensionTarget`, `protectedRoots`), and Custard's app data, checked
  by the path as written and by its real path through links.
- Replacing a file asks first. The new file is written beside it and
  renamed over it, so a link at the target is replaced, not followed.
- New files are created with `O_CREAT | O_EXCL | O_NOFOLLOW`.
- Files are read and hash-checked before anything is written; a changed
  stored file means nothing is exported.
- Exports are copies: deleting the chat deletes Custard's copy only.

### Known gap: link swaps

The writes go through a `Writer` with the same shape as Workstream D's
`src/main/fsafe` (`writeNew`, `writeReplace`, with a guard on the real
target). Until that helper is on `design-batch`, a local fallback is used:
it resolves the parent folder's real path, checks it against the guard,
then creates the file relative to that resolved path. A parent folder
swapped for a link between the check and the create could still be
written through. Integration replaces `localWriter` with `fsafe` (one
import in `html/export.ts`); D3 in `docs/design/SECURITY-REVIEW.md` covers
what remains after that. Native Windows behaviour is not verified.

## Skills

- The model lists each skill it considered with a strength (explicit,
  clear, similar), conflicts and, for similar ones, whether it matters.
  `planSkills` decides: explicit and clear ones are applied, similar ones
  are explained, conflicts and material similar ones stop generation with
  a question, and a named skill that isn't available is said, not used.
- Only skills Design lists (no `modes`, or `modes` including design) count
  as available.
- Each applied skill is recorded on the version as `SkillUse`: path, name,
  how chosen, SHA-256 of the SKILL.md as read, and up to 2,000 characters
  of the guidance relied on.
- "Skills used" shows them compactly; opening it shows how each was chosen,
  the fingerprint, the guidance kept, and whether the skill changed or is
  gone (`design:skills`, checked again when the window regains focus).
- A changed skill is only offered ("Use the updated skill"); "Without this
  skill" is the explicit override. Both put a request in the message box.

## Tests

- Unit: `src/main/design/html/html.test.ts` (documents, files, references,
  versions and failures, skills, serving and request rules, layout, export).
- End to end: `test/e2e/design-workspace.mjs` with
  `test/e2e/mocks/a-workspace.mjs`, mock model only, Linux under xvfb.

Not verified: Windows and macOS, a live model following the tool's
guidance, keyboard and screen-reader use of the workspace, and HiDPI
placement of the preview view.
