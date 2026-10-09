import { defineConfig } from 'vitest/config'

// Native-platform checks (test/platform/README.md), kept out of the normal
// unit run: npx vitest run --config test/platform/vitest.platform.config.ts
export default defineConfig({
  test: { include: ['test/platform/**/*.test.ts'] }
})
