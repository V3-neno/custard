# Custard roadmap

Custard grows in phases. Each phase ends with something usable on its own.

## Done

- **Phase 0: App shell.** Electron + React + TypeScript window with a sidebar for Chat, Code and Design.
- **Phase 1: Chat.** Streaming Claude API chat with saved conversations, model and effort pickers, thinking summaries, an encrypted API key and refusal fallbacks.

## Phase 2: Obsidian brain (in progress)

Custard uses an Obsidian vault as its long-term memory. A vault is just a folder of Markdown files, so Custard reads and writes it directly, and Obsidian doesn't need to be running.

1. Pick the vault folder in Settings.
2. Give Claude tools in Chat to search, list and read notes, create new notes and append to existing ones. It can't overwrite or delete anything.
3. Keep a memory note (`Custard/Memory.md`) that is loaded into every chat, which Claude adds to when it learns something worth remembering.
4. Show what Claude did in the vault inline in the chat.
5. A starter vault (`vault-template/`) that Custard can create from Settings, with folders, templates, a memory note and starter skills.
6. First skills support in Chat: skills in `Custard/Skills/` are listed to Claude, and it reads the full skill when a request matches.

Later in this phase:

- Save a chat as a note with one click.
- Understand `[[wikilinks]]`, tags and backlinks when reading notes.
- Smarter search (ranking, then possibly embeddings) once vaults get large.

## Phase 3: Code mode

Started: Code mode has two workspaces with app-enforced folder boundaries and no shell. **Plugins** edits one plugin in `plugin/<id>` and can validate and test it; **General Code** edits a folder you pick, and Custard's own source needs a separate approval. See [plugins/README.md](plugins/README.md).

Still to do:

- Claude Code itself (Claude Agent SDK) as an option for General Code.
- Show tool calls, file diffs and permission prompts in the UI.
- Give it the same vault access, so coding sessions can use and update the brain.

## Phase 4: Design mode

- Split view: chat on one side, a live sandboxed preview of the HTML/React Claude generates on the other.
- Save designs to the vault or a project folder.

## Phase 5: Skills

Agent Skills are folders with a `SKILL.md` file that teach Claude a procedure.

Basic skills in Chat arrived with the starter vault in Phase 2. This phase builds on that:

- Code: pass the same skills to the Claude Agent SDK.
- Manage skills from a Skills page in Custard.
- Let Claude draft new skills from a conversation ("turn what we just did into a skill").

## Integrations

- **Plugin platform** (done, MVP): sandboxed plugins with a manifest, review and activation, permissions, write approvals, rollback and OAuth. See [plugins/README.md](plugins/README.md).
- **Spotify** (done, now a plugin): search, now playing, devices, queue, open and transfer. See [SPOTIFY.md](SPOTIFY.md).
- Later for plugins: UI panels, vault access through a reviewed capability, signed plugins from other people.

## Token efficiency

Each phase is measured against a baseline taken first with `scripts/usage-baseline.mjs` (cache writes against cache reads, and cost per message, from saved chats).

1. **Stable prompt cache** (started). Keep what a chat sends before its messages the same from one message to the next, so the provider's prompt cache keeps hitting. Context that changes during a chat (memory captures, earlier chats, plugin notes, automation questions) is refreshed only when the cache has expired anyway, or travels with the message it belongs to. OpenAI requests carry a `prompt_cache_key` per chat.
2. **Earlier compaction.** Lower the compaction trigger from 400,000 input tokens to about 150,000, checked against real chats once phase 1 is in.
3. **Clear old tool results before compacting.** Replace old pages, notes and plugin output with one-line stubs, in batches so the cache breaks rarely; the action record keeps the facts. Full compaction runs only when that isn't enough.
4. **Intent-filtered reads.** An optional `find` on `web_read` and `vault_read` returns the matching sections with offsets and a heading outline instead of the next 20,000–40,000 characters. Later, maybe a `chat_find` over everything a chat has read.

Alongside: shorter plugin output (Spotify's metadata blob) and a review of the default effort, since output tokens cost five times input.

## Phase 6: Polish and reach

- Windows installer and auto-update.
- Global shortcut to open Custard from anywhere, plus a tray icon.
- Attach files and images in Chat.
- Investigate connecting to Claude cloud sessions, if a supported way exists.
