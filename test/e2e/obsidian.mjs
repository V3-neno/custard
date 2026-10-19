// Settings: "Get Obsidian" when nothing opens obsidian:// links, "Open in
// Obsidian" for the connected vault when something does. Electron's
// app.getApplicationNameForProtocol and shell.openExternal are stubbed, so no
// browser or Obsidian opens; whether real Windows and macOS report Obsidian
// this way is unverified. No model or key is needed.
// Usage, from the repo root after `npx electron-vite build`:
//   node test/e2e/obsidian.mjs <out> <screenshot dir>
// Linux only as written, with a display or xvfb-run. Needs the playwright package.
import { _electron as electron } from 'playwright'
import { createRequire } from 'module'
import fs from 'fs'
import path from 'path'

const [, , OUT, SHOTS] = process.argv
const check = (cond, what) => {
  console.log((cond ? '✓ ' : '✕ ') + what)
  if (!cond) process.exitCode = 1
}
const step = (s) => console.log('\n## ' + s)
const PARENT = path.join(OUT, 'obsidian-parent')
fs.rmSync(PARENT, { recursive: true, force: true })
fs.mkdirSync(PARENT, { recursive: true })
fs.mkdirSync(SHOTS, { recursive: true })
const app = await electron.launch({
  executablePath: createRequire(import.meta.url)('electron'),
  args: [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), '--password-store=basic', '.'],
  env: { ...process.env, XDG_CONFIG_HOME: path.join(OUT, 'cfg-obsidian') }
})
await app.evaluate(({ app, safeStorage, dialog, shell }, parent) => {
  safeStorage.setUsePlainTextEncryption?.(true)
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [parent] })
  globalThis.__opened = []
  globalThis.__handler = ''
  shell.openExternal = async (url) => {
    globalThis.__opened.push(url)
  }
  app.getApplicationNameForProtocol = () => globalThis.__handler
}, PARENT)
const opened = () => app.evaluate(() => globalThis.__opened)
const setHandler = (name) => app.evaluate((_, n) => (globalThis.__handler = n), name)
let w = null
for (let i = 0; !w && i < 300; i++) {
  w = app.windows().find((x) => x.url().endsWith('/renderer/index.html')) ?? null
  if (!w) await new Promise((r) => setTimeout(r, 100))
}
await w.setViewportSize({ width: 1280, height: 900 })
w.on('pageerror', (e) => console.log('pageerror:', e.message))
await w.waitForSelector('text=Custard')
const shot = (n) => w.screenshot({ path: `${SHOTS}/${n}.png` })
const settings = async () => {
  await w.click('button[title=Settings]')
  await w.waitForSelector('text=Obsidian vault')
}
const done = () => w.click('button:text-is("Done")')
const has = async (sel) => (await w.locator(sel).count()) > 0

try {
  step('Obsidian not installed, no vault')
  await settings()
  await w.waitForSelector('button:text-is("Get Obsidian")')
  check(await has("text=Obsidian isn't installed"), 'says Obsidian is not installed')
  check(!(await has('button:text-is("Open in Obsidian")')), 'no Open in Obsidian button')
  await w.locator('button:text-is("Get Obsidian")').scrollIntoViewIfNeeded()
  await shot('obsidian-01-get')
  await w.click('button:text-is("Get Obsidian")')
  await w.waitForTimeout(300)
  check(
    JSON.stringify(await opened()) === JSON.stringify(['https://obsidian.md/download']),
    'Get Obsidian opens only obsidian.md/download'
  )
  await done()

  step('Obsidian installed, starter vault created')
  await setHandler('Obsidian')
  await settings()
  check(!(await has('button:text-is("Get Obsidian")')), 'no Get Obsidian button once installed')
  check(!(await has('button:text-is("Open in Obsidian")')), 'no Open button without a vault')
  await w.click('button:text-is("Create starter vault")')
  await w.waitForSelector('text=· connected')
  const vault = path.join(PARENT, 'Custard Brain')
  check(fs.existsSync(path.join(vault, 'Home.md')), 'starter vault has Home.md')
  await w.click('button:text-is("Open in Obsidian")')
  await w.waitForSelector("text=If Obsidian can't find the vault")
  const last = (await opened()).at(-1)
  check(
    last === 'obsidian://open?path=' + encodeURIComponent(path.join(vault, 'Home.md')),
    'Open in Obsidian opens the vault Home note: ' + last
  )
  check((await opened()).length === 2, 'one link per click')
  await shot('obsidian-02-open')
  await done()

  step('Disconnect')
  await settings()
  await w.click('button:text-is("Disconnect")')
  await w.waitForSelector('button:text-is("Create starter vault")')
  check(
    !(await has('button:text-is("Open in Obsidian")')),
    'Open in Obsidian gone after Disconnect'
  )
} catch (e) {
  check(false, 'threw: ' + e.message)
  await shot('obsidian-error').catch(() => {})
} finally {
  await app.close()
}
