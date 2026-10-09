# Thread 4 requests to the integration owner (stabilization batch)

Files outside Thread 4's list in stabilization-plan.md §3, with evidence.

## R1. Packaged builds can't activate any plugin (build.ts) — committed here, please review

`src/main/plugins/build.ts`: esbuild spawns its native binary, and `spawn`
can't run a file inside `app.asar`, so every plugin build failed in the
packaged app with `Error: spawn ENOTDIR` ("It can't be activated yet").
`widgets.mjs` against the packaged build failed at activation before the
fix and passes 65/65 after it. The fix points `ESBUILD_BINARY_PATH` at the
`app.asar.unpacked` copy (already unpacked by `electron-builder.yml`), and
only when running from `app.asar`; development is unchanged. It is in its
own commit on `claude/stab-4-platform` so it can be taken or dropped alone.

## R2. Same loopback leak in plugin and widget sessions (runtime.ts) — not changed

`src/main/plugins/runtime.ts` `lockedSession` sets the dead proxy with
`proxyBypassRules: ''`, the pattern that let a preview's WebRTC TURN-over-TCP
reach 127.0.0.1 (fixed for previews with `'<-loopback>'`). Plugin sandboxes
and widgets get the same `disable_non_proxied_udp` policy, so they very
likely have the same hole: plugin code or widget UI could open TCP
connections to local services outside its approved hosts. **Inferred from
the code, not run.** Suggested change: `proxyBypassRules: '<-loopback>'`
there too, plus a TURN probe in the widget fixture.

## R3. F6 hint in the workspace (Workspace.tsx) — not changed

F6 now returns focus from a preview to the app (preview.ts). Nothing tells
the user. Suggest a small "F6 to leave the preview" hint on the preview
frame, in the forge style, if Neno wants one.

## R4. Media results over the data limit get a misleading message (host.ts / adapter) — not changed

A plugin result above `MEDIA_DATA_BYTES` (48 MB of data, about 36 MB of file)
fails as "returned a result Custard can't read". It should say it was larger
than Custard accepts, since that result may have been paid for.
`test/e2e/media-sizes.mjs` records this (`saysSize: false`).

## R5. Two result files with the same name lose the whole result — not changed

A plugin returning two files both named `image.png` fails with
`"image.png" is listed twice.` and nothing is kept. Suggest renaming
duplicates (`image-2.png`) in the adapter before storing, so a provider's
naming slip doesn't discard a paid result.

## R6. Main window CSP blocks inlined fonts — not changed

Packaged and dev: `src/renderer/index.html`'s CSP has no `font-src`, so
`default-src 'self'` blocks the small font subsets Vite inlines as `data:`
(Space Grotesk / JetBrains Mono vietnamese and similar). Text in those
scripts falls back to another font. Either add `font-src 'self' data:` or
stop inlining fonts (`build.assetsInlineLimit`).
