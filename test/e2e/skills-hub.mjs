// The Skills hub in the built app, against test/e2e/interrupt-mock.mjs:
//   - with no vault it says to connect one
//   - Skills mode opens on every skill in Custard/Skills, with what it does,
//     the modes it is for, starter skills marked, and how many automations
//     run it; a folder chats can't use says why
//   - Find narrows the list
//   - Inspect shows the skill's fields and its SKILL.md, read only
//   - Improve and Add put a request in the message box without sending it
//   - once a chat starts, the hub gives way to the chat
// Usage, from the repo root after `npx electron-vite build`:
//   node test/e2e/interrupt-mock.mjs <out> &   (with <out>/plugin a copy of plugin/
//                                               and <out>/vault a copy of vault-template/)
//   node test/e2e/skills-hub.mjs <out> <screenshot dir>
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
const CFG = OUT + '/cfg-skills-hub'
const VAULT = OUT + '/vault'
const SKILLS = `${VAULT}/Custard/Skills`
fs.rmSync(CFG, { recursive: true, force: true })
// A folder chats can't use: its SKILL.md has no description.
fs.mkdirSync(`${SKILLS}/half-done`, { recursive: true })
fs.writeFileSync(`${SKILLS}/half-done/SKILL.md`, '---\nname: half-done\n---\nNot finished.\n')
const before = (dir = VAULT) =>
  fs
    .readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile())
    .map((e) => `${e.parentPath}/${e.name}:${fs.statSync(`${e.parentPath}/${e.name}`).mtimeMs}`)
    .sort()
    .join('\n')

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
const card = (name) => w.locator(`article[aria-label="Skill ${name}"]`)
const box = () => w.inputValue('textarea')

try {
  step('No vault: the hub says to connect one')
  await w.click('button:text-is("Skills")')
  await w.waitForSelector('text=Your skills live in your vault')
  check(true, 'without a vault the hub asks to connect one')

  step('Setup: key, vault, one automation running weekly-review')
  await w.click('button[title=Settings]')
  await w.fill('input[aria-label="Claude API key"]', 'sk-ant-test')
  await w.press('input[aria-label="Claude API key"]', 'Enter')
  await w.click('button:text-is("Use an existing vault")')
  await w.waitForSelector('text=· connected')
  await w.click('button:text-is("New automation")')
  await w.fill('input[aria-label="Automation name"]', 'Sunday review')
  await w.selectOption('select[aria-label="Skill to run"]', 'weekly-review')
  await w.fill('input[aria-label="Times of day"]', '18:00')
  await w.click('button:text-is("Save automation")')
  await w.waitForSelector('ul[aria-label="Automations"] >> text=Sunday review')
  await w.click('button:text-is("Done")')
  // Back to Skills so the hub loads with the vault.
  await w.click('button:text-is("Chat")')
  await w.click('button:text-is("Skills")')
  const vaultBefore = before()

  step('The hub lists every skill')
  await card('weekly-review').waitFor()
  const names = await w.locator('article[aria-label^="Skill "] h2').allInnerTexts()
  const starters = fs.readdirSync('vault-template/Custard/Skills')
  check(
    starters.every((s) => names.includes(s)) && names.includes('half-done'),
    `every skill folder has a card (${names.length}: ${names.join(', ')})`
  )
  check(
    (await card('weekly-review').innerText()).includes('summary of their week'),
    'a card says what the skill does'
  )
  check((await card('weekly-review').innerText()).includes('Starter'), 'starter skills are marked')
  check(
    (await card('weekly-review').innerText()).includes('1 automation'),
    'a card counts the automations that run the skill'
  )
  check(
    (await card('plugin-development').innerText()).includes('Plugins') &&
      (await card('image-making').innerText()).includes('Design') &&
      (await card('daily-note').innerText()).includes('All modes'),
    'cards name the modes a skill is for ("plugins" and "code" both read Plugins)'
  )
  check(
    (await card('half-done').innerText()).includes("chats don't see this skill"),
    "a skill chats can't use says why"
  )
  await w.screenshot({ path: SHOTS + '/skills-01-hub.png' })

  step('Find narrows the list')
  await w.fill('input[aria-label="Find a skill"]', 'journal')
  check(
    (await w.locator('article[aria-label^="Skill "]').count()) === 1 &&
      (await card('daily-note').count()) === 1,
    'searching "journal" leaves only daily-note (matched on its description)'
  )
  await w.fill('input[aria-label="Find a skill"]', '')

  step('Inspect shows the skill, read only')
  await card('weekly-review').getByRole('button', { name: 'Inspect' }).click()
  const panel = w.locator('[role=dialog][aria-label="About weekly-review"]')
  await panel.waitFor()
  await panel.locator('.markdown').waitFor()
  const panelText = await panel.innerText()
  check(panelText.includes('Custard/Skills/weekly-review/SKILL.md'), 'the panel shows its path')
  check(panelText.includes('Sunday review'), 'the panel names the automation that runs it')
  const bodyLine = fs
    .readFileSync(`${SKILLS}/weekly-review/SKILL.md`, 'utf8')
    .split('\n')
    .find((l) => /^# /.test(l))
    ?.slice(2)
  check(!!bodyLine && panelText.includes(bodyLine), `the panel shows the SKILL.md (${bodyLine})`)
  check(!panelText.includes('description: Use when'), 'frontmatter shows as fields, not raw')
  await w.screenshot({ path: SHOTS + '/skills-02-inspect.png' })

  step('Improve and Add fill the message box, and send nothing')
  const sentBefore = fs.existsSync(OUT + '/anthropic.json')
    ? JSON.parse(fs.readFileSync(OUT + '/anthropic.json', 'utf8')).length
    : 0
  await panel.getByRole('button', { name: 'Improve this skill' }).click()
  check(
    (await box()) === 'Improve the "weekly-review" skill (Custard/Skills/weekly-review/SKILL.md). ',
    'Improve fills in a request naming the skill and its path'
  )
  check((await panel.count()) === 0, 'the panel closes')
  await w.click('button:has-text("Add a skill")')
  check((await box()) === 'Help me make a new skill: ', 'Add fills in a new-skill request')
  const sentAfter = fs.existsSync(OUT + '/anthropic.json')
    ? JSON.parse(fs.readFileSync(OUT + '/anthropic.json', 'utf8')).length
    : 0
  check(sentAfter === sentBefore, 'nothing was sent')
  check(before() === vaultBefore, 'the vault is unchanged')

  step('Once a chat starts, the hub gives way to it')
  await w.fill('textarea', 'hello there')
  await w.keyboard.press('Enter')
  await w.waitForSelector('button[title=Send]', { timeout: 30000 })
  check(
    (await w.locator('article[aria-label^="Skill "]').count()) === 0,
    'the chat replaces the hub'
  )
  await w.click('button[title="Skills history"]')
  await w.click('button:has-text("New skills chat")')
  await card('weekly-review').waitFor()
  check(true, 'a new Skills chat opens on the hub again')
} catch (e) {
  console.log('error:', e)
  process.exitCode = 1
  await w.screenshot({ path: SHOTS + '/skills-fail.png' }).catch(() => {})
} finally {
  await app.close()
  console.log('\ne2e done, exit', process.exitCode ?? 0)
}
