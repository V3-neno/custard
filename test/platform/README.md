# Platform and packaged-build checks

Harnesses for stabilization Thread 4. They run the existing mock e2e tests
against a **packaged** build with Chromium's sandbox on, and hold the native
Windows checks. Nothing here is part of the app, and nothing contacts a real
provider.

| File | What it is |
| --- | --- |
| `launch.mjs` | How e2e tests start Custard: the dev build, or `CUSTARD_EXE` (packaged, sandbox on unless root). Used by `design-security`, `widgets`, `preview-platform`, `media-sizes`. |
| `packaged-linux.sh` | Linux runner: copies `dist/linux-unpacked`, starts the mock and the TLS front, runs one test as a non-root user in its own mount namespace. |
| `tls-front.mjs` | Test-only TLS server. Packaged builds pin `api.anthropic.com` / `api.openai.com` (L13), so the test maps those names to 127.0.0.1 inside its namespace and trusts a throwaway CA. The app's pinning stays on. |
| `sandbox-evidence.mjs` | 4.1: versions, flags, fuses and the kernel's view (seccomp, namespaces) of each process. Writes `<out>/sandbox-evidence.json`. |
| `fixtures/bigmedia/` | 4.4: a media plugin that builds big or broken files inside its sandbox. Installed by `test/e2e/media-sizes.mjs`. |
| `windows/fsafe-junctions.test.ts` | 4.2: fsafe with junctions and Windows path forms. Skips elsewhere. |
| `vitest.platform.config.ts` | Runs the native checks: `npx vitest run --config test/platform/vitest.platform.config.ts`. |

## Linux, packaged, sandbox on

On a throwaway Linux machine or container with root, xvfb, openssl and
unprivileged user namespaces (or a setuid `chrome-sandbox`):

```sh
npm ci && npm i --no-save playwright
npm run build:unpack
sudo test/platform/packaged-linux.sh test/platform/sandbox-evidence.mjs
sudo FRONT_ROUTES="api.openai.com=8898" test/platform/packaged-linux.sh test/e2e/design-security.mjs
sudo test/platform/packaged-linux.sh test/e2e/widgets.mjs
sudo PREVIEW_CYCLES=200 test/platform/packaged-linux.sh test/e2e/preview-platform.mjs
sudo test/platform/packaged-linux.sh test/e2e/media-sizes.mjs
```

Stop any other mock on port 8899 first: the script starts its own.

## Windows and macOS

See `docs/design/PLATFORM-CHECKLIST.md`.
