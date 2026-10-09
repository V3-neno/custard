# Mock media plugins

Development-only plugins for Design's plugin media support
(docs/design/MEDIA-PLUGINS.md). They are copied into a temporary plugin
folder by the tests and `test/e2e/design-media.mjs`. They are never in
`plugin/`, never bundled, and contact no real service.

- `slowmo`: an asynchronous video provider. Submit, status, result and
  cancel tools declared under `media`; words in the prompt script failures
  (see the comment at the top of `src/index.ts`). Its only output is a fixed
  2-second test pattern.
