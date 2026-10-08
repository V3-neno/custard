# Design batch security review (Workstream D)

What D checked, how, and what is still open. Every claim names the code or
test it rests on. Mock and unit results only; nothing here ran on Windows,
macOS or against a live provider.

## Status

| # | Area | Result |
| --- | --- | --- |
| D1 | Plugin `open:` permission | **Gap.** Chat and Design can reach protected locations and local tools through an approved custom-scheme link. Fix needs Neno's decision. |
| D2 | Tool routes in Chat and Design | Enforced in code, except D1 and the residual network route below. |
| D3 | Link-swap race (`src/main/fsafe`) | Not started. |
| D4 | HTML preview sandbox | Waiting for Workstream A's branch. |
| D5 | Reliability and privacy flows | Waiting for A, B and C. |

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

### Smallest enforceable fix (proposed, needs Neno's decision)

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

Both files belong to the integration owner and Workstream C, so D doesn't
change them. The `it.fails` tests flip to passing when the fix lands.

## D2: tool routes in Chat and Design

| Route | Can it write protected locations, install extensions, or launch implementation work? | Evidence |
| --- | --- | --- |
| Tool kinds | Only kinds the mode allows are offered or run; unknown tools are refused in every mode. Chat and Design get no workspace (file) tools. | `modePolicy`, `refuseKind`, `runTool` in `src/main/chat.ts`; `policy.test.ts` |
| `vault_create_note` | No: `.md` only, no hidden folders (so no `.obsidian/plugins`), no `:` or short names, links must stay in the vault, and `extensionTarget` refuses skills, plugin and app roots by name and by real path. Race: see D3. | `resolveInVault` (`src/main/memory/paths.ts`), `modeRefusal` in `chat.ts`, `src/main/modes/extensions.ts` |
| Web tools | Read only. | `src/main/web/*` |
| Plugin tools | Sandboxed, no filesystem permission, network is https to listed public hosts only (resolved addresses checked). **Gap D1** for `open:`. | `src/main/plugins/net.ts`, `host.ts` |
| Plugin network (residual) | A plugin whose approved hosts include a remote coding or agent service could start work there. Only the user's host approval limits this. | `permissions.network` |
| Widgets | No network; a write needs a real input event plus the plugin's approval card. | `docs/plugins/WIDGETS.md`, `src/main/widgets/*` |
| IPC | Plugin sandboxes and widget views are refused on every channel. Installing, activating and plugin approval are app-window actions. | `src/main/ipc.ts` |
| Design tools | `design_html` and export: tested when A lands (D4). `design_media`: one individual approval card per submission (integration). | `src/main/design/tools.ts` |

## Windows and macOS

Nothing here ran on Windows or macOS. Scheme handlers are registered per
machine, so which apps a scheme reaches is unknown until it is checked there.
