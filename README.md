# Custard 🍮

A personal desktop Claude client with three modes:

- **Chat**: normal conversations through the Claude API
- **Code**: Claude Code (via the Claude Agent SDK) working in a folder on this computer
- **Design**: generate UI and preview it live

Built with Electron, React, TypeScript, Vite (electron-vite) and Tailwind CSS.

## Getting started (Windows)

Requires Node.js 22 or newer.

```bash
npm install
npm run dev        # run the app with hot reload
npm run build:win  # build a Windows installer into dist/
```

## Chat mode

Open **Settings** and paste a Claude API key from [console.anthropic.com](https://console.anthropic.com), an OpenAI key from [platform.openai.com](https://platform.openai.com), or both. Keys are encrypted with Windows secure storage. Pick a model from either provider under the message box; the app turns amber for Claude and blue-grey for OpenAI. Chats are saved as JSON files in `%APPDATA%\custard\conversations`, and either provider can continue a chat the other started.

Pick the model and effort under the message box. Opus 5.5 and Sonnet 5.5 show a summary of Claude's thinking and fall back to another model automatically if a safety check declines a request.

## Obsidian brain

In **Settings**, click **Create starter vault** to get a ready-made vault (folders, templates, a memory note and starter skills, copied from [`vault-template/`](vault-template)), or choose an existing Obsidian vault. In Chat, Claude can then search, list and read your notes, create new notes and add to existing ones. It can't overwrite or delete anything, and every action shows up in the chat.

Claude keeps what it learns about you in `Custard/Memory.md` inside the vault. That note is loaded into every chat, and you can edit it in Obsidian like any other note.

Skills live in `Custard/Skills/<name>/SKILL.md`. Claude sees each skill's name and description and reads the full skill when a request matches. The starter vault includes note-writing, daily-note, weekly-review, project-kickoff and remember.

## Roadmap

See [docs/ROADMAP.md](docs/ROADMAP.md).

## Layout

- `src/main`: Electron main process (window, OS access, API calls)
- `src/preload`: the safe bridge exposed to the UI as `window.custard`
- `src/renderer`: the React UI
- `src/shared`: types shared by the main process and the UI
