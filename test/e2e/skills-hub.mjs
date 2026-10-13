// The Skills hub in the built app, against test/e2e/interrupt-mock.mjs:
//   - with no vault it says to connect one
//   - Skills mode opens on every skill in Custard/Skills, with what it does,
//     the modes it is for, starter skills marked, and how many automations
//     run it; a folder chats can't use says why
//   - Find narrows the list
//   - Inspect shows the skill's fields and its SKILL.md, read only
//   - pressing a card (or Open its workspace) enters the skill's workspace,
//     with its chats as cards and the path bar back to the hub
//   - Add asks for a name and makes the skill with a draft SKILL.md
//   - a chat in a skill workspace writes only inside that skill's folder
//   - the hub chat changes nothing; its offers to open or create a skill do
//     something only on Yes, and put the request in the box unsent
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
const requests = () =>
  fs.existsSync(OUT + '/anthropic.json')
    ? JSON.parse(fs.readFileSync(OUT + '/anthropic.json', 'utf8')).length
    : 0
const lastReq = () => JSON.parse(fs.readFileSync(OUT + '/anthropic.json', 'utf8')).at(-1)
const path = () => w.locator('nav[aria-label="Where you are"]').innerText()
const crumb = (name) =>
  w.locator('nav[aria-label="Where you are"]').getByRole('button', { name, exact: true })

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

  step('Open its workspace: the chats of one skill, nothing sent')
  const sentBefore = requests()
  await panel.getByRole('button', { name: 'Open its workspace' }).click()
  await w.waitForSelector('text=Workspace · Custard/Skills/weekly-review')
  check((await panel.count()) === 0, 'the panel closes')
  check(
    (await path()).replace(/\s+/g, ' ') === 'All skills › weekly-review',
    'the path bar shows All skills › weekly-review'
  )
  check(
    (await w.getAttribute('textarea', 'placeholder')) === 'Describe a change to weekly-review…',
    'the box is for a change to this skill'
  )
  check(
    (await w.locator('text=No chats in this workspace yet').count()) === 1,
    'a new workspace says it has no chats yet'
  )
  await w.screenshot({ path: SHOTS + '/skills-03-workspace.png' })
  await crumb('All skills').click()
  await card('weekly-review').waitFor()
  await card('weekly-review').getByRole('button', { name: 'Open weekly-review' }).click()
  await w.waitForSelector('text=Workspace · Custard/Skills/weekly-review')
  check(true, 'pressing a card enters its workspace too')
  check(requests() === sentBefore, 'nothing was sent')
  check(before() === vaultBefore, 'the vault is unchanged')
  await crumb('All skills').click()

  step('Add asks for a name, makes the skill and enters it')
  await w.click('button:has-text("Add a skill")')
  await w.fill('input[aria-label="New skill name"]', 'Meeting notes')
  check(
    (await w.innerText('[data-new-skill-folder]')).includes('Custard/Skills/meeting-notes'),
    'it shows the folder it will make'
  )
  await w.click('button:text-is("Create and open")')
  await w.waitForSelector('text=Workspace · Custard/Skills/meeting-notes')
  const made = fs.readFileSync(`${SKILLS}/meeting-notes/SKILL.md`, 'utf8')
  check(
    made.includes('name: "Meeting notes"') && made.includes('modes: skills'),
    'it made a draft SKILL.md, for Skills mode only'
  )
  check(requests() === sentBefore, 'still nothing sent')

  step('A chat in a skill workspace writes only inside that skill')
  await w.fill('textarea', 'skill write test')
  await w.keyboard.press('Enter')
  // Writing a skill asks first, as it always has.
  await w.click('button:text-is("Allow")')
  await w.waitForSelector('button[title=Send]', { timeout: 30000 })
  check(fs.existsSync(`${SKILLS}/meeting-notes/template.md`), 'a note inside its folder is written')
  check(!fs.existsSync(`${VAULT}/outside-skill.md`), 'a note outside it is refused')
  check(
    (lastReq().tools ?? []).includes('vault_create_note') &&
      !(lastReq().tools ?? []).includes('workspace_propose'),
    'it can write notes and offers no workspace'
  )
  check(
    (await path()).replace(/\s+/g, ' ').startsWith('All skills › Meeting notes › skill write test'),
    'the path bar shows the skill and the chat'
  )
  await crumb('Meeting notes').click()
  await w.waitForSelector('text=Workspace · Custard/Skills/meeting-notes')
  await w.locator('[aria-label="Chats in this workspace"] [role=listitem]').first().waitFor()
  check(
    (await w.locator('[aria-label="Chats in this workspace"] [role=listitem]').count()) === 1,
    'the workspace lists the chat as a card'
  )
  await w.click('button[title="Skills history"]')
  check(
    (await w.locator('[data-chat-skill]').first().innerText()).includes('Meeting notes'),
    'History names the skill a chat belongs to'
  )
  await w.mouse.click(1250, 450)
  await crumb('All skills').click()
  await card('weekly-review').waitFor()

  step('The hub chat brainstorms; it changes nothing')
  // Custard's own automatic writes (memory captures, chat notes) aside.
  const own = /\/Custard\/(Captures|Chats)\/|\.custard-vault-id/
  const notes = () =>
    before()
      .split('\n')
      .filter((l) => !own.test(l))
      .join('\n')
  const vaultHub = notes()
  await w.fill('textarea', 'hub write test')
  await w.keyboard.press('Enter')
  await w.waitForSelector('button[title=Send]', { timeout: 30000 })
  const hubTools = lastReq().tools ?? []
  check(
    hubTools.includes('workspace_propose') && hubTools.includes('vault_read'),
    'it can read notes and offer a workspace'
  )
  check(
    !hubTools.some((t) => /^(vault_create_note|vault_append|vault_edit|fs_|plugin_)|__/.test(t)),
    `it is offered no tool that changes things (${hubTools})`
  )
  check(!fs.existsSync(`${VAULT}/hub-made.md`), 'a note it tries to create anyway is not written')
  check(notes() === vaultHub, 'the vault is unchanged')
  check(
    (await path()).replace(/\s+/g, ' ').startsWith('All skills › Hub chat (brainstorm only)'),
    'the path bar says it is the hub chat'
  )

  step('An offer to open a skill: Not now does nothing, Yes enters it unsent')
  await w.fill('textarea', 'skill open test')
  await w.keyboard.press('Enter')
  await w.waitForSelector('button[title=Send]', { timeout: 30000 })
  const offer = () =>
    w.locator('[role=group][aria-label="Open the weekly-review skill workspace?"]').last()
  await offer().waitFor()
  check(
    (await offer().innerText()).includes('Add a section for next week.'),
    'the card shows the message the new chat would start with'
  )
  await w.screenshot({ path: SHOTS + '/skills-04-offer.png' })
  const beforeNo = requests()
  await offer().getByRole('button', { name: 'Not now' }).click()
  await w.waitForSelector('text=You said not now.')
  check(requests() === beforeNo, 'Not now sends nothing')
  await w.fill('textarea', 'skill open test again')
  await w.keyboard.press('Enter')
  await w.waitForSelector('button[title=Send]', { timeout: 30000 })
  const beforeYes = requests()
  await w
    .locator(
      '[role=group][aria-label="Open the weekly-review skill workspace?"][data-proposal=pending]'
    )
    .getByRole('button', { name: 'Yes, open it' })
    .click()
  await w.waitForSelector('text=Workspace · Custard/Skills/weekly-review')
  check((await box()) === 'Add a section for next week.', 'the message is in the box')
  check(requests() === beforeYes, 'nothing was sent')
  await w.fill('textarea', '')
  await crumb('All skills').click()
  await card('weekly-review').waitFor()

  step('Yes on a create offer makes the skill and enters it')
  await w.fill('textarea', 'skill create test')
  await w.keyboard.press('Enter')
  await w.waitForSelector('button[title=Send]', { timeout: 30000 })
  const create = w.locator('[role=group][aria-label="Create a new skill called Standup notes?"]')
  await create.waitFor()
  check(
    (await create.innerText()).includes('Custard/Skills/standup-notes'),
    'the card names the folder it would make'
  )
  check(!fs.existsSync(`${SKILLS}/standup-notes`), 'nothing is made before Yes')
  await create.getByRole('button', { name: 'Yes, create it' }).click()
  await w.waitForSelector('text=Workspace · Custard/Skills/standup-notes')
  check(fs.existsSync(`${SKILLS}/standup-notes/SKILL.md`), 'Yes made its SKILL.md')
  check((await box()) === 'Write a skill for my daily standup notes.', 'its message is in the box')
  await w.fill('textarea', '')

  step('A new Skills chat opens on the hub again')
  await w.click('button[title="Skills history"]')
  await w.click('button:has-text("New skills chat")')
  await w.waitForSelector('text=Workspace · Custard/Skills/standup-notes')
  await crumb('All skills').click()
  await card('weekly-review').waitFor()
  check(true, 'from a workspace, All skills goes back to the hub')
} catch (e) {
  console.log('error:', e)
  process.exitCode = 1
  await w.screenshot({ path: SHOTS + '/skills-fail.png' }).catch(() => {})
} finally {
  await app.close()
  console.log('\ne2e done, exit', process.exitCode ?? 0)
}
