// Running in the background: the settings, the limits in the form, the tray
// menu, a notification when a run fails, closing to the tray, one Custard at a
// time, and quitting when the tray is off. Against test/e2e/interrupt-mock.mjs;
// usage as for automations.mjs:
//   node test/e2e/background.mjs <out> <screenshot dir>
// Linux only as written, with a display or xvfb-run. Needs the playwright package.
// Notifications and the tray are recorded in the main process (their show and
// setContextMenu are wrapped), not seen on a real desktop.
import { _electron as electron } from 'playwright'
import { createRequire } from 'module'
import { spawnSync } from 'child_process'
import fs from 'fs'

const [, , OUT, SHOTS] = process.argv
const check = (cond, what) => {
  console.log((cond ? '✓ ' : '✕ ') + what)
  if (!cond) process.exitCode = 1
}
const step = (s) => console.log('\n## ' + s)
const CFG = OUT + '/cfg-bg'
const V = OUT + '/vault'
const put = (p, text) => {
  fs.mkdirSync(`${V}/${p.split('/').slice(0, -1).join('/')}`, { recursive: true })
  fs.writeFileSync(`${V}/${p}`, text)
}
put('Notes/Plan.md', '# Plan\n- start\n')
put(
  'Custard/Skills/bg-log/SKILL.md',
  '---\nname: bg-log\ndescription: Adds a line to the plan.\n---\nAdd one line to Notes/Plan.md.\n'
)

const ELECTRON = createRequire(import.meta.url)('electron')
const ARGS = [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), '--password-store=basic', '.']
const ENV = {
  ...process.env,
  ANTHROPIC_BASE_URL: 'http://127.0.0.1:8899',
  XDG_CONFIG_HOME: CFG,
  CUSTARD_PLUGIN_DIR: OUT + '/plugin'
}
const app = await electron.launch({ executablePath: ELECTRON, args: ARGS, env: ENV })
await app.evaluate(({ safeStorage, dialog, Notification, Tray }, vault) => {
  safeStorage.setUsePlainTextEncryption?.(true)
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [vault] })
  globalThis.__notes = []
  globalThis.__menus = []
  globalThis.__images = []
  Notification.isSupported = () => true
  Notification.prototype.show = function () {
    globalThis.__notes.push({ title: this.title, body: this.body })
  }
  const setMenu = Tray.prototype.setContextMenu
  Tray.prototype.setContextMenu = function (m) {
    globalThis.__menus.push(m.items.map((i) => i.label).filter(Boolean))
    return setMenu.call(this, m)
  }
  const setImage = Tray.prototype.setImage
  Tray.prototype.setImage = function (img) {
    globalThis.__images.push(img.toDataURL())
    return setImage.call(this, img)
  }
}, V)
const notes = () => app.evaluate(() => globalThis.__notes)
const lastMenu = () => app.evaluate(() => globalThis.__menus.at(-1) ?? [])
const visible = () =>
  app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().some(
      (w) => w.webContents.getURL().endsWith('/renderer/index.html') && w.isVisible()
    )
  )
const until = async (f, ms = 30000) => {
  for (let t = 0; t < ms; t += 200) {
    if (await f()) return true
    await new Promise((r) => setTimeout(r, 200))
  }
  return false
}

let w = null
for (let i = 0; !w && i < 300; i++) {
  w = app.windows().find((x) => x.url().endsWith('/renderer/index.html')) ?? null
  if (!w) await new Promise((r) => setTimeout(r, 100))
}
await w.setViewportSize({ width: 1280, height: 1000 })
w.on('pageerror', (e) => console.log('pageerror:', e.message))
await w.waitForSelector('text=Custard')
let quitByUs = false

