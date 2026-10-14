// Editable folders as levels: the three levels nest (New notes < Add to end <
// Edit text), a folder's level changes in place on its row, settings.json
// keeps one { folder, mode } entry per folder, Edit text includes appending,
// lowering a level takes the tools away, a bad stored mode grants nothing, and
// the automation form names the same levels.
// Against test/e2e/interrupt-mock.mjs; usage as for hardening.mjs:
//   node test/e2e/folder-levels.mjs <out> <screenshot dir>
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
const CFG = OUT + '/cfg-flevels'
const SETTINGS = `${CFG}/custard/settings.json`
const V = OUT + '/vault'
const file = (p) => fs.readFileSync(`${V}/${p}`, 'utf8')
const put = (p, text) => {
  fs.mkdirSync(`${V}/${p.split('/').slice(0, -1).join('/')}`, { recursive: true })
  fs.writeFileSync(`${V}/${p}`, text)
}
put(
  'Notes/Plan.md',
  '---\ntags: [plan]\n---\n# Plan\n\nThe draft is here.\n\n## Log\n- start\n\n## Later\nx\n'
)
put('Journal/Log.md', '# Log\n- first\n')
const count = (text, s) => text.split(s).length - 1

let app = null
let w = null
const launch = async () => {
  app = await electron.launch({
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
  w = null
  for (let i = 0; !w && i < 300; i++) {
    w = app.windows().find((x) => x.url().endsWith('/renderer/index.html')) ?? null
    if (!w) await new Promise((r) => setTimeout(r, 100))
  }
  await w.setViewportSize({ width: 1280, height: 900 })
  w.on('pageerror', (e) => console.log('pageerror:', e.message))
  await w.waitForSelector('text=Custard')
}

const send = async (t) => {
  await w.fill('textarea', t)
  await w.keyboard.press('Enter')
}
const idle = () => w.waitForSelector('button[title=Send]', { timeout: 30000 })
const card = () => w.locator('[role=alertdialog]')
const openSettings = async () => {
  await w.click('button[title=Settings]')
  await w.waitForSelector('text=Editable folders')
}
const closeSettings = () => w.click('button:text-is("Done")')
const ADD = '[role=group][aria-label="What Claude may do there"]'
const row = (folder) => `[role=group][aria-label="What Claude may do in ${folder}"]`
const pressed = async (group) =>
  w.locator(`${group} button[aria-pressed=true]`).getAttribute('data-mode')
const stored = () => JSON.parse(fs.readFileSync(SETTINGS, 'utf8')).vaultGrants
const waitStored = async (want) => {
  for (let i = 0; i < 50; i++) {
    if (JSON.stringify(stored()) === JSON.stringify(want)) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}
const allow = async (folder, mode) => {
  await w.fill('input[aria-label="Folder to allow"]', folder)
  await w.click(`${ADD} button[data-mode=${mode}]`)
  await w.click('button:text-is("Allow")')
}

try {
  await launch()
  step('Setup: key and vault')
  await w.click('button[title=Settings]')
  await w.fill('input[aria-label="Claude API key"]', 'sk-ant-test')
  await w.press('input[aria-label="Claude API key"]', 'Enter')
  await w.click('button:text-is("Use an existing vault")')
  await w.waitForSelector('text=· connected')
  await w.waitForSelector('text=Editable folders')
  await w.uncheck('input[aria-label="Remember automatically"]')

  step('The add row: three levels, one picked, what it allows written out')
  const labels = await w.locator(`${ADD} button`).allTextContents()
  check(
    JSON.stringify(labels) === JSON.stringify(['New notes', 'Add to end', 'Edit text']),
    'the levels are New notes, Add to end, Edit text, in that order'
  )
  check((await pressed(ADD)) === 'append', 'Add to end is picked by default')
  check(
    (await w.locator(`${ADD} button[aria-pressed=true]`).count()) === 1,
    'exactly one level is picked'
  )
  check(
    (await w.locator('section:has(> h3:text-is("Editable folders")) select').count()) === 0,
    'Editable folders has no dropdown'
  )
  await w.click(`${ADD} button[data-mode=edit]`)
  const help = await w.locator(`${ADD} + [data-mode-help]`).textContent()
  check(
    /adding to the end/.test(help) && /Includes everything Add to end allows/.test(help),
    'the line under Edit text says it includes adding to the end'
  )
  const prot = await w.locator('[data-protected-help]').textContent()
  check(
    [
      'Custard/Memory.md',
      'Custard/Skills',
      'Custard/Captures',
      'Custard/Chats',
      'Activity',
      'Overview.md'
    ].every((s) => prot.includes(s)),
    'the help text lists every protected place'
  )

  step('Allow folders with a level')
  await allow('Notes', 'edit')
  await w.waitForSelector(row('Notes'))
  check((await pressed(row('Notes'))) === 'edit', 'Notes shows Edit text picked')
  check((await pressed(ADD)) === 'append', 'the add row goes back to Add to end after a folder')
  await allow('Journal', 'create')
  await w.waitForSelector(row('Journal'))
  check(
    await waitStored([
      { folder: 'Notes', mode: 'edit' },
      { folder: 'Journal', mode: 'create' }
    ]),
    'settings.json holds one { folder, mode } entry per folder'
  )

  step('A refused folder resets the level')
  await allow('../outside', 'edit')
  await w.waitForSelector("text=That folder can't be allowed")
  check(true, 'a folder outside the vault is refused')
  check((await pressed(ADD)) === 'append', 'the level went back to Add to end, not Edit text')
  check(
    (await w.inputValue('input[aria-label="Folder to allow"]')) === '../outside',
    'the refused folder stays in the box to correct'
  )

  step('Trailing dots: "Notes." is the Notes folder')
  await allow('Notes.', 'edit')
  await w
    .locator("text=That folder can't be allowed")
    .waitFor({ state: 'detached', timeout: 5000 })
    .catch(() => {})
  check(
    !(await w.locator("text=That folder can't be allowed").isVisible()),
    'no refusal message for "Notes."'
  )
  check(
    await waitStored([
      { folder: 'Journal', mode: 'create' },
      { folder: 'Notes', mode: 'edit' }
    ]),
    'it is saved as Notes, still one entry'
  )
  check((await w.locator('[data-folder]').count()) === 2, 'two rows, no "Notes./" row')
  await w.screenshot({ path: SHOTS + '/folder-levels-settings.png' })

  step('Raise a level in place: Journal to Edit text')
  await w.click(`${row('Journal')} button[data-mode=edit]`)
  check(
    await waitStored([
      { folder: 'Journal', mode: 'edit' },
      { folder: 'Notes', mode: 'edit' }
    ]),
    'one click saves Edit text for Journal, no retyping'
  )
  check((await pressed(row('Journal'))) === 'edit', 'the row shows Edit text picked')
  await closeSettings()

  step('Edit text includes appending')
  await send('vgrant append')
  await idle()
  check(!(await card().count()), 'no approval card for the append')
  check(
    count(file('Journal/Log.md'), 'APPENDED-LINE-7731') === 1,
    'an append worked in a folder set to Edit text'
  )
  await send('vgrant edit')
  await idle()
  check(/- EDITED-ENTRY-5528/.test(file('Notes/Plan.md')), 'an in-place edit worked too')

  step('Lower the levels in place: the tools go away')
  await openSettings()
  await w.click(`${row('Journal')} button[data-mode=create]`)
  await w.click(`${row('Notes')} button[data-mode=append]`)
  check(
    await waitStored([
      { folder: 'Journal', mode: 'create' },
      { folder: 'Notes', mode: 'append' }
    ]),
    'both lowered levels are saved'
  )
  await closeSettings()
  const planBefore = file('Notes/Plan.md')
  await send('vgrant append')
  await idle()
  check(
    count(file('Journal/Log.md'), 'APPENDED-LINE-7731') === 1,
    'New notes refuses an append: the note is unchanged'
  )
  await send('vgrant edit')
  await idle()
  check(file('Notes/Plan.md') === planBefore, 'Add to end refuses an edit: the note is unchanged')

  step('The automation form names the same levels')
  await openSettings()
  await w.click('button:text-is("New automation")')
  check(
    await w.locator('text=Notes/ (Add to end)').isVisible(),
    'the folder choice reads "Notes/ (Add to end)"'
  )
  check(
    await w.locator('text=Journal/ (New notes)').isVisible(),
    'the folder choice reads "Journal/ (New notes)"'
  )
  await w.click('button:text-is("Cancel")')

  step('Narrowest window (720 × 480): the pills fit')
  await w.setViewportSize({ width: 720, height: 480 })
  await w.locator(row('Notes')).scrollIntoViewIfNeeded()
  const fits = await w.evaluate(() =>
    [...document.querySelectorAll('[role=group][aria-label^="What Claude may do"] button')].every(
      (b) => b.scrollWidth <= b.clientWidth && b.getBoundingClientRect().height < 40
    )
  )
  check(fits, 'every level button shows its whole label on one line')
  await w.screenshot({ path: SHOTS + '/folder-levels-narrow.png' })
  await w.locator(ADD).scrollIntoViewIfNeeded()
  await w.screenshot({ path: SHOTS + '/folder-levels-narrow-add.png' })
  await closeSettings()
  await app.close()

  step('A bad stored mode grants nothing')
  const s = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'))
  s.vaultGrants = [
    { folder: 'Notes', mode: 'Edit' },
    { folder: 'Journal', mode: ['append', 'edit'] },
    { folder: 'Inbox', mode: 'edit+append' }
  ]
  fs.writeFileSync(SETTINGS, JSON.stringify(s, null, 2))
  await launch()
  await openSettings()
  check(
    (await w.locator('ul[aria-label="Editable folders"]').count()) === 0,
    'no folder is shown as allowed'
  )
  await closeSettings()
  const before = file('Journal/Log.md')
  await send('vgrant append')
  await idle()
  check(file('Journal/Log.md') === before, 'an append is refused')
} catch (e) {
  check(false, 'script error: ' + e.message)
} finally {
  await app?.close().catch(() => {})
}
