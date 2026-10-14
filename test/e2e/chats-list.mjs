// One chat list across modes, in the built app, against test/e2e/interrupt-mock.mjs:
//   - History shows every mode's chats by default, each marked with its mode
//   - a mode filter and a title search narrow it
//   - opening a chat from another mode switches to that mode and shows it
//   - deleting a chat from another mode removes it from the list
// Usage, from the repo root after `npx electron-vite build`:
//   node test/e2e/interrupt-mock.mjs <out> &   (with <out>/plugin a copy of plugin/
//                                               and <out>/vault a copy of vault-template/)
//   node test/e2e/chats-list.mjs <out> <screenshot dir>
// Linux only as written, with a display or xvfb-run. Needs the playwright package.
import { _electron as electron } from 'playwright'
import { createRequire } from 'module'
import fs from 'fs'

const [, , OUT, SHOTS] = process.argv
const check = (cond, what) => {
  console.log((cond ? '✓ ' : '✕ ') + what)
  if (!cond) process.exitCode = 1
}
const step = (s) => console.log('\n## ' + s)
const CFG = OUT + '/cfg-chats-list'
const VAULT = OUT + '/vault'
fs.rmSync(CFG, { recursive: true, force: true })
const app = await electron.launch({
  executablePath: createRequire(import.meta.url)('electron'),
  args: [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), '--password-store=basic', '.'],
  env: {
    ...process.env,
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:8899',
    XDG_CONFIG_HOME: CFG,
    CUSTARD_PLUGIN_DIR: OUT + '/plugin'
  }
})
await app.evaluate(({ safeStorage, dialog }, vault) => {
  safeStorage.setUsePlainTextEncryption?.(true)
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [vault] })
}, VAULT)
let w = null
for (let i = 0; !w && i < 300; i++) {
  w = app.windows().find((x) => x.url().endsWith('/renderer/index.html')) ?? null
  if (!w) await new Promise((r) => setTimeout(r, 100))
}
await w.setViewportSize({ width: 1280, height: 900 })
w.on('pageerror', (e) => console.log('pageerror:', e.message))
await w.waitForSelector('text=Custard')
const bubble = (name) => w.locator(`button[title]:text-is("${name}")`)
const send = async (t) => {
  await w.fill('textarea', t)
  await w.keyboard.press('Enter')
  await w.waitForSelector('button[title=Send]', { timeout: 30000 })
}
const rows = () => w.locator('aside .group')
const titles = async () =>
  (await w.locator('aside .group .truncate').allInnerTexts()).map((t) => t.trim())

try {
  step('Setup: key, vault, one chat in each of Chat, Plugins and Skills')
  await w.click('button[title=Settings]')
  await w.fill('input[aria-label="Claude API key"]', 'sk-ant-test')
  await w.press('input[aria-label="Claude API key"]', 'Enter')
  await w.click('button:has-text("Use an existing vault")')
  await w.waitForSelector('text=· connected')
  await w.click('button:text-is("Done")')
  await send('alpha chat question')
  await bubble('Plugins').click()
  await send('beta plugins question')
  await bubble('Skills').click()
  await send('gamma skills question')
  await bubble('Chat').click()
  await w.waitForSelector('text=alpha chat question')

  step('History lists every mode by default')
  await w.click('button[title="Chat history"]')
  await w.waitForSelector('aside >> text=All chats')
  const all = await titles()
  check(
    ['alpha', 'beta', 'gamma'].every((x) => all.some((t) => t.includes(x))),
    `all three chats are listed (${all.join(' | ')})`
  )
  const gammaRow = rows().filter({ hasText: 'gamma' })
  check((await gammaRow.innerText()).includes('Skills'), "a row names its chat's mode")
  await w.screenshot({ path: SHOTS + '/chats-01-all.png' })

  step('Filter and find narrow it')
  await w.click('aside [role=group] button:text-is("Plugins")')
  // The list is read again from the main process.
  await w
    .waitForFunction(() => document.querySelectorAll('aside .group').length === 1)
    .catch(() => {})
  const plugins = await titles()
  check(
    plugins.length === 1 && plugins[0].includes('beta'),
    `the Plugins filter shows only the Plugins chat (${plugins.join(' | ')})`
  )
  await w.click('aside [role=group] button:text-is("All")')
  await w.fill('input[aria-label="Find a chat"]', 'gamma')
  const found = await titles()
  check(found.length === 1 && found[0].includes('gamma'), 'searching titles finds one chat')

  step('Opening a chat from another mode switches to it')
  await rows().filter({ hasText: 'gamma' }).locator('button').first().click()
  await w.waitForSelector('text=gamma skills question')
  check(
    (await w.locator('button.molten-fill[title]').first().innerText()).trim() === 'Skills',
    'the mode bar now shows Skills'
  )

  step('Deleting a chat from another mode')
  await w.click('button[title="Skills history"]')
  await w.fill('input[aria-label="Find a chat"]', '')
  await rows().filter({ hasText: 'beta' }).hover()
  await rows().filter({ hasText: 'beta' }).locator('button[title=Delete]').click()
  await w.waitForFunction(() => !document.querySelector('aside')?.textContent?.includes('beta'))
  check(true, 'the Plugins chat is gone from the list')
  await w.keyboard.press('Escape')
} catch (e) {
  console.log('error:', e)
  process.exitCode = 1
  await w.screenshot({ path: SHOTS + '/chats-fail.png' }).catch(() => {})
} finally {
  await app.close()
  console.log('\ne2e done, exit', process.exitCode ?? 0)
}