try {
  step('Setup: key, vault, one allowed folder')
  await w.click('button[title=Settings]')
  await w.fill('input[aria-label="Claude API key"]', 'sk-ant-test')
  await w.press('input[aria-label="Claude API key"]', 'Enter')
  await w.click('button:text-is("Use an existing vault")')
  await w.waitForSelector('text=· connected')
  await w.fill('input[aria-label="Folder to allow"]', 'Notes')
  await w.click('[role=group][aria-label="What Claude may do there"] button[data-mode=append]')
  await w.click('button:text-is("Allow")')
  await w.waitForSelector('ul[aria-label="Editable folders"] >> text=Notes/')

  step('Running in the background: defaults')
  await w.waitForSelector('[data-background]')
  check(
    !(await w.isChecked('input[aria-label="Keep running in the tray"]')),
    'keep in the tray is off by default'
  )
  check(
    await w.isDisabled('input[aria-label="Start at login"]'),
    'start at login is greyed out (tray off, and not the installed app)'
  )
  check(
    await w.isChecked('input[aria-label="Notify me about runs"]'),
    'notifications are on by default'
  )
  check(
    (await w.inputValue('input[aria-label="Runs a day for all automations"]')) === '48',
    'all automations together: 48 runs a day by default'
  )
  check(
    await w.isChecked('input[aria-label="Skip runs past the budget"]'),
    'runs past the budget are skipped by default'
  )
  await w.fill('input[aria-label="Runs a day for all automations"]', '500')
  await w.press('input[aria-label="Runs a day for all automations"]', 'Enter')
  await w.waitForSelector('text=must be a whole number from 1 to 200')
  check(true, 'an out-of-range runs a day is refused with its range')
  await w.fill('input[aria-label="Runs a day for all automations"]', '20')
  await w.press('input[aria-label="Runs a day for all automations"]', 'Enter')
  await new Promise((r) => setTimeout(r, 300))
  const saved = JSON.parse(fs.readFileSync(`${CFG}/custard/settings.json`, 'utf8')).background
  check(saved?.runsPerDayAll === 20, 'the new limit is saved')

  step('Keep in the tray')
  await w.check('input[aria-label="Keep running in the tray"]')
  check(
    await until(async () => (await lastMenu()).includes('Quit Custard'), 5000),
    'a tray icon appears with Open and Quit'
  )
  check((await lastMenu())[0] === 'No automations on', 'its menu says no automation is on')
  await w.locator('[data-background]').screenshot({ path: SHOTS + '/bg-01-settings.png' })

  step('Limits in the form')
  await w.click('button:text-is("New automation")')
  await w.fill('input[aria-label="Automation name"]', 'vgbg log')
  await w.selectOption('select[aria-label="Skill to run"]', 'bg-log')
  await w.fill('input[aria-label="Times of day"]', '07:30')
  await w.check('input[aria-label="Folder Notes"]')
  check(
    (await w.inputValue('input[aria-label="Tool calls per run"]')) === '30' &&
      (await w.inputValue('input[aria-label="Minutes per run"]')) === '5' &&
      (await w.inputValue('input[aria-label="Failures before pausing"]')) === '3',
    'all limits are in the form with their defaults'
  )
  await w.fill('input[aria-label="Tool calls per run"]', '500')
  await w.click('button:text-is("Save automation")')
  await w.waitForSelector('text=Tool calls per run must be a whole number from 1 to 100.')
  check(true, 'an out-of-range limit is refused, not quietly changed')
  await w.fill('input[aria-label="Tool calls per run"]', '10')
  await w.fill('input[aria-label="Minutes per run"]', '2')
  await w.locator('[data-limits-form]').screenshot({ path: SHOTS + '/bg-02-form-limits.png' })
  await w.click('button:text-is("Save automation")')
  await w.waitForSelector('ul[aria-label="Automations"] >> text=vgbg log')
  const limits = await w.locator('[data-limits]').first().textContent()
  check(
    limits ===
      'Limits: 24 runs a day · 10 tool calls and 2 min a run · pauses after 3 failures in a row · 3 catch-up runs',
    'the card shows every limit'
  )

  step('A failed run is notified, by name only')
  fs.rmSync(`${V}/Custard/Skills/bg-log`, { recursive: true })
  await w.click('button[aria-label="Run vgbg log now"]')
  check(
    await until(async () => (await notes()).some((n) => n.title === 'Automation failed')),
    'a notification says the automation failed'
  )
  const failed = (await notes()).find((n) => n.title === 'Automation failed')
  check(
    failed?.body === 'vgbg log failed. Details in Settings → Automations.',
    'it names the automation and where the details are, nothing from the run'
  )
  check(
    await until(async () => /^Last run: vgbg log, failed at /.test((await lastMenu())[1] ?? '')),
    'the tray menu shows the failed run'
  )
  const images = await app.evaluate(() => globalThis.__images)
  check(images.length >= 2 && new Set(images).size >= 2, 'the tray icon changed while it ran')
  const dot = images.find((x, i) => i > 0 && x !== images[0])
  if (dot)
    fs.writeFileSync(SHOTS + '/bg-03-tray-running.png', Buffer.from(dot.split(',')[1], 'base64'))
  await w
    .locator('ul[aria-label="Automations"] > li')
    .first()
    .screenshot({
      path: SHOTS + '/bg-04-card.png'
    })

  step('Closing the window hides it to the tray')
  await w.click('button:text-is("Done")')
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((x) => x.webContents.getURL().endsWith('/renderer/index.html'))
      ?.close()
  )
  check(await until(async () => !(await visible()), 5000), 'the window is hidden, not closed')
  check(
    (await notes()).some((n) => n.title === 'Custard is still running'),
    'a notification says Custard is still running'
  )

  step('Opening Custard again shows the one already running')
  const second = spawnSync(ELECTRON, ARGS, { env: ENV, timeout: 30000 })
  check(second.status === 0, 'the second Custard exits at once')
  check(await until(visible, 10000), 'and the first one shows its window')

  step('With the tray off, closing the window quits')
  await w.click('button[title=Settings]')
  await w.uncheck('input[aria-label="Keep running in the tray"]')
  await new Promise((r) => setTimeout(r, 300))
  const closed = new Promise((r) => app.process().once('exit', () => r(true)))
  quitByUs = true
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((x) => x.webContents.getURL().endsWith('/renderer/index.html'))
      ?.close()
  )
  check(
    await Promise.race([closed, new Promise((r) => setTimeout(() => r(false), 15000))]),
    'Custard quit'
  )
} finally {
  if (!quitByUs) await app.close()
  else await app.close().catch(() => {})
  console.log('e2e done, exit', process.exitCode ?? 0)
}
