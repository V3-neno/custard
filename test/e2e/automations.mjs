// Automations: create one in Settings, run it now, and check what it did and
// what it could not do. Against test/e2e/interrupt-mock.mjs; usage as for
// hardening.mjs:
//   node test/e2e/automations.mjs <out> <screenshot dir>
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
const CFG = OUT + '/cfg-auto'
const V = OUT + '/vault'
const file = (p) => fs.readFileSync(`${V}/${p}`, 'utf8')
const put = (p, text) => {
  fs.mkdirSync(`${V}/${p.split('/').slice(0, -1).join('/')}`, { recursive: true })
  fs.writeFileSync(`${V}/${p}`, text)
}
put('Notes/Plan.md', '# Plan\n- start\n')
put(
  'Custard/Skills/daily-log/SKILL.md',
  '---\nname: daily-log\ndescription: Adds a line to the plan.\n---\nAdd one line to Notes/Plan.md.\n'
)

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
}, V)
let w = null
for (let i = 0; !w && i < 300; i++) {
  w = app.windows().find((x) => x.url().endsWith('/renderer/index.html')) ?? null
  if (!w) await new Promise((r) => setTimeout(r, 100))
}
await w.setViewportSize({ width: 1280, height: 1000 })
w.on('pageerror', (e) => console.log('pageerror:', e.message))
await w.waitForSelector('text=Custard')
const card = () => w.locator('[role=alertdialog]')
const closeSettings = () => w.click('button:text-is("Done")')

