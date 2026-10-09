// The main window stays on its own page (will-navigate / will-redirect), and
// is sandboxed: a script that tries to send it to another page fails, and the
// other page never gets window.custard.
//   node test/e2e/main-window-lock.mjs <out> <screenshot dir>
// Linux only as written, with a display or xvfb-run. Needs the playwright package.
import { _electron as electron } from 'playwright'
import { createRequire } from 'module'
import fs from 'fs'
import http from 'http'

const [, , OUT] = process.argv
const check = (cond, what) => {
  console.log((cond ? '✓ ' : '✕ ') + what)
  if (!cond) process.exitCode = 1
}
const CFG = OUT + '/cfg-lock'
fs.rmSync(CFG, { recursive: true, force: true })
let hits = 0
const foreign = http
  .createServer((req, res) => {
    hits++
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/page' }).end()
      return
    }
    res.writeHead(200, { 'content-type': 'text/html' }).end('<title>foreign</title>foreign')
  })
  .listen(0, '127.0.0.1')
await new Promise((r) => foreign.once('listening', r))
const base = `http://127.0.0.1:${foreign.address().port}`

const app = await electron.launch({
  executablePath: createRequire(import.meta.url)('electron'),
  args: [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), '--password-store=basic', '.'],
  env: { ...process.env, XDG_CONFIG_HOME: CFG }
})
let w = null
for (let i = 0; !w && i < 300; i++) {
  w = app.windows().find((x) => x.url().endsWith('/renderer/index.html')) ?? null
  if (!w) await new Promise((r) => setTimeout(r, 100))
}
await w.waitForSelector('text=Custard')
const home = w.url()

for (const [what, url] of [
  ['a script navigating to another page', base + '/page'],
  ['a redirect from another page', base + '/redirect'],
  ['a file page', 'file:///etc/hostname']
]) {
  await w.evaluate((u) => void (location.href = u), url).catch(() => {})
  await new Promise((r) => setTimeout(r, 1000))
  check(w.url() === home, `${what}: the window stays on the app page`)
}
check(hits === 0, `the other server was never contacted (${hits} requests)`)
check(
  await w.evaluate(() => typeof window.custard === 'object'),
  'the app still has window.custard'
)
await app.close()
foreign.close()
