# Custard 🍮

A personal desktop Claude client with four modes:

- **Chat**: normal conversations through the Claude API
- **Design**: generate UI and preview it live
- **Plugins**: build and improve a plugin in `plugin/<id>`. File access is checked by the app, and there is no shell. (This was Code mode; its General Code folder workspace was removed, and old General Code chats open read-only.)
- **Skills**: opens on a hub of every skill in `Custard/Skills` (what each does, its modes, the automations that run it), where you inspect one or start a chat to add or improve one; the chat also tidies the vault

Built with Electron, React, TypeScript, Vite (electron-vite) and Tailwind CSS.

## Getting started (Windows)

Requires Node.js 22 or newer.

```bash
npm install
npm run dev        # run the app with hot reload
npm run build:win  # build a Windows installer into dist/
```

## Credential storage on other systems

Custard is released for **Windows only**. API keys, plugin secrets and account tokens are encrypted with Electron `safeStorage`, which uses DPAPI on Windows.

**Linux and macOS are unsupported and unverified.** In particular, on Linux without a working keyring (libsecret or KWallet), Electron can fall back to its `basic_text` backend. That backend is **not** secure storage: anyone who can read Custard's app data folder can read the keys. Custard does not detect this. Don't keep real credentials in a Linux build. The Linux runs in this repository's tests use fake keys only.

## Chat mode

Open **Settings** and paste a Claude API key from [console.anthropic.com](https://console.anthropic.com), an OpenAI key from [platform.openai.com](https://platform.openai.com), or both. Keys are encrypted with Windows secure storage. Pick a model from either provider under the message box; the app turns amber for Claude and blue-grey for OpenAI. Chats are saved as JSON files in `%APPDATA%\custard\conversations`, and either provider can continue a chat the other started.

**Plugins:** plugins add tools to the assistant. They live in [`plugin/`](plugin), are developed in Plugins mode, and are reviewed, activated, configured and disabled in **Settings → Plugins**. Each runs in its own sandbox and reaches the network only through the app. See [docs/plugins](docs/plugins/README.md).

**Spotify (optional plugin):** search Spotify, see what's playing and queue songs that match the music preferences in your vault. It needs Spotify Premium and a free Spotify developer app; see [docs/SPOTIFY.md](docs/SPOTIFY.md) for setup.

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
- `src/main/plugins`, `src/plugin-sdk`: the plugin host and the plugin API
- `src/main/workspace`: Plugins mode's folder-bounded file tools
- `plugin/`: plugin source (Spotify)
