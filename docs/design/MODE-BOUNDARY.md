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

## Options (Amendment 4 format; none is built)

None of these proves that plugin code can't start implementation work. Plugin
code with network access to a host can do anything that host's API allows,
whatever its tools are called or labelled. What each option changes is which
plugins and which kinds of request can run from Chat and Design at all, and
on whose say-so. Domain or host labels ("coding", "agent") are not used: a
host can offer many services, and labels prove nothing.

### A. Per-plugin "Use in Chat and Design" grant, plus read tools limited to GET/HEAD (recommended)

1. **Host enforces:** a plugin without the grant has no tool, widget or
   media provider offered or run in Chat, Design or Skills. Checked in the
   host on every call (`invoke`, widget calls, `invokeMedia`), not only when
   the list is built, so a stale list or another path can't reach it. In
   every mode, `fetchFor` refuses any method but GET and HEAD from a tool
   declared `read`.
2. **Still trusts plugin code:** that a granted plugin's code does what its
   review showed. GET requests to approved hosts can still have side effects
   at those hosts (a webhook URL, a badly designed API). Write tools still
   rely on the user's card.
3. **Compatibility:** every active plugin (today Spotify) stops working in
   Chat, Design and Skills until the user turns the grant on once. Spotify's
   read tools only use GET, so they keep working. A plugin whose read tool
   POSTs must relabel it `write`.
4. **Requirement:** expresses the user's trust; it doesn't satisfy the
   requirement by proof. It closes the default path (nothing new reaches
   Chat/Design without the user's say) and removes the no-card read-tool
   route for body-carrying requests. It doesn't weaken anything that exists.
5. **New tools and updates:** the grant belongs to the plugin, but is asked
   again when an update adds a network host, account scope or write tool
   (anything that changes what it can reach or do). Updates that only change
   code under the same permissions keep it (that's the existing review step's
   job). Unknown tools are refused in every mode already.

### B. Opt-out flag "Starts work in coding or agent services"

1. **Host enforces:** the same exclusion as A, but only for plugins the user
   marked.
2. **Still trusts:** that the user marks every such plugin, plus everything
   A trusts.
3. **Compatibility:** none for existing plugins.
4. **Requirement:** weakens it: a new agent plugin is in Chat/Design by
   default until someone notices.
5. **New tools and updates:** an update that adds an agent host isn't
   noticed unless the user re-marks the plugin.

### C. Chat and Design run plugin read tools only (GET/HEAD enforced)

1. **Host enforces:** no plugin write tool, widget action, account write or
   `openExternal` from Chat or Design; read tools limited to GET/HEAD. Design
   media keeps its own approved route.
2. **Still trusts:** that GETs to approved hosts don't start work.
3. **Compatibility:** Spotify loses queueing and playback control (and its
   player's buttons) in Chat.
4. **Requirement:** the closest the host can get without per-plugin trust,
   but still not proof (GET side effects).
5. **New tools and updates:** a new write tool is never available in
   Chat/Design; a new read tool is, limited to GET/HEAD.

### D. Document only

1. **Host enforces:** nothing new.
2. **Still trusts:** every enabled plugin, including its read tools' POSTs.
3. **Compatibility:** none.
4. **Requirement:** not met; the bypass stays and the boundary is reported
   as not complete. Model instructions are not counted as a control.
5. **New tools and updates:** offered in Chat/Design as soon as enabled.

A and C can be combined (grant required, and Chat/Design limited to reads),
at the cost of both compatibility impacts.

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
