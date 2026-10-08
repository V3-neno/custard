// Runs test/electron/*.e2e.ts inside Electron, which the plugin sandbox needs.
//   npm run test:electron
import { build } from 'esbuild'
import { spawnSync } from 'child_process'
import { mkdirSync } from 'fs'
import { join, resolve } from 'path'
import electron from 'electron'

const repo = resolve(import.meta.dirname, '..')
const out = join(repo, 'out-test')
mkdirSync(out, { recursive: true })
await build({
  entryPoints: [join(repo, 'test/electron/sandbox.e2e.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: join(out, 'main.cjs'),
  external: ['electron', 'esbuild'],
  logLevel: 'warning'
})
await build({
  entryPoints: [join(repo, 'src/preload/plugin.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: join(out, 'plugin-preload.cjs'),
  external: ['electron'],
  logLevel: 'warning'
})

const args = [join(out, 'main.cjs')]
// Chromium refuses its sandbox when run as root (as in CI containers).
if (process.getuid?.() === 0) args.unshift('--no-sandbox')
const headless = process.platform === 'linux' && !process.env.DISPLAY
const cmd = headless ? 'xvfb-run' : electron
const r = spawnSync(headless ? cmd : electron, headless ? ['-a', electron, ...args] : args, {
  env: {
    ...process.env,
    CUSTARD_TEST_PRELOAD: join(out, 'plugin-preload.cjs'),
    CUSTARD_REPO: repo,
    ELECTRON_ENABLE_LOGGING: '0'
  },
  encoding: 'utf8',
  timeout: 120_000
})
const line = (r.stdout ?? '').split('\n').find((l) => l.startsWith('RESULTS '))
if (!line) {
  console.error(r.stdout, r.stderr)
  process.exit(1)
}
const results = JSON.parse(line.slice(8))
for (const t of results)
  console.log(`${t.ok ? '✓' : '✗'} ${t.name}${t.ok ? '' : `\n    ${t.detail}`}`)
console.log(`\n${results.filter((t) => t.ok).length}/${results.length} passed`)
process.exit(results.every((t) => t.ok) ? 0 : 1)
