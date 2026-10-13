// The Plugins hub in the built app, against test/e2e/interrupt-mock.mjs:
//   - Settings has no Plugins tab and no plugin settings any more
//   - Plugins mode opens on every plugin in plugin/, with its state
//   - Manage opens what Settings → Plugins held, and activating works there
//   - the Manage panel floats (it doesn't run the full height of the window)
//   - pressing a card enters the plugin's workspace: its chats as cards,
//     newest first, a path bar back to the hub, and no plugin selector
//   - a chat started in the workspace belongs to it; the path bar goes back
//     to the workspace's chats and to the hub; History names the plugin
//   - Add asks only for a name, makes plugin/<id> from it and enters it
//   - clicking the shown mode again returns to its start page, and leaving
//     a mode and coming back reopens its chat
// Usage, from the repo root after `npx electron-vite build`:
//   node test/e2e/interrupt-mock.mjs <out> &   (with <out>/plugin a copy of plugin/
//                                               and <out>/vault a copy of vault-template/)
//   node test/e2e/plugins-hub.mjs <out> <screenshot dir>
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
const CFG = OUT + '/cfg-plugins-hub'
const VAULT = OUT + '/vault'
fs.rmSync(CFG, { recursive: true, force: true })
fs.rmSync(`${OUT}/plugin/hub-made`, { recursive: true, force: true })
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
const card = (name) => w.locator(`article[aria-label="Plugin ${name}"]`)
const bubble = (name) => w.locator(`button[title]:text-is("${name}")`)
const requests = () =>
  fs.existsSync(OUT + '/anthropic.json')
    ? JSON.parse(fs.readFileSync(OUT + '/anthropic.json', 'utf8')).length
    : 0
const box = () => w.inputValue('textarea')

