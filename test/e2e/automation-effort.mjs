// Effort in Settings → Automations (automation thinking, Phase 3): the
// effort buttons under the model, what a new, an old, a hand-set, an
// unlisted and a profile-less automation show and save, and the model and
// effort each run used in the run list. Against test/e2e/interrupt-mock.mjs
// (one Run now; no request reaches a provider). Usage as for automations.mjs:
//   node test/e2e/automation-effort.mjs <out> <screenshot dir>
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
const CFG = OUT + '/cfg-auto-effort'
const DATA = `${CFG}/custard`
const V = OUT + '/vault'
const put = (p, text) => {
  fs.mkdirSync(`${V}/${p.split('/').slice(0, -1).join('/')}`, { recursive: true })
  fs.writeFileSync(`${V}/${p}`, text)
}
put('Notes/Plan.md', '# Plan\n- start\n')
put(
  'Custard/Skills/daily-log/SKILL.md',
  '---\nname: daily-log\ndescription: Adds a line to the plan.\n---\nAdd one line to Notes/Plan.md.\n'
)
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
}, V)
let w = null
for (let i = 0; !w && i < 300; i++) {
  w = app.windows().find((x) => x.url().endsWith('/renderer/index.html')) ?? null
  if (!w) await new Promise((r) => setTimeout(r, 100))
}
await w.setViewportSize({ width: 1280, height: 1000 })
const pageErrors = []
w.on('pageerror', (e) => {
  pageErrors.push(e.message)
  console.log('pageerror:', e.message)
})
await w.waitForSelector('text=Custard')

const MODEL = 'select[aria-label="Model for the automation"]'
const box = '[data-automation-effort]'
const kind = () => w.locator(box).getAttribute('data-automation-effort')
const levels = () =>
  w.locator(`${box} button`).evaluateAll((bs) => bs.map((b) => b.textContent.trim()))
const pressed = () =>
  w
    .locator(`${box} button[aria-checked="true"]`)
    .evaluateAll((bs) => bs.map((b) => b.textContent.trim()))
const allDisabled = () =>
  w.locator(`${box} button`).evaluateAll((bs) => bs.length > 0 && bs.every((b) => b.disabled))
const legend = () => w.locator(`${box} legend`).innerText()
const note = async () =>
  (await w.locator('[data-effort-note]').count())
    ? (await w.locator('[data-effort-note]').innerText()).trim()
    : null
const cost = async () =>
  (await w.locator('[data-effort-cost]').count())
    ? (await w.locator('[data-effort-cost]').innerText()).trim()
    : null
const saved = () => JSON.parse(fs.readFileSync(`${DATA}/settings.json`, 'utf8')).automations ?? []
const byName = (n) => saved().find((a) => a.name === n)
const level = (label) => w.click(`${box} button:text-is("${label}")`)
const formShot = (name) =>
  w
    .locator('div.space-y-2:has(input[aria-label="Automation name"])')
    .screenshot({ path: `${SHOTS}/${name}.png` })
const saveForm = async (name) => {
  await w.click('button:text-is("Save automation")')
  await w.waitForSelector(`button[aria-label="Edit ${name}"]`)
  await w.waitForSelector('button:text-is("New automation")')
}
// Saved through the app's own API, as an automation saved before there was
// a choice (or by hand in settings.json) would be.
const seed = (a) =>
  w.evaluate(
    (a) =>
      window.custard.automations.save({
        skill: 'daily-log',
        times: ['07:30'],
        days: [],
        folders: [],
        plugins: [],
        enabled: false,
        limits: { runsPerDay: 24, toolCalls: 30, catchUpRuns: 3 },
        ...a
      }),
    a
  )

