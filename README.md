# Custard 🍮

A personal desktop Claude client with four modes:

- **Chat**: normal conversations through the Claude API
- **Design**: generate UI and preview it live
- **Plugins**: build and improve a plugin in `plugin/<id>`. File access is checked by the app, and there is no shell. (This was Code mode; its General Code folder workspace was removed, and old General Code chats open read-only.)
- **Skills**: opens on a hub of every skill in `Custard/Skills` (what each does, its modes, the automations that run it), where you inspect one or start a chat to add or improve one; the chat also tidies the vault

Built with Electron, React, TypeScript, Vite (electron-vite) and Tailwind CSS.

## Install

Download Custard from the repository's [Releases](https://github.com/V3-neno/custard/releases) page (you need to be signed in to GitHub while the repository is private). No clone, Node.js or build is needed.

| Computer                              | File                              |
| ------------------------------------- | --------------------------------- |
| Windows (64-bit)                      | `custard-<version>-setup.exe`     |
| Mac with Apple Silicon (M1 and later) | `custard-<version>-mac-arm64.dmg` |
| Mac with an Intel chip                | `custard-<version>-mac-x64.dmg`   |

The installers aren't signed with a paid certificate, so the system warns once per version:

- **Windows:** run the installer. When SmartScreen says "Windows protected your PC", click **More info**, then **Run anyway**. Custard installs for your user and adds a desktop shortcut.
- **macOS:** open the `.dmg` and drag Custard to Applications. The first open is blocked; go to **System Settings > Privacy & Security**, scroll down, and click **Open Anyway** next to Custard. If macOS says the app "is damaged", run `xattr -cr /Applications/Custard.app` in Terminal and open it again.

Then, in Custard:

1. Open **Settings** (the gear, top right) and paste an API key (see [Chat mode](#chat-mode)).
2. Under **Obsidian vault**, click **Create starter vault** and choose where the "Custard Brain" folder goes. The starter vault ships inside the app.
3. Click **Get Obsidian** if it isn't installed (Obsidian is free from [obsidian.md](https://obsidian.md/download); Custard can't include it), then **Open in Obsidian**. If Obsidian can't find the vault, choose **Open folder as vault** in Obsidian and pick "Custard Brain".

The macOS builds, Obsidian detection and the Open in Obsidian link have not yet been tried on a real Mac or Windows PC.

### Making a release

Set the version in `package.json`, commit, then push a matching tag:

```bash
git tag v0.1.0
git push origin v0.1.0
```

[`.github/workflows/release.yml`](.github/workflows/release.yml) runs the type check, lint and unit tests, builds each installer on its own GitHub runner (Windows, Apple Silicon Mac, Intel Mac) and creates a **draft** release with the files, `SHA256SUMS.txt` and the notes from [`.github/release/notes.md`](.github/release/notes.md). Check it on the Releases page and click **Publish**. **Actions > Release > Run workflow** builds the installers as workflow artifacts without a release.

## Building from source

Requires Node.js 22 or newer.

```bash
npm install
npm run dev        # run the app with hot reload
npm run build:win  # build a Windows installer into dist/ (on Windows)
npm run build:mac  # build a dmg and zip for this Mac's chip into dist/ (on macOS)
```

Build each installer on its own system: a package built for another system carries the wrong esbuild binary, and plugins won't build in it.

## Credential storage on other systems

API keys, plugin secrets and account tokens are encrypted with Electron `safeStorage`, which uses DPAPI on Windows and the Keychain on macOS.

**macOS is unverified.** The Keychain is secure storage, but Custard's use of it has not been tested on a Mac. Expect a Keychain prompt the first time Custard reads a key (unverified), and possibly again after an update, because each unsigned build has a new signature.

**Linux is unsupported and unverified.** In particular, on Linux without a working keyring (libsecret or KWallet), Electron can fall back to its `basic_text` backend. That backend is **not** secure storage: anyone who can read Custard's app data folder can read the keys. Custard does not detect this. Don't keep real credentials in a Linux build. The Linux runs in this repository's tests use fake keys only.

## Chat mode

Open **Settings** and paste a Claude API key from [console.anthropic.com](https://console.anthropic.com), an OpenAI key from [platform.openai.com](https://platform.openai.com), or both. Keys are encrypted with the system's secure storage (Windows DPAPI, the macOS Keychain). Pick a model from either provider under the message box; the app turns amber for Claude and blue-grey for OpenAI. Chats are saved as JSON files in `%APPDATA%\custard\conversations` (`~/Library/Application Support/custard/conversations` on macOS), and either provider can continue a chat the other started.

**Plugins:** plugins add tools to the assistant. They live in [`plugin/`](plugin), are developed in Plugins mode, and are reviewed, activated, configured and disabled from Plugins mode's start page (**Manage** on a plugin's card). Each runs in its own sandbox and reaches the network only through the app. See [docs/plugins](docs/plugins/README.md).

**Spotify (optional plugin):** search Spotify, see what's playing and queue songs that match the music preferences in your vault. It needs Spotify Premium and a free Spotify developer app; see [docs/SPOTIFY.md](docs/SPOTIFY.md) for setup.

Pick the model and effort under the message box. Opus 5.5 and Sonnet 5.5 show a summary of Claude's thinking and fall back to another model automatically if a safety check declines a request.

## Obsidian brain

In **Settings**, click **Create starter vault** to get a ready-made vault (folders, templates, a memory note and starter skills, copied from [`vault-template/`](vault-template)), or choose an existing Obsidian vault. In Chat, Claude can then search, list and read your notes, create new notes and add to existing ones. It can't overwrite or delete anything, and every action shows up in the chat.

Claude keeps what it learns about you in `Custard/Memory.md` inside the vault. That note is loaded into every chat, and you can edit it in Obsidian like any other note.

Skills live in `Custard/Skills/<name>/SKILL.md`. Claude sees each skill's name and description and reads the full skill when a request matches. The starter vault includes note-writing, daily-note, weekly-review, project-kickoff, remember, skill-authoring, automation-skill-authoring, plugin-development, image-making, and skills for working efficiently: lean-work (fewer calls and less text), chat-recall (find what earlier chats decided), chat-housekeeping (one topic per chat, what is still open), chat-guard (outside text, secrets, actions), focus-planner (plan around the time you have), plugin-blueprint (agree the smallest plugin before building) and custard-tuneup (a weekly review of where Custard could be cheaper or faster).

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