try {
  step('Settings no longer holds plugins')
  await w.click('button[title=Settings]')
  await w.fill('input[aria-label="Claude API key"]', 'sk-ant-test')
  await w.press('input[aria-label="Claude API key"]', 'Enter')
  await w.click('button:has-text("Use an existing vault")')
  await w.waitForSelector('text=· connected')
  const tabs = await w.locator('[role=tab]').allInnerTexts()
  check(tabs.join(',') === 'General,Design', `Settings tabs are General and Design (${tabs})`)
  check(
    (await w.locator('text=Ask before plugin actions').count()) === 0,
    'the plugin-action setting is not in Settings'
  )
  await w.click('button:text-is("Done")')

  step('A chat in Chat mode, to come back to')
  await w.fill('textarea', 'hello there')
  await w.keyboard.press('Enter')
  await w.waitForSelector('button[title=Send]', { timeout: 30000 })
  await w.waitForSelector('text=hello there')

  step('Plugins mode opens on the hub')
  await bubble('Plugins').click()
  await card('Spotify').waitFor()
  const spotify = await card('Spotify').innerText()
  check(spotify.includes('Not activated'), 'a card shows the state')
  check(
    /\d+ tools · \d+ change things/.test(spotify),
    'a card counts its tools and the ones that change things'
  )
  check(spotify.includes('Ready to review'), 'a plugin waiting for review says so')
  check(
    (await w.locator('text=Ask before plugin actions').count()) === 1,
    'the plugin-action setting is on the hub'
  )
  await w.screenshot({ path: SHOTS + '/plugins-01-hub.png' })

  step('Manage holds everything Settings → Plugins did')
  await card('Spotify').getByRole('button', { name: 'Manage' }).click()
  const panel = w.locator('[role=dialog][aria-label="Manage Spotify"]')
  await panel.waitFor()
  await panel.getByRole('button', { name: 'Review and activate' }).click()
  await w.waitForSelector('text=New permissions to approve', { timeout: 30000 })
  const boxes = w.locator('section:has-text("New permissions to approve") input[type=checkbox]')
  for (let i = 0; i < (await boxes.count()); i++) await boxes.nth(i).check()
  await w.click('button:text-matches("^Activate [0-9]")')
  await w.waitForSelector('text=Save configuration', { timeout: 30000 })
  const text = await panel.innerText()
  check(
    ['Configuration', 'Account', 'in Chat, Design and Skills', 'Disable', 'Uninstall'].every((x) =>
      text.includes(x)
    ),
    'the panel has configuration, account, Chat/Design/Skills use, disable and uninstall'
  )
  await w.screenshot({ path: SHOTS + '/plugins-02-manage.png' })
  await panel.getByRole('button', { name: 'Done' }).click()
  check(
    (await card('Spotify').innerText()).includes('Enabled'),
    'the card shows the new state after closing'
  )

  step('The Manage panel floats')
  await card('Spotify').getByRole('button', { name: 'Manage' }).click()
  await panel.waitFor()
  await w.waitForTimeout(400) // its slide-in
  const rect = await panel.boundingBox()
  check(
    rect && rect.height <= 900 * 0.8 + 1 && rect.y >= 80 && rect.x + rect.width <= 1280 - 8,
    `the panel has a gap around it (${JSON.stringify(rect)})`
  )
  await panel.getByRole('button', { name: 'Done' }).click()

  step('Pressing a card enters the plugin workspace')
  const sent = requests()
  await card('Spotify').getByRole('button', { name: 'Open Spotify' }).click()
  await w.waitForSelector('text=Workspace · plugin/spotify')
  const path = () => w.locator('nav[aria-label="Where you are"]').innerText()
  check(
    (await path()).replace(/\s+/g, ' ') === 'All plugins › Spotify',
    'the path bar shows All plugins › Spotify'
  )
  check((await w.locator('select[aria-label=Plugin]').count()) === 0, 'there is no plugin selector')
  check(
    (await w.locator('text=No chats in this workspace yet').count()) === 1,
    'a workspace with no chats says so'
  )
  check((await box()) === '', 'nothing is put in the message box')
  check(requests() === sent, 'nothing was sent')
  await w.screenshot({ path: SHOTS + '/workspace-01-empty.png' })

  step('A chat started in the workspace belongs to it')
  await w.fill('textarea', 'first workspace chat')
  await w.keyboard.press('Enter')
  await w.waitForSelector('button[title=Send]', { timeout: 30000 })
  const sentReq = JSON.parse(fs.readFileSync(OUT + '/anthropic.json', 'utf8')).at(-1)
  check(
    (sentReq.tools ?? []).includes('fs_write') &&
      (sentReq.tools ?? []).some((t) => t.startsWith('spotify__')),
    `the chat has the workspace file tools and Spotify's tools (${sentReq.tools})`
  )
  check(
    (await path()).replace(/\s+/g, ' ') === 'All plugins › Spotify › first workspace chat',
    'the path bar adds the chat'
  )
  await w.fill('textarea', 'a second message')
  await w.keyboard.press('Enter')
  await w.waitForSelector('button[title=Send]', { timeout: 30000 })
  await w
    .locator('nav[aria-label="Where you are"]')
    .getByRole('button', { name: 'Spotify' })
    .click()
  await w.waitForSelector('[aria-label="Chat first workspace chat"]')
  check(true, 'Spotify in the path bar goes back to the workspace, which lists the chat as a card')
  await w.fill('textarea', 'second workspace chat')
  await w.keyboard.press('Enter')
  await w.waitForSelector('button[title=Send]', { timeout: 30000 })
  await w
    .locator('nav[aria-label="Where you are"]')
    .getByRole('button', { name: 'Spotify' })
    .click()
  await w.waitForSelector('[aria-label="Chat second workspace chat"]')
  const order = await w
    .locator('[aria-label="Chats in this workspace"] > button')
    .evaluateAll((b) => b.map((x) => x.getAttribute('aria-label')))
  check(
    order.join('|') === 'Chat second workspace chat|Chat first workspace chat',
    `the cards are newest first (${order})`
  )
  await w.screenshot({ path: SHOTS + '/workspace-02-chats.png' })
  await w.locator('[aria-label="Chat first workspace chat"]').click()
  await w.waitForSelector('text=a second message')
  check(true, 'a card opens its chat')
  await w.screenshot({ path: SHOTS + '/workspace-03-chat.png' })
  await w.click('button[title="Plugins history"]')
  const row = w.locator('button:has-text("first workspace chat")').first()
  check(
    (await row.locator('[data-chat-plugin]').innerText()).includes('Spotify'),
    'History names the plugin of a Plugins chat'
  )
  await w.screenshot({ path: SHOTS + '/workspace-04-history.png' })
  await w.mouse.click(1200, 450)
  await w
    .locator('nav[aria-label="Where you are"]')
    .getByRole('button', { name: 'All plugins' })
    .click()
  await card('Spotify').waitFor()
  check(true, 'All plugins in the path bar goes back to the hub')

  step('Add asks for a name only, makes the folder and enters it')
  const beforeAdd = requests()
  await w.click('button:has-text("Add a plugin")')
  check((await w.locator('input[aria-label="New plugin id"]').count()) === 0, 'no id is asked for')
  await w.fill('input[aria-label="New plugin name"]', 'Hub Made')
  check(
    (await w.locator('[data-new-plugin-folder]').innerText()).includes('plugin/hub-made'),
    'the folder it will make is shown'
  )
  await w.click('button:text-is("Create and open")')
  await w.waitForSelector('text=Workspace · plugin/hub-made')
  check(fs.existsSync(`${OUT}/plugin/hub-made/plugin.json`), 'plugin/hub-made was written')
  check(
    JSON.parse(fs.readFileSync(`${OUT}/plugin/hub-made/plugin.json`, 'utf8')).name === 'Hub Made',
    'its name is the one typed'
  )
  check(requests() === beforeAdd, 'creating it sent nothing')
  await bubble('Plugins').click()
  await card('Spotify').waitFor()
  check(true, 'clicking Plugins in a workspace goes back to the hub')

  step('Clicking the shown mode returns to its start page')
  await w.fill('textarea', 'plain question')
  await w.keyboard.press('Enter')
  await w.waitForSelector('button[title=Send]', { timeout: 30000 })
  check((await card('Spotify').count()) === 0, 'a sent message replaces the hub with the chat')
  await bubble('Plugins').click()
  await card('Spotify').waitFor()
  check(true, 'clicking Plugins again shows the hub')

  step('Coming back to a mode reopens its chat')
  await bubble('Chat').click()
  await w.waitForSelector('text=hello there')
  check(true, 'Chat mode still shows the chat from before')
} catch (e) {
  console.log('error:', e)
  process.exitCode = 1
  await w.screenshot({ path: SHOTS + '/plugins-fail.png' }).catch(() => {})
} finally {
  await app.close()
  console.log('\ne2e done, exit', process.exitCode ?? 0)
}
