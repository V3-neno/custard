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

## Layout

- `src/main`: Electron main process (window, OS access, API calls)
- `src/preload`: the safe bridge exposed to the UI as `window.custard`
- `src/renderer`: the React UI
