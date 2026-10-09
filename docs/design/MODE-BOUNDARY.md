# Chat and Design: the implementation boundary

Chat and Design may recommend plugins and skills and draft development
prompts. They may not create or change extensions, send prompts to
implementation agents, or start implementation work. This is what the app
enforces, what it can't, and the open decision (stabilization item 1.1,
2026-10-09, from `design-integration` at 9701117).

**Status: not complete.** The options below wait on Neno; none is built.

## What the host enforces today (checked in code)

| Route from Chat/Design                                          | What stops implementation work                                                                                                                                               | Enforced by                                         | Bypass?                                                                                                                      |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `vault_create_note` into skills, plugin source or Custard files | `extensionTarget` on the path as written and on its real location, checked again just before the write                                                                       | `chat.ts modeRefusal`, `modes/extensions.ts`        | No (race noted in extensions.ts; Thread 2 owns the write)                                                                    |
| Code's file tools (`fs_*`), workspace                           | Not offered: Chat/Design have no `workspace` kind                                                                                                                            | `modes/policy.ts`, `available` set in chat.ts       | No                                                                                                                           |
| Design HTML export                                              | `exportRefusal` blocks skills, plugin folders, Custard source and userData                                                                                                   | `design/html/index.ts`                              | No                                                                                                                           |
| Plugin media tools                                              | Hidden from the model (`toolSet` skips them), widgets can't list them (manifest), reachable only through `invokeMedia` for the declared role                                 | `host.ts`, `manifest.ts checkMedia`                 | Host `invoke()` itself doesn't refuse a media tool name; closed in stabilization 1.3: `invoke()` refuses media tools by name |
| Plugin `openExternal`                                           | Only `spotify:` and approved https prefixes, only during a write tool                                                                                                        | `host.ts capability`, `manifest.ts validOpenPrefix` | See residual 3                                                                                                               |
| Links in answers                                                | Only http(s), opened in the user's browser on click                                                                                                                          | `src/main/index.ts` window-open handler             | See residual 3                                                                                                               |
| Skills                                                          | Text only. Mode policy depends only on mode + workspace; no skill field changes tools                                                                                        | `modes/policy.ts`                                   | No                                                                                                                           |
| **Any enabled plugin's ordinary tools**                         | **Nothing purpose-based.** Every enabled plugin's non-media tools are offered in Chat and Design. Write tools ask unless the user turned "ask every time" off for that tool. | `chat.ts` (`pluginHost().toolSet()`)                | **Yes: the D2 residual.**                                                                                                    |

## The known bypass

A plugin approved for a host that is a coding or agent service (a hosted coding agent, an issue tracker whose bot implements issues, a CI trigger) can start implementation from Chat or Design:

- A **write** tool can do it after one card, or with no card if "ask every time" is off for it. A card is consent to an action, not to crossing the mode boundary, so it doesn't satisfy the brief.
- A **read** tool can do it with no card at all. `read` is self-declared. The host doesn't limit what a read tool sends: any method (POST/PUT/PATCH/DELETE) to any approved host.
- Tool names and descriptions are plugin text, so the host can't infer purpose from them.

The boundary is therefore **not complete** while any such plugin can be enabled.

## Residual trust limit (true under every option)

Plugin code with network access to a host can cause whatever side effects that host's API allows. The host enforces _which plugin_, _which hosts_, _which tools ask_, and (with option A or C) _which HTTP methods_. It cannot see what a request means. Every option below makes the boundary depend on a classification by the user, and on the plugin's code doing what its review showed.

## Options

### A. Opt-in per plugin, plus read tools limited to GET/HEAD (recommended)

- New per-plugin setting, held by Custard (not the manifest): **"Use in Chat and Design"**. Shown at activation and in Settings → Plugins with the text "Only for plugins that don't create plugins or skills, send prompts to coding or agent services, or start implementation work."
- Off: the plugin's tools, widgets and media providers aren't offered or run in Chat, Design or Skills. Checked in the host on every call (not just when listing), so a stale tool list, a widget, or `invokeMedia` can't reach it.
- Tied to the plugin, re-asked when its network hosts or account change (a new host could be an agent service).
- In every mode, read tools may only send GET/HEAD (enforced in `fetchFor`). Writes still go through cards.
- **Compatibility:** Spotify (and any other active plugin) is off in Chat/Design until the user turns it on once. Spotify's read tools use GET only, so they keep working. A plugin whose read tool POSTs must relabel it as write.
- **Guarantees:** a plugin the user didn't opt in can't run anything from Chat or Design by any path. A read tool can't send a body-carrying request.
- **Still trusts:** the user's classification; that opted-in plugin code matches its review; that GETs to approved hosts don't start work.

### B. Opt-out flag "Starts work in coding or agent services"

- Same enforcement as A, inverted: plugins work everywhere unless the user marks them.
- **Compatibility:** nothing changes for existing plugins.
- **Guarantees:** only what the user remembered to mark is kept out. A new agent plugin is in Chat/Design by default. Weaker than A.

### C. Chat and Design get plugin read tools only (GET/HEAD enforced)

- No plugin write tools, widget actions or `openExternal` in Chat/Design. Writes only in Code's Plugins workspace. Design media stays (it is Design's own approved route).
- **Compatibility:** Spotify loses queue, playback controls and its player's buttons in Chat.
- **Guarantees:** no plugin call from Chat/Design can send a body-carrying request. Still trusts that GETs don't start work.

### D. Document only

- Keep current behaviour and record the bypass as a known gap. The boundary stays **not complete**.

## External links and status/result calls (item 1.5)

| Route                     | Operations allowed                                                                                                                                                                                    | Mode policy                                                           | Residual                                                                                                                 |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Plugin `ctx.openExternal` | Only during a write tool call; URL must start with an approved prefix: `spotify:` (the one vetted scheme) or an https origin prefix; at most 2000 plain URL characters. No new schemes in this batch. | Runs only inside a plugin call, so it follows the plugin rules above. | An https page opened in the user's browser can do whatever that site does once the user interacts with it.               |
| Links in answers          | http(s) only, opened in the user's browser on a click (`src/main/index.ts`).                                                                                                                          | A click is the user's own action.                                     | A link can carry a prefilled prompt for another service; the user still has to submit it there.                          |
| HTML previews             | Popups and navigation denied, no network (`design/html/preview.ts`).                                                                                                                                  | None needed.                                                          | None found.                                                                                                              |
| Media status and result   | Declared read tools, called with no approval; one passed with them is refused by the host. They can't reach the submit tool or reuse a submission's approval.                                         | Design only.                                                          | The plugin's code inside a read tool can still send any request its approved hosts allow (same as all read tools above). |
| Widgets                   | Only the widget's declared tools; never a media tool (manifest), writes need a gesture and the plugin's card.                                                                                         | Widgets are offered where plugin tools are.                           | Same as plugin tools; covered by option A or C.                                                                          |

Regression tests: `src/main/design/plugin-media/plugin-media.test.ts` (media
tools refused through `invoke` even pre-approved, status/result refuse an
approval, approval bound to build, input and one use), `src/main/plugins/open.security.test.ts`
(link schemes and read-tool refusal), `src/main/modes/policy.test.ts`.