try {
  step('Setup: key, vault, one allowed folder')
  await w.click('button[title=Settings]')
  await w.fill('input[aria-label="Claude API key"]', 'sk-ant-test')
  await w.press('input[aria-label="Claude API key"]', 'Enter')
  await w.click('button:text-is("Use an existing vault")')
  await w.waitForSelector('text=· connected')
  await w.waitForSelector('text=Automations')
  check(
    (await w.locator('ul[aria-label="Automations"]').count()) === 0,
    'there are no automations by default'
  )
  await w.click('button:text-is("New automation")')
  await w.fill('input[aria-label="Automation name"]', 'vgauto log')
  await w.click('button:text-is("Save automation")')
  await w.waitForSelector('text=Give at least one time of day')
  check(true, 'a missing time is refused with a reason')
  await w.click('button:text-is("Cancel")')

  await w.fill('input[aria-label="Folder to allow"]', 'Notes')
  await w.selectOption('select[aria-label="What Claude may do there"]', 'append')
  await w.click('button:text-is("Allow")')
  await w.waitForSelector('ul[aria-label="Editable folders"] >> text=Notes/')

  step('Create an automation')
  await w.click('button:text-is("New automation")')
  await w.fill('input[aria-label="Automation name"]', 'vgauto log')
  await w.selectOption('select[aria-label="Skill to run"]', 'daily-log')
  await w.fill('input[aria-label="Times of day"]', '07:30, 19:00')
  await w.fill('input[aria-label="Runs per day"]', '8')
  await w.check('input[aria-label="Folder Notes"]')
  await w.screenshot({ path: SHOTS + '/automation-form.png' })
  await w.click('button:text-is("Save automation")')
  await w.waitForSelector('ul[aria-label="Automations"] >> text=vgauto log')
  check(
    await w.locator('ul[aria-label="Automations"] >> text=07:30, 19:00').isVisible(),
    'the automation is listed with its schedule'
  )
  check(
    await w.locator('ul[aria-label="Automations"] >> text=/Off/').first().isVisible(),
    'it starts turned off'
  )

  step('Run now: edits only where allowed, no card')
  await w.click('button[aria-label="Run vgauto log now"]')
  await w.waitForSelector('ul[aria-label="Runs of vgauto log"]', {
    state: 'attached',
    timeout: 30000
  })
  await w.locator('summary:has-text("Runs (")').waitFor({ timeout: 30000 })
  await w.waitForFunction(
    () =>
      /Done/.test(document.querySelector('[aria-label="Runs of vgauto log"]')?.textContent ?? ''),
    null,
    { timeout: 30000 }
  )
  check((await card().count()) === 0, 'no approval card appeared')
  check(
    file('Notes/Plan.md') === '# Plan\n- start\nAUTO-LINE-6102\n',
    'the note in its folder got the line'
  )
  check(!fs.existsSync(`${V}/Inbox/Nope.md`), 'a note outside its folder was not created')
  await w.locator('summary:has-text("Runs (")').click()
  const runs = await w.locator('ul[aria-label="Runs of vgauto log"]').textContent()
  check(/started by you/.test(runs ?? ''), 'the run is recorded as started by you')
  check(/Notes\/Plan\.md \(append\)/.test(runs ?? ''), 'the record names the note it changed')
  check(/Logged one line/.test(runs ?? ''), 'the record keeps the end of its message')
  check(/\(not-run\)/.test(runs ?? ''), 'the refused call shows as not run')
  await w.screenshot({ path: SHOTS + '/automation-run.png' })
  check(
    (await w.locator('ul[aria-label="Recent changes"] >> text=(automation)').count()) > 0,
    'the change is in Recent changes, marked as an automation'
  )

  step('Undo works for what an automation did')
  await w.click('button[aria-label="Undo change to Notes/Plan.md"]')
  await w.waitForSelector('text=Restored Notes/Plan.md')
  check(file('Notes/Plan.md') === '# Plan\n- start\n', 'undo restored the note')

  step('Editing and turning on')
  await w.click('button[aria-label="Turn on vgauto log"]')
  await w.waitForSelector('button[aria-label="Turn off vgauto log"]')
  check(true, 'turned on')
  await w.click('button[aria-label="Edit vgauto log"]')
  await w.uncheck('input[aria-label="Folder Notes"]')
  await w.click('button:text-is("Save automation")')
  await w.waitForSelector('button[aria-label="Run vgauto log now"]')
  await w.click('button[aria-label="Run vgauto log now"]')
  await w.waitForFunction(
    () => document.querySelectorAll('[aria-label="Runs of vgauto log"] li').length >= 2,
    null,
    { timeout: 30000 }
  )
  await new Promise((r) => setTimeout(r, 1500))
  check(
    file('Notes/Plan.md') === '# Plan\n- start\n',
    'with the folder taken away, the next run could not change the note'
  )

  step('A schedule fires by itself, once')
  const soon = new Date(Date.now() + 60_000)
  const hhmm = `${String(soon.getHours()).padStart(2, '0')}:${String(soon.getMinutes()).padStart(2, '0')}`
  await w.click('button:text-is("New automation")')
  await w.fill('input[aria-label="Automation name"]', 'vgauto sched')
  await w.selectOption('select[aria-label="Skill to run"]', 'daily-log')
  await w.fill('input[aria-label="Times of day"]', hhmm)
  await w.check('input[aria-label="Folder Notes"]')
  await w.click('button:text-is("Save automation")')
  await w.waitForSelector('button[aria-label="Turn on vgauto sched"]')
  await w.click('button[aria-label="Turn on vgauto sched"]')
  await w.waitForSelector('button[aria-label="Turn off vgauto sched"]')
  await w.waitForFunction(
    () =>
      /Done/.test(document.querySelector('[aria-label="Runs of vgauto sched"]')?.textContent ?? ''),
    null,
    { timeout: 120000 }
  )
  await new Promise((r) => setTimeout(r, 25000))
  check(
    (await w.locator('ul[aria-label="Runs of vgauto sched"] > li').count()) === 1,
    'it ran at its time, and only once'
  )
  check(file('Notes/Plan.md') === '# Plan\n- start\nAUTO-LINE-6102\n', 'and changed the note')
  await w.click('button[aria-label="Delete vgauto sched"]')
  await w.click('button[aria-label="Delete vgauto sched"]')
  await w.waitForSelector('button[aria-label="Delete vgauto sched"]', { state: 'detached' })

  step('Delete')
  await w.click('button[aria-label="Delete vgauto log"]')
  check(
    await w.locator('text=Delete it and its records?').isVisible(),
    'delete asks for a second click'
  )
  await w.click('button[aria-label="Delete vgauto log"]')
  await w.waitForSelector('ul[aria-label="Automations"]', { state: 'detached' })
  check(true, 'the automation and its records are gone')
  await closeSettings()
} finally {
  await app.close()
  console.log('e2e done, exit', process.exitCode ?? 0)
}
