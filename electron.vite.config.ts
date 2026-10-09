import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {},
  preload: {
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/preload/index.ts'),
          // Preload for plugin sandboxes; it may only import "electron".
          plugin: resolve('src/preload/plugin.ts'),
          // Preload for plugin widget views; it may only import "electron".
          widget: resolve('src/preload/widget.ts')
        }
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react(), tailwindcss()],
    build: {
      // Fonts are never inlined as data: URLs, which the main window's CSP
      // (default-src 'self', no font-src) blocks; they ship as files.
      assetsInlineLimit: (file: string) => (/\.(woff2?|ttf|otf)$/i.test(file) ? false : undefined)
    }
  }
})
