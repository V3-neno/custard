// Test harness (plain .mjs, like test/e2e, which ESLint skips).
/* eslint-disable @typescript-eslint/explicit-function-return-type */
// How the e2e tests start Custard. By default the development build
// (`electron .` after `npx electron-vite build`). With CUSTARD_EXE set, the
// packaged binary instead (test/platform/README.md), with Chromium's sandbox
// on unless running as root, where Chromium refuses it. Playwright's Electron
// launcher adds --no-sandbox unless chromiumSandbox is true.
import { createRequire } from 'module'

export function appLaunch() {
  const exe = process.env.CUSTARD_EXE
  const root = process.getuid?.() === 0
  return {
    executablePath: exe || createRequire(import.meta.url)('electron'),
    args: [...(root ? ['--no-sandbox'] : []), '--password-store=basic', ...(exe ? [] : ['.'])],
    chromiumSandbox: Boolean(exe) && !root
  }
}
