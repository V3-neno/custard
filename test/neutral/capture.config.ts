import { resolve } from 'path'
import { defineConfig, mergeConfig } from 'vitest/config'
import base from '../../vitest.config'

// TEST ONLY. Runs the unit tests once with test/neutral/capture.setup.ts, to
// collect the histories they use. Run with NEUTRAL_CAPTURE_OUT=<file.jsonl>:
//   npx vitest run --config test/neutral/capture.config.ts
export default mergeConfig(
  base,
  defineConfig({
    root: resolve(__dirname, '../..'),
    test: { setupFiles: [resolve(__dirname, 'capture.setup.ts')] }
  })
)