try {
  step('Setup: a vault and keys for Claude, OpenAI and DeepSeek')
  await w.click('button[title=Settings]')
  await w.click('button:text-is("Use an existing vault")')
  await w.waitForSelector('text=· connected')
  await w.evaluate(async () => {
    await window.custard.apiKey.set('claude', 'sk-ant-EFF-0000000000')
    await window.custard.apiKey.set('openai', 'sk-EFF-openai-1111111111')
    await window.custard.apiKey.set('deepseek', 'sk-EFF-deepseek-2222222222')
  })
  await w.click('button:text-is("Done")')
  await w.click('button[title=Settings]')
  await w.waitForSelector('button:text-is("New automation")')

  step('A new automation on Opus 5.5: Medium picked and saved')
  await w.click('button:text-is("New automation")')
  check((await w.inputValue(MODEL)) === 'claude-opus-5-5', 'the form starts on Opus 5.5')
  check((await kind()) === 'levels', 'the effort control shows levels')
  check((await legend()) === 'Effort for Opus 5.5', 'labelled as the picker labels it')
  check(
    JSON.stringify(await levels()) === JSON.stringify(['Low', 'Medium', 'High', 'X-High', 'Max']),
    'with the picker’s labels Low to Max'
  )
  check(JSON.stringify(await pressed()) === '["Medium"]', 'Medium is picked')
  check(
    (await cost()) === 'Levels above Medium cost more.',
    'one line says higher levels cost more'
  )
  check((await note()) === null, 'no note on a new automation')
  await formShot('effort-01-new-opus')
  await w.fill('input[aria-label="Automation name"]', 'vgauto effort')
  await w.selectOption('select[aria-label="Skill to run"]', 'daily-log')
  await w.fill('input[aria-label="Times of day"]', '07:30')
  await saveForm('vgauto effort')
  check(byName('vgauto effort')?.effort === 'medium', 'it is saved with effort medium')

  step('Picking a level, then changing the model')
  await w.click('button:text-is("New automation")')
  await level('X-High')
  check(JSON.stringify(await pressed()) === '["X-High"]', 'a level can be picked')
  await w.selectOption(MODEL, 'gpt-6-astra')
  check(JSON.stringify(await pressed()) === '["X-High"]', 'on GPT-6 Astra it stays X-High')
  await w.selectOption(MODEL, 'deepseek-flash')
  check(
    JSON.stringify(await levels()) === JSON.stringify(['Fast', 'Balanced', 'Thorough']),
    'DeepSeek shows Fast, Balanced, Thorough'
  )
  check(
    JSON.stringify(await pressed()) === '["Balanced"]',
    'X-High re-maps to Balanced on DeepSeek Flash'
  )
  check(
    (await cost()) === 'Levels above Balanced cost more.',
    'the cost line names DeepSeek’s middle level'
  )
  await formShot('effort-02-deepseek')
  await w.selectOption(MODEL, 'claude-haiku-4-5')
  check((await kind()) === 'none', 'Haiku 4.5: no levels to pick')
  check((await legend()) === 'Haiku 4.5 takes no effort level', 'it says Haiku 4.5 takes none')
  check(await allDisabled(), 'the buttons are greyed out')
  check((await cost()) === null, 'and the cost line is gone')
  await formShot('effort-03-haiku')
  await w.selectOption(MODEL, 'claude-opus-5-5')
  check(JSON.stringify(await pressed()) === '["Medium"]', 'back on Opus 5.5 it starts at Medium')
  await w.selectOption(MODEL, 'claude-haiku-4-5')
  await w.fill('input[aria-label="Automation name"]', 'vgauto haiku')
  await w.fill('input[aria-label="Times of day"]', '08:00')
  await saveForm('vgauto haiku')
  const haiku = byName('vgauto haiku')
  check(haiku && !('effort' in haiku), 'a Haiku 4.5 automation is saved with no effort')

  step('A DeepSeek automation saves DeepSeek’s level')
  await w.click('button:text-is("New automation")')
  await w.selectOption(MODEL, 'deepseek-flash')
  check(JSON.stringify(await pressed()) === '["Balanced"]', 'a new one starts at Balanced')
  await level('Thorough')
  await w.fill('input[aria-label="Automation name"]', 'vgauto ds')
  await w.fill('input[aria-label="Times of day"]', '09:00')
  await saveForm('vgauto ds')
  check(byName('vgauto ds')?.effort === 'max', 'Thorough is saved as max')

  step('An old automation (no effort) shows Not set and gets a level on save')
  const old = await seed({ name: 'vgauto old', model: 'claude-opus-5-5' })
  check(old.ok, 'an automation with no effort is saved')
  await w.waitForSelector('button[aria-label="Edit vgauto old"]')
  await w.click('button[aria-label="Edit vgauto old"]')
  check(
    (await note()) === "Not set (the provider's default). Saving sets Medium.",
    'it says Not set, and what saving sets'
  )
  check(JSON.stringify(await pressed()) === '["Medium"]', 'Medium is shown picked')
  await formShot('effort-04-old')
  await level('High')
  check(
    (await note()) === "Not set (the provider's default). Saving sets High.",
    'the note follows the picked level'
  )
  await level('Medium')
  await saveForm('vgauto old')
  check(byName('vgauto old')?.effort === 'medium', 'saved, it now has effort medium')

  step('A hand-set effort shows as it is and survives a save')
  check(
    (await seed({ name: 'vgauto hand', model: 'claude-opus-5-5', effort: 'xhigh' })).ok,
    'an automation with effort xhigh is saved'
  )
  await w.waitForSelector('button[aria-label="Edit vgauto hand"]')
  await w.click('button[aria-label="Edit vgauto hand"]')
  check(JSON.stringify(await pressed()) === '["X-High"]', 'X-High is shown picked')
  check((await note()) === null, 'with no note')
  await saveForm('vgauto hand')
  check(byName('vgauto hand')?.effort === 'xhigh', 'it is still xhigh after a save')

  step('A stored level the profile does not list')
  check(
    (await seed({ name: 'vgauto unlisted', model: 'deepseek-flash', effort: 'medium' })).ok,
    'a DeepSeek automation with effort medium is saved'
  )
  await w.waitForSelector('button[aria-label="Edit vgauto unlisted"]')
  await w.click('button[aria-label="Edit vgauto unlisted"]')
  check(JSON.stringify(await pressed()) === '["Balanced"]', 'it shows Balanced, what is sent')
  check(
    (await note()) === "Saved as Medium, which DeepSeek Flash doesn't list, so it sends Balanced.",
    'and says so'
  )
  await formShot('effort-05-unlisted')
  await saveForm('vgauto unlisted')
  check(byName('vgauto unlisted')?.effort === 'high', 'saving keeps what was shown (high)')

  step('A model whose profile is gone')
  check(
    (await seed({ name: 'vgauto gone', model: 'claude-gone-1', effort: 'high' })).ok,
    'an automation on a model with no profile is saved'
  )
  await w.waitForSelector('button[aria-label="Edit vgauto gone"]')
  const errorsBefore = pageErrors.length
  await w.click('button[aria-label="Edit vgauto gone"]')
  check((await kind()) === 'no-profile', 'the form opens and says the profile is missing')
  check(
    (await legend()) ===
      "claude-gone-1 has no profile, so its effort levels can't be shown. The saved effort (High) is kept.",
    'it keeps the saved effort'
  )
  check((await w.inputValue(MODEL)) === 'claude-gone-1', 'the model select shows the saved model')
  await formShot('effort-06-no-profile')
  await saveForm('vgauto gone')
  check(
    byName('vgauto gone')?.effort === 'high' && byName('vgauto gone')?.model === 'claude-gone-1',
    'saved, it keeps its model and effort'
  )
  check(pageErrors.length === errorsBefore, 'no page error')

  step('The run list shows the model and effort of each run')
  await w.click('button[aria-label="Run vgauto effort now"]')
  await w.waitForFunction(
    () =>
      /Done|Failed|Stopped/.test(
        document.querySelector('[aria-label="Runs of vgauto effort"]')?.textContent ?? ''
      ),
    null,
    { timeout: 30000 }
  )
  await w.locator('li:has(button[aria-label="Edit vgauto effort"]) summary').click()
  const run = w.locator('ul[aria-label="Runs of vgauto effort"] > li').first()
  check(
    (await run.locator('[data-run-model]').innerText()) === 'Opus 5.5 · Medium',
    'a run of the new automation shows Opus 5.5 · Medium'
  )
  await w.screenshot({ path: `${SHOTS}/effort-07-run.png` })

  // Records as the scheduler writes them, older ones without model and effort.
  const id = byName('vgauto old').id
  const at = Date.now() - 3_600_000
  const rec = (n, extra) => ({
    id: `r${n}`,
    automationId: id,
    kind: 'scheduled',
    slot: '2026-10-14T07:30',
    startedAt: at - n * 60_000,
    endedAt: at - n * 60_000 + 5_000,
    status: 'completed',
    calls: [],
    changes: [],
    summary: `RUN-${n}`,
    ...extra
  })
  fs.mkdirSync(`${DATA}/automation-runs`, { recursive: true })
  fs.writeFileSync(
    `${DATA}/automation-runs/${id}.json`,
    JSON.stringify({
      state: { failures: 0, checkedUntil: Date.now() },
      runs: [
        rec(1, { model: 'claude-opus-5-5', effort: 'high' }),
        rec(2, { model: 'claude-opus-5-5' }),
        rec(3, { model: 'claude-haiku-4-5' }),
        rec(4, { model: 'deepseek-flash', effort: 'medium' }),
        rec(5, {})
      ]
    })
  )
  await w.click('button:text-is("Done")')
  await w.click('button[title=Settings]')
  await w.waitForSelector('button[aria-label="Edit vgauto old"]')
  await w.locator('li:has(button[aria-label="Edit vgauto old"]) summary').click()
  const lines = await w
    .locator('ul[aria-label="Runs of vgauto old"] > li')
    .evaluateAll((ls) =>
      ls.map((l) => [
        l.textContent.match(/RUN-\d/)?.[0],
        l.querySelector('[data-run-model]')?.textContent ?? null
      ])
    )
  const lineFor = (n) => lines.find((l) => l[0] === `RUN-${n}`)?.[1]
  check(lineFor(1) === 'Opus 5.5 · High', 'a record with model and effort: Opus 5.5 · High')
  check(
    lineFor(2) === 'Opus 5.5 · effort not set',
    'a record with a model and no effort: effort not set'
  )
  check(lineFor(3) === 'Haiku 4.5', 'a Haiku 4.5 record: just the model')
  check(lineFor(4) === 'DeepSeek Flash · Balanced', 'a DeepSeek record shows its label')
  check(lineFor(5) === null, 'an older record without them shows no model line')
  check(lines.length === 5, 'all five records are listed')
  await w
    .locator('li:has(button[aria-label="Edit vgauto old"])')
    .screenshot({ path: `${SHOTS}/effort-08-run-list.png` })
  await w.click('button:text-is("Done")')
  check(pageErrors.length === 0, 'no page errors in the whole run')
} finally {
  await app.close()
  console.log('e2e done, exit', process.exitCode ?? 0)
}
