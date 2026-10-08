# Design mode: architecture and implementation map

Phase 1 of the Design mode brief: what exists, what Design reuses, what has
to change, and where each later phase plugs in. The contracts are in
[CONTRACTS.md](CONTRACTS.md), skill handling in [SKILLS.md](SKILLS.md), and
the HTML preview's threat model in [SANDBOX.md](SANDBOX.md).

## What exists today (inspected on branch `widgets`, 918e9cb)

| Area           | Where                                                               | What it does now                                                                                                                                                                                                        |
| -------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Modes          | `src/shared/chat.ts` (`modes`), `src/main/chat.ts` (`MODE_PROMPTS`) | Chat, Code, Design, Skills. Each keeps its own history. Design is only a system prompt: it answers with HTML in fenced code blocks shown as Markdown.                                                                   |
| Providers      | `chat.ts` `send()`, `openai.ts`                                     | Claude (Messages API, streaming, adaptive thinking, compaction, server-side fallback) and OpenAI. Both return text and tool calls only. Keys in `userData/*-key.bin` via safeStorage.                                   |
| Tools          | `chat.ts`                                                           | Assembled per turn: vault tools, Code's workspace tools, web tools, enabled plugins' tools, widget tools. `runTool` routes each call; anything not offered this turn is refused.                                        |
| Approvals      | `chat.ts` `approve()`                                               | One card per action, "allow for this chat" or one at a time, tied to the plugin build. Notes and file changes are always one at a time. A repeat of an unknown-outcome write always asks.                               |
| Action records | `turn.ts` `TurnLog`                                                 | pending / running / completed / failed / not-run / unknown, saved as they change; repaired on reopen after a crash.                                                                                                     |
| Plugins        | `src/main/plugins/*`                                                | Sandboxed runtime, manifest v1, permissions (network, open, storage, account), per-build approval, config with secrets, OAuth. Created from Settings or Code's Plugins workspace.                                       |
| Widgets        | `src/main/widgets/*`                                                | Sandboxed WebContentsView per widget, locked session, `data:` page, narrow preload. The model for Design's preview sandbox.                                                                                             |
| Skills         | `vault.ts` `listSkills`                                             | `Custard/Skills/<name>/SKILL.md` in the vault; frontmatter `name`, `description`, `modes`. Descriptions go in the prompt; the model reads the file with `vault_read`. Skills mode writes them with `vault_create_note`. |
| Memory         | `src/main/memory/*`                                                 | Automatic capture notes in `Custard/Captures`, plugin notes in `Custard/Plugins`.                                                                                                                                       |
| Storage        | `store.ts`, `settingsFile.ts`, `attachments/store.ts`               | Conversations as JSON in userData; settings written atomically; attachments copied per chat into userData, read-only, content-hashed.                                                                                   |
| UI             | `src/renderer/src/components/*`                                     | Single chat column, mode bubbles, settings dialog with tabs, widget slot above the mode bubbles. No side panel or output workspace.                                                                                     |

## Reuse

- **Approvals, action records and unknown-outcome handling**: image and video
  submissions are tool actions like plugin writes; the same card and the same
  "never repeat an unknown outcome" rule apply.
- **Widget sandbox**: the HTML preview is built the same way (own process,
  locked session, no Node, no navigation), minus the bridge. See SANDBOX.md.
- **Attachment store**: the pattern (per-chat folder in userData, write once,
  read-only, SHA-256) is what artifact storage needs; references in Design
  reuse attachments.
- **Skills**: the same folder, listing and `vault_read`. Design adds
  precedence and provenance on top (SKILLS.md), not a second system.
- **Plugins**: video and extra image providers come through plugins; the
  manifest gains a validated media declaration (decision below).
- **Settings**: `settingsFile.ts` holds Design settings next to chat settings.

## Changed in Phase 1

1. **Mode permissions in the app** (`src/main/modes/policy.ts`,
   `src/main/modes/extensions.ts`, wired in `chat.ts`). Each mode allows kinds
   of tool, not a list a prompt describes. Chat and Design: vault read, new
   notes, web, enabled plugins, widgets. Never Code's file tools, and never a
   tool the policy doesn't know (a future "send to Code" or "install" tool is
   refused until a mode explicitly allows it). New notes are refused, before
   any approval card, when they would land in the skills folder by any route
   (name, case, trailing dots, a folder link inside the vault, a skills
   folder that is itself a link, or a folder linked from inside it), or in
   plugin code or Custard's own files in any mode. Skills mode and Code keep
   what they had.
2. **Prompts**: Chat and Design are told what they can offer instead
   (recommend, draft text to copy). The app enforces it either way.
3. **Contracts** in `src/shared/design.ts` with their rules in
   `src/main/design/` (capabilities, media, versions, jobs, skills).
4. **A development-only video provider** in `test/fixtures/media/`, used
   only by tests. A test fails if app source imports it or a bundled plugin
   declares it.

## Not changed (and why)

- Chat's notes in `Custard/Plugins` (plugin knowledge) are still allowed:
  they are notes about plugins, not plugin code. Listed as a decision.
- The Settings dialog can still create plugins and add starter skills: those
  are the user's own clicks, not a mode acting.
- Code mode may still create skill notes, as before. The brief restricts
  Chat and Design only.

## Implementation map for later phases

| Phase                 | Where it goes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2: workspace and HTML | `src/main/design/store.ts` (artifacts per chat in `userData/design/<chat>/<artifact>/<version>/`, like attachments), `src/main/design/preview.ts` (sandbox per SANDBOX.md), renderer `components/design/*` (resizable output pane, tabs, Preview / Code, viewport sizes), export via a save dialog with overwrite confirmation and `extensionTarget` refusal. Design-mode tools `design_create`, `design_revise` (complete HTML only) added to the policy for Design only. References: lift "Chat mode only" on attachments for Design. |
| 3: built-in images    | A built-in `MediaProvider` for an image API chosen with Neno; Design settings tab; capability report shown in the UI; approval card naming provider, operation, references and any provider-given price.                                                                                                                                                                                                                                                                                                                                |
| 4: media plugins      | Manifest `media` declaration validated by `validateCapabilities`; a plugin-backed `MediaProvider` adapter over its tools; plugin options through the widget-style constrained UI; video viewer.                                                                                                                                                                                                                                                                                                                                         |
| 5: hardening          | End-to-end runs of everything above, including escape and bypass attempts.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

## Conflicts with the brief found

- Attachments are refused outside Chat (`chat.ts`: "Files can be attached in
  Chat mode only"). Design references need that lifted in Phase 2.
- Design answers today are HTML in Markdown code blocks, never run. The
  brief's preview is new UI and a new sandbox, not a change to an existing
  one.
- Neither chat connection can return images, so "use the selected model for
  images when its API supports it" never applies today; images need an image
  provider (Phase 3).
