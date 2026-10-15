# Neutral chat format: test-only files (B2)

Nothing here ships in the app. Electron-vite bundles only what `src/main/index.ts`, the preload and the window import, and nothing imports these files.

- `legacy.ts` turns a history in today's stored format (Anthropic messages) into the neutral format, so tests can compare today's requests with the neutral converters' output. It is not migration code: it throws on any shape Custard doesn't store, and the app never converts old chats.
- `unit-histories.json` is every history the unit suite passes to the request path, or to the code that reads stored chats. It was captured by `capture.setup.ts`, and strings over 4 KB were shortened. To capture it again:

  ```
  NEUTRAL_CAPTURE_OUT=/tmp/cap.jsonl npx vitest run --config test/neutral/capture.config.ts
  ```

  Then deduplicate the lines into the JSON file (see the B2 review).
- `src/main/adapters/neutral.test.ts` holds the checks. Its last block runs only with `NEUTRAL_E2E_DIR` set to an e2e run's output folder. It reads every stored chat in that run, plus the `requests.json` files that `claude-turn`, `responses-turn` and `round-trip` write, and rebuilds each logged request body from the stored chat.
