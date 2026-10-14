// Catch-up: Custard closed over several scheduled times, then opened again.
// Against test/e2e/interrupt-mock.mjs; usage as for hardening.mjs:
//   node test/e2e/catchup.mjs <out> <screenshot dir>
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
const CFG = OUT + '/cfg-catchup'
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

const launch = async () => {
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
  return { app, w }
}

// Six slots in the last three hours of today (the test needs the day to have
// that much of it behind it), each well past the 10-minute grace.
const now = new Date()
const mins = now.getHours() * 60 + now.getMinutes()
if (mins < 200) {
  console.log('✓ skipped: too close to midnight for this test (needs 3 hours of today behind it)')
  process.exit(0)
}
const slot = (back) => {
  const m = mins - back
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}
const times = [180, 150, 120, 90, 60, 30].map(slot)

// One launch. "Closed over several times" is staged by moving the automation's
// last look back in its saved state while the app is idle; the tick that finds
// the missed slots is the same one that runs when Custard opens (the unit tests
// cover the opening itself). A second launch can't be used here: the test
// harness enables plain-text key storage only after startup, and the first
// look happens at startup, before the saved test key can be read.
const { app, w } = await launch()
try {
  step('Create and turn on an automation')
  await w.click('button[title=Settings]')
  await w.fill('input[aria-label="Claude API key"]', 'sk-ant-test')
  await w.press('input[aria-label="Claude API key"]', 'Enter')
  await w.click('button:text-is("Use an existing vault")')
  await w.waitForSelector('text=· connected')
  await w.fill('input[aria-label="Folder to allow"]', 'Notes')
  await w.click(`[role=radiogroup][aria-label="What Claude may do there"] [data-value="append"]`)
  await w.click('button:text-is("Allow")')
  await w.waitForSelector('ul[aria-label="Editable folders"] >> text=Notes/')
  await w.click('button:text-is("New automation")')
  await w.fill('input[aria-label="Automation name"]', 'vgauto catch')
  await w.selectOption('select[aria-label="Skill to run"]', 'daily-log')
  await w.fill('input[aria-label="Times of day"]', times.join(', '))
  await w.check('input[aria-label="Folder Notes"]')
  await w.click('button:text-is("Save automation")')
  await w.click('button[aria-label="Turn on vgauto catch"]')
  await w.waitForSelector('button[aria-label="Turn off vgauto catch"]')
  check(true, 'created with six times in the past three hours')

  // Custard was "closed" since three and a half hours ago.
  const settings = JSON.parse(fs.readFileSync(`${CFG}/custard/settings.json`, 'utf8'))
  const id = settings.automations[0].id
  const runsFile = `${CFG}/custard/automation-runs/${id}.json`
  const f = JSON.parse(fs.readFileSync(runsFile, 'utf8'))
  f.state.checkedUntil = Date.now() - 215 * 60_000
  fs.writeFileSync(runsFile, JSON.stringify(f))

  step('The newest three are caught up, oldest first')
  await w.waitForFunction(
    () =>
      (document.querySelector('[aria-label="Runs of vgauto catch"]')?.querySelectorAll('li')
        .length ?? 0) >= 4,
    null,
    { timeout: 60000 }
  )
  await w.waitForFunction(
    () =>
      !/Running/.test(document.querySelector('ul[aria-label="Automations"]')?.textContent ?? ''),
    null,
    { timeout: 60000 }
  )
  await w.locator('summary:has-text("Runs (")').click()
  const text = (await w.locator('ul[aria-label="Runs of vgauto catch"]').textContent()) ?? ''
  check((text.match(/catch-up for/g) ?? []).length === 3, 'three catch-up runs happened')
  check(
    [times[3], times[4], times[5]].every((t) => text.includes(t)),
    'they are for the three newest missed times'
  )
  check(
    new RegExp('older scheduled runs were missed and not run').test(text),
    'the three older ones are noted as folded, not dropped'
  )
  check(
    file('Notes/Plan.md').split('AUTO-LINE-6102').length === 4,
    'each catch-up run did its work (three lines added)'
  )
  await w.screenshot({ path: SHOTS + '/automation-catchup.png' })
  // Nothing is repeated on the next look.
  await new Promise((r) => setTimeout(r, 25000))
  const again = (await w.locator('ul[aria-label="Runs of vgauto catch"] > li').count()) ?? 0
  check(again === 4, 'nothing ran twice (three runs and one note)')
} finally {
  await app.close()
  console.log('e2e done, exit', process.exitCode ?? 0)
}
