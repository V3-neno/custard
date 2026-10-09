# Design batch security review (Workstream D)

What D checked, how, and what is still open. Every claim names the code or
test it rests on. Mock and unit results only; nothing here ran on Windows,
macOS or against a live provider.

## Status

| # | Area | Result |
| --- | --- | --- |
| D1 | Plugin `open:` permission | **Fixed** on design-batch (dffbfd7) after Neno chose "Allowlist" (2026-10-09): vetted schemes only (today `spotify:`), and only write tools can open links. Tests in `open.security.test.ts` pass. |
| D2 | Tool routes in Chat and Design | Enforced in code, except D1 and the residual network route below. |
| D3 | Link-swap race (`src/main/fsafe`) | Helper built and tested on Linux. Narrowed, not closed; residual risk below. Callers not switched yet. |
| D4 | HTML preview sandbox | Contained. `window.print()` opened the OS print dialog at ac9a4a2; A fixed it with a CSP sandbox directive (90b1dde). `design-security.mjs` 40/40 on design-integration plus A's fix. Results in `SANDBOX.md`. |
| D5 | Reliability and privacy flows | Tested across A, B and C (below). D5a fixed by integration (a99419c). |

## D1: plugin "open links on this computer" (`open:`)

### How it works today

- A manifest lists `permissions.openExternal` prefixes. `validOpenPrefix`
  (`src/main/plugins/manifest.ts`) accepts an `https://host/` prefix or any
  bare custom scheme (`name:`) **not** on `BLOCKED_SCHEMES`. That set is a
  denylist: `file`, `http`, `javascript`, `ms-*`, `search-ms`, `ssh`,
  `vscode`, `cursor` and similar are refused.
- At run time `capability('openExternal')` (`src/main/plugins/host.ts`)
  checks the link is under 2000 characters, uses only plain URL characters
  (`PLAIN_URL`) and starts with a granted prefix, then calls
  `shell.openExternal`.
- It works during **any** tool call of the plugin. Read tools never show an
  approval card, and a write tool skips its card when the user turned off
  "ask every time".

### What that allows (`src/main/plugins/open.security.test.ts`)

1. **Writing skills and any note, through Obsidian.** `obsidian:` is not
   blocked. Per Obsidian's URI docs
   (<https://obsidian.md/help/Extending+Obsidian/Obsidian+URI>, read
   2026-10-08), `obsidian://new` takes a vault `file` (or an absolute
   `path`), `content`, `overwrite` and `silent`. A plugin with an approved
   `open:obsidian:` and a tool that forwards a link lets Chat or Design write
   `Custard/Skills/...`, which `extensionTarget` protects only on Custard's
   own write path. The test shows the host passes such a link to the OS.
   Obsidian's handling of it was read from the docs, not run.
2. **Starting local tools.** Unblocked schemes include handlers that open
   projects in IDEs, clone repositories, run automations or open `http:`
   pages outside Custard's checks: `shortcuts:`, `x-github-client:`,
   `github-windows:`, `sourcetree:`, `jetbrains:`, `windsurf:`, `vscodium:`,
   `zed:`, `claude:`, `microsoft-edge:`, `rdp:`. Not exhaustive, and it can't
   be: any app can register a scheme.
3. **No per-call approval.** A read tool can open a link the user never sees.

`file:` is not reachable directly: it is blocked at validation and at run
time (prefix check), covered by existing host tests and this file.

### Why it matters for the boundary

Chat and Design may use enabled plugins' tools (`modePolicy`,
`src/main/modes/policy.ts`). So whatever an approved `open:` link can do,
those modes can do indirectly. The mode policy can't see inside a plugin
call, and a prompt rule isn't enforcement.

### Fix (Neno chose "Allowlist", 2026-10-09; applied in dffbfd7)

- **Allowlist instead of denylist.** A manifest may declare `https://host/`
  prefixes plus custom schemes from a short list Custard vets (today only
  `spotify:`, the one scheme any plugin uses). Any other scheme is a manifest
  error until it's deliberately added. One set change in `manifest.ts`.
- **Only write tools may open links.** `capability('openExternal')` refuses
  unless the current call is a write tool. Spotify's `open` is already a write
  tool, so it is unaffected. One check in `host.ts`.

