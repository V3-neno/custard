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

Later in this phase:

- Save a chat as a note with one click.
- Understand `[[wikilinks]]`, tags and backlinks when reading notes.
- Smarter search (ranking, then possibly embeddings) once vaults get large.

## Phase 3: Code mode

Claude Code inside Custard, using the Claude Agent SDK in the main process.

- Open a project folder and chat with Claude Code about it.
- Show tool calls, file diffs and permission prompts in the UI.
- Give it the same vault access, so coding sessions can use and update the brain.

## Phase 4: Design mode

- Split view: chat on one side, a live sandboxed preview of the HTML/React Claude generates on the other.
- Save designs to the vault or a project folder.

## Phase 5: Skills

Agent Skills are folders with a `SKILL.md` file that teach Claude a procedure.

- Keep skills in the vault (for example `Custard/Skills/`) so they're editable in Obsidian.
- Chat: list each skill's name and description to Claude, and let it load the full skill when a task matches.
- Code: pass the same skills to the Claude Agent SDK.
- Manage skills from a Skills page in Custard.

## Phase 6: Polish and reach

- Windows installer and auto-update.
- Global shortcut to open Custard from anywhere, plus a tray icon.
- Attach files and images in Chat.
- Investigate connecting to Claude cloud sessions, if a supported way exists.
