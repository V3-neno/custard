import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: [
      { find: /^custard-plugin-sdk\/testing$/, replacement: resolve('src/plugin-sdk/testing.ts') },
      { find: /^custard-plugin-sdk\/widget$/, replacement: resolve('src/plugin-sdk/widget.ts') },
      { find: /^custard-plugin-sdk$/, replacement: resolve('src/plugin-sdk/index.ts') }
    ]
  },
  test: {
    // Plugin tests (plugin/*/tests) use the SDK's own runner and are run by
    // src/plugin-sdk/plugin-tests.test.ts.
    include: ['src/**/*.test.ts']
  }
})