Alternatives: keep the denylist and add the schemes above (unknown handlers
stay open), or confirm every custom-scheme link with the user at open time
(adds a second prompt to Spotify's open).

The integration owner applied it from `requests/D1-open-allowlist.patch`.
`open.security.test.ts` now asserts the fixed boundary.

## D2: tool routes in Chat and Design

| Route | Can it write protected locations, install extensions, or launch implementation work? | Evidence |
| --- | --- | --- |
| Tool kinds | Only kinds the mode allows are offered or run; unknown tools are refused in every mode. Chat and Design get no workspace (file) tools. | `modePolicy`, `refuseKind`, `runTool` in `src/main/chat.ts`; `policy.test.ts` |
| `vault_create_note` | No: `.md` only, no hidden folders (so no `.obsidian/plugins`), no `:` or short names, links must stay in the vault, and `extensionTarget` refuses skills, plugin and app roots by name and by real path. Race: see D3. | `resolveInVault` (`src/main/memory/paths.ts`), `modeRefusal` in `chat.ts`, `src/main/modes/extensions.ts` |
| Web tools | Read only. | `src/main/web/*` |
| Plugin tools | Sandboxed, no filesystem permission, network is https to listed public hosts only (resolved addresses checked). `open:` limited to vetted schemes from actions (D1, fixed). | `src/main/plugins/net.ts`, `host.ts` |
| Plugin network (residual) | A plugin whose approved hosts include a remote coding or agent service could start work there. Only the user's host approval limits this. | `permissions.network` |
| Widgets | No network; a write needs a real input event plus the plugin's approval card. | `docs/plugins/WIDGETS.md`, `src/main/widgets/*` |
| IPC | Plugin sandboxes and widget views are refused on every channel. Installing, activating and plugin approval are app-window actions. | `src/main/ipc.ts` |
| Design tools | `design_html` and export: tested when A lands (D4). `design_media`: one individual approval card per submission (integration). | `src/main/design/tools.ts` |

## D3: link-swap race (`src/main/fsafe`)

Every write path today checks the path, then writes with `flag: 'wx'`
(`vault.ts`, `memory/write.ts`, `design/store.ts`). `wx` already refuses a
link at the final name. The gap is a **parent folder** swapped for a link
between the check and the write.

`writeNew(path, data, { guard })` and `writeReplace(...)`:

1. resolve the parent's real path and pass the real target to `guard`;
2. create with `O_CREAT | O_EXCL | O_NOFOLLOW` (no `O_NOFOLLOW` on Windows);
3. before writing any content, check the new file is at the expected real
   path (same device and inode, parent's real path unchanged); if not, remove
   the empty file where it can still be found and refuse;
4. write through the open handle.

`writeReplace` writes a fresh file beside the target the same way and renames
it over, so a link at the target is replaced, not followed. Asking before
overwriting stays with the caller.

Tests (`src/main/fsafe/fsafe.security.test.ts`, Linux, real symlinks)
simulate the swap at the moment of opening.

**Residual risk.** Node has no `openat()`, so the window can't be closed. If
a parent folder is swapped for a link and swapped back between steps 2 and 3,
the write is refused but an **empty** file can stay where the link pointed.
No content is written there. On Windows, junctions and NTFS file ids should
behave the same way but haven't been run there. Native Windows verification
is outstanding.

**Who switches over.** A's export and the vault and memory note writes
belong to A and the integration owner. Until they call `fsafe`, the gap
documented in `docs/plugins/SECURITY.md` ("File-check races") still applies
to them.

## D5: reliability and privacy across A, B and C

Linux, xvfb, mock providers only, 2026-10-09, on D's branch with A, B, C and
design-batch merged (D1 included).

- **Regression run together:** `design-workspace` 67/67, `design-images`
  33/33, `design-media` 21/21, `modes` 27/27, `attachments-leak` 13/13.
- **`design-attachments.mjs` (17/17):** an edit sends only the attachment it
  names, and the card lists it; no attachment name or text reaches the memory
  summarizer or a vault note through Design's tools or labels; a temporary
  Design chat with attachments isn't summarized; deleting the chat deletes its
  attachments, outputs and job records; Code and Skills have no attach
  button.
- **Restart during a paid submission (`design-security.mjs`):** the edit
  reached the provider (a server that never answers), the app was killed, and
  after the restart the job was `unknown`, nothing was resent, and a repeat
  asked first with "may already have happened". Declining sent nothing.
- **D5a (low, fixed in a99419c):** that repeat card is the generic one
  (tool name and raw JSON). Because the repeat counts as pre-approved,
  Design's own card, which names the provider, the files sent and the price,
  is skipped, so a paid repeat is approved without that information.
  Fixed: a repeat now shows only Design's card, carrying the warning, and it
  can't be allowed for the whole chat. `design-security.mjs` checks this
  (43/43).
- Covered by unit tests elsewhere and not repeated here: expired result links
  and permanent result errors, plugin removal, skill matching cases (A, C and
  integration tests).

## Windows and macOS

Nothing here ran on Windows or macOS. Scheme handlers are registered per
machine, so which apps a scheme reaches is unknown until it is checked there.
