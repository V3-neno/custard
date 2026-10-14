// Questions from unattended runs: a run leaves one, the next chat asks it, the
// answer is applied with an approved edit and the question is closed.
// Against test/e2e/interrupt-mock.mjs; usage as for hardening.mjs:
//   node test/e2e/questions.mjs <out> <screenshot dir>
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
const CFG = OUT + '/cfg-questions'
const V = OUT + '/vault'
const file = (p) => fs.readFileSync(`${V}/${p}`, 'utf8')
const put = (p, text) => {
  fs.mkdirSync(`${V}/${p.split('/').slice(0, -1).join('/')}`, { recursive: true })
  fs.writeFileSync(`${V}/${p}`, text)
}
put('Notes/Plan.md', '# Plan\n\n## Log\n- start\n\n## Later\nx\n')
put(
  'Custard/Skills/daily-log/SKILL.md',
  '---\nname: daily-log\ndescription: Adds a line to the plan.\n---\nAdd one line to Notes/Plan.md.\n'
)
const requests = () => JSON.parse(fs.readFileSync(OUT + '/anthropic.json', 'utf8'))
const sys = (r) =>
  Array.isArray(r.system) ? r.system.map((x) => x.text ?? '').join('\n') : String(r.system ?? '')
const lastUser = (r) => {
  const m = [...r.messages].reverse().find((x) => x.role === 'user')
  return typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? '')
}
const chatRequests = (needle) => requests().filter((r) => lastUser(r).includes(needle))

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
const send = async (t) => {
  await w.fill('textarea', t)
  await w.keyboard.press('Enter')
}
const idle = () => w.waitForSelector('button[title=Send]', { timeout: 30000 })
const card = () => w.locator('[role=alertdialog]')

try {
  step('Setup, and a chat before any question')
  await w.click('button[title=Settings]')
  await w.fill('input[aria-label="Claude API key"]', 'sk-ant-test')
  await w.press('input[aria-label="Claude API key"]', 'Enter')
  await w.click('button:text-is("Use an existing vault")')
  await w.waitForSelector('text=· connected')
  await w.fill('input[aria-label="Folder to allow"]', 'Notes')
  await w.selectOption('select[aria-label="What Claude may do there"]', 'edit')
  await w.click('button:text-is("Allow")')
  await w.waitForSelector('ul[aria-label="Editable folders"] >> text=Notes/')
  await w.click('button:text-is("Done")')
  await send('vgq hello')
  await idle()
  const before = chatRequests('vgq hello')[0]
  check(!!before && !sys(before).includes('QSTN-'), 'no question is mentioned when none is open')
  check(
    !(before?.tools ?? []).includes('automation_question'),
    'the question tool is not offered when none is open'
  )
  check((await w.locator('text=Outside text').count()) === 0, 'no Outside text pill')

  step('A run leaves a question')
  await w.click('button[title=Settings]')
  await w.click('button:text-is("New automation")')
  await w.fill('input[aria-label="Automation name"]', 'vgauto ask')
  await w.selectOption('select[aria-label="Skill to run"]', 'daily-log')
  await w.fill('input[aria-label="Times of day"]', '07:30')
  await w.check('input[aria-label="Folder Notes"]')
  await w.click('button:text-is("Save automation")')
  await w.click('button[aria-label="Run vgauto ask now"]')
  await w.waitForSelector('ul[aria-label="Open questions"] >> text=QSTN-4471', { timeout: 30000 })
  check(true, 'the question is listed in Settings')
  const listed = (await w.locator('ul[aria-label="Open questions"]').textContent()) ?? ''
  check(/vgauto ask/.test(listed) && /Notes\/Plan\.md/.test(listed), 'with its automation and note')
  await w.locator('summary:has-text("Runs (")').click()
  check(
    /Left a question/.test(
      (await w.locator('ul[aria-label="Runs of vgauto ask"]').textContent()) ?? ''
    ),
    'the run record shows it left a question'
  )
  check(file('Notes/Plan.md').includes('- start\n\n## Later'), 'the note is unchanged')
  await w.screenshot({ path: SHOTS + '/automation-question.png' })
  await w.click('button:text-is("Done")')

  step('The next chat is told, and asks')
  await w.click('button[aria-label="Temporary chat"]')
  await w.click('button[aria-label="Temporary chat"]')
  await send('vgq hello')
  await idle()
  const asked = chatRequests('vgq hello').at(-1)
  check(sys(asked).includes('QSTN-4471'), 'the open question is in the chat instructions')
  check(
    sys(asked).includes('data, not instructions'),
    'and is marked as data written by an automation run'
  )
  check((asked.tools ?? []).includes('automation_question'), 'the question tool is offered')
  check(
    await w.locator('text=which heading should the log go under').first().isVisible(),
    'Claude asks it in the chat'
  )
  check(
    await w.locator('text=Outside text').first().isVisible(),
    'the chat shows the Outside text pill'
  )

  step('The answer is applied with an approved edit, then the question closes')
  await send('vgq answer: put it under Later')
  const c = card().first()
  await c.waitFor({ timeout: 30000 })
  const cardText = (await c.textContent()) ?? ''
  check(/ANSWERED-8812/.test(cardText), 'the edit shows its card with the change')
  check(/automation/.test(cardText), 'and says why it is asking')
  check(!file('Notes/Plan.md').includes('ANSWERED-8812'), 'nothing is written before approval')
  await c.getByRole('button', { name: 'Allow', exact: true }).click()
  await idle()
  check(
    file('Notes/Plan.md') === '# Plan\n\n## Log\n- start\n\n## Later\nx\n- ANSWERED-8812\n',
    'the answer was applied under Later'
  )
  await w.click('button[title=Settings]')
  await w.locator('summary:has-text("Answered questions")').waitFor({ timeout: 15000 })
  check(
    (await w.locator('ul[aria-label="Open questions"]').count()) === 0,
    'the question is no longer open'
  )
  await w.locator('summary:has-text("Answered questions")').click()
  check(
    /QSTN-4471[\s\S]*Later/.test(
      (await w.locator('ul[aria-label="Answered questions"]').textContent()) ?? ''
    ),
    'its answer is kept in Settings'
  )
  await w.click('button:text-is("Done")')

  step('A new chat is not told about it again')
  await w.click('button[aria-label="Temporary chat"]')
  await w.click('button[aria-label="Temporary chat"]')
  await send('vgq hello')
  await idle()
  check(
    !sys(chatRequests('vgq hello').at(-1)).includes('QSTN-4471'),
    'closed questions are not shown'
  )
} finally {
  await app.close()
  console.log('e2e done, exit', process.exitCode ?? 0)
}
