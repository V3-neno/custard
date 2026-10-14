// Chat usage and the monthly budget in the built app, against
// test/e2e/interrupt-mock.mjs:
//   - the meter beside the model pills shows the context share and the cost
//   - the chat and the month keep their totals
//   - a budget in Settings warns from 80% and when passed, and never blocks
// Usage, from the repo root after `npx electron-vite build`:
//   node test/e2e/interrupt-mock.mjs <out> &   (with <out>/plugin a copy of plugin/
//                                               and <out>/vault a copy of vault-template/)
//   node test/e2e/usage.mjs <out> <screenshot dir>
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
const CFG = OUT + '/cfg-usage'
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
const until = async (f, ms = 15000) => {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (await f()) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}
const ledger = () => {
  try {
    return JSON.parse(fs.readFileSync(`${CFG}/custard/usage.json`, 'utf8'))
  } catch {
    return null
  }
}
const chatFile = (start) => {
  const dir = `${CFG}/custard/conversations`
  return fs
    .readdirSync(dir)
    .map((f) => JSON.parse(fs.readFileSync(`${dir}/${f}`, 'utf8')))
    .find((c) => c.title.startsWith(start))
}
const meter = 'div[data-usage-meter]'

try {
  step('Setup: key and vault')
  await w.click('button[title=Settings]')
  await w.fill('input[aria-label="Claude API key"]', 'sk-ant-test')
  await w.press('input[aria-label="Claude API key"]', 'Enter')
  await w.click('button:has-text("Use an existing vault")')
  await w.waitForSelector('text=· connected')
  check(
    (await w.locator('section:has-text("Spending")').innerText()).includes('about $0.00 across 0'),
    'Settings shows no spending yet'
  )
  await w.click('button:text-is("Done")')
  check((await w.locator(meter).count()) === 0, 'a new chat shows no meter')

  step('A chat shows how full its context is and what it cost')
  await send('usage test: hello')
  await w.waitForSelector(meter)
  const pct = await w.getAttribute('[role=meter][aria-label="Context used"]', 'aria-valuenow')
  check(
    pct !== null && Number(pct) >= 0 && Number(pct) <= 100,
    `the context gauge shows a share (${pct}%)`
  )
  check(
    (await w.locator('[data-chat-cost]').innerText()) === '<$0.01',
    'a small chat costs less than a cent'
  )
  const c = chatFile('usage test')
  check(
    c?.usage?.calls >= 1 && c.usage.input >= 10 && c.usage.output >= 30,
    `the chat keeps its token use (${JSON.stringify(c?.usage)})`
  )
  const title = await w.getAttribute(meter, 'title')
  check(
    /Context: \d+% used/.test(title) && /This chat so far: <\$0\.01 estimated/.test(title),
    'the tooltip explains both'
  )
  const month = Object.values(ledger()?.months ?? {})[0]
  check(month?.calls >= 1, 'the month is counted in app data')

  step('A monthly budget warns from 80% and when passed')
  await w.click('button[title=Settings]')
  await w.fill('input[aria-label="Monthly budget in dollars"]', 'abc')
  await w.click('section:has-text("Spending") button:text-is("Save")')
  check(await w.isVisible('text=Enter an amount in dollars'), 'a wrong amount is refused')
  await w.fill('input[aria-label="Monthly budget in dollars"]', '10')
  await w.click('section:has-text("Spending") button:text-is("Save")')
  await w.waitForSelector('section:has-text("of your $10.00 budget")')
  check(true, 'the budget is saved and shown')
  await w.click('button:text-is("Done")')
  check((await w.locator('[data-budget-line]').count()) === 0, 'no budget line below 80%')
  await send('big usage test: please')
  await w.waitForSelector('[data-budget-line]')
  check(
    (await w.locator('[data-budget-line]').innerText()).includes('of your $10.00 budget'),
    'past 80%, a line under the message box says so'
  )
  await w.screenshot({ path: SHOTS + '/usage-01-budget.png' })
  await send('big usage test: again')
  await until(async () =>
    (await w.locator('[data-budget-line]').innerText()).includes('over your $10.00 budget')
  )
  check(
    (await w.locator('[data-budget-line]').innerText()).includes('Custard keeps working'),
    'over the budget it says so, and the chat still works'
  )
  check(
    (await w.locator('[data-chat-cost]').innerText()).startsWith('$16'),
    `the chat's cost adds up (${await w.locator('[data-chat-cost]').innerText()})`
  )
  await w.click('button[title=Settings]')
  await w.fill('input[aria-label="Monthly budget in dollars"]', '')
  await w.click('section:has-text("Spending") button:text-is("Save")')
  await w.click('button:text-is("Done")')
  await send('usage test: after')
  check((await w.locator('[data-budget-line]').count()) === 0, 'with no budget there is no line')
} catch (e) {
  console.log('error:', e)
  process.exitCode = 1
  await w.screenshot({ path: SHOTS + '/usage-fail.png' }).catch(() => {})
} finally {
  await app.close()
  console.log('\ne2e done, exit', process.exitCode ?? 0)
}
