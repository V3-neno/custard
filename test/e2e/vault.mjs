// Step 4 in the built app, against test/e2e/interrupt-mock.mjs: a vault search
// with phrases, filters and accents; a note edit that asks on its own card
// (no "allow for this chat"), keeps a copy and can be undone; an edit refused
// because the note changed while the card was open; an Undo refused because
// the note changed after the edit; and a declined edit.
// Usage, from the repo root after `npx electron-vite build`:
//   node test/e2e/interrupt-mock.mjs <out> &   (with <out>/vault as for interrupt.mjs)
//   node test/e2e/vault.mjs <out> <screenshot dir>
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
const PLAN = `${OUT}/vault/Projects/Plan.md`
const ORIGINAL = '# Release plan\n\nStatus: draft\n\nMeet at the Café on Friday.\n'
fs.mkdirSync(`${OUT}/vault/Projects`, { recursive: true })
fs.writeFileSync(PLAN, ORIGINAL)
fs.writeFileSync(`${OUT}/vault/Projects/Other.md`, 'cafe, but no plan\n')
const plan = () => fs.readFileSync(PLAN, 'utf8')
const CFG = OUT + '/cfg-vault'
const conversations = () => {
  const dir = `${CFG}/custard/conversations`
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(`${dir}/${f}`, 'utf8')))
}
const requests = () => {
  try {
    return JSON.parse(fs.readFileSync(`${OUT}/anthropic.json`, 'utf8'))
  } catch {
    return []
  }
}
const until = async (f, ms = 15000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await f()) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}

const app = await electron.launch({
  executablePath: createRequire(import.meta.url)('electron'),
  args: [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), '--password-store=basic', '.'],
  env: { ...process.env, ANTHROPIC_BASE_URL: 'http://127.0.0.1:8899', XDG_CONFIG_HOME: CFG }
})
await app.evaluate(({ safeStorage, dialog }, vault) => {
  safeStorage.setUsePlainTextEncryption?.(true)
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [vault] })
}, OUT + '/vault')
let w = null
for (let i = 0; !w && i < 300; i++) {
  w = app.windows().find((x) => x.url().endsWith('/renderer/index.html')) ?? null
  if (!w) await new Promise((r) => setTimeout(r, 100))
}
await w.setViewportSize({ width: 1280, height: 900 })
w.on('pageerror', (e) => console.log('pageerror:', e.message))
await w.waitForSelector('text=Custard')
const shot = (n) => w.screenshot({ path: `${SHOTS}/${n}.png` })
const send = async (t) => {
  await w.fill('textarea', t)
  await w.keyboard.press('Enter')
}
const idle = () => w.waitForSelector('button[title=Send]', { timeout: 30000 })
const card = '[aria-label="Allow note edit"]'
const chat = () => conversations().find((c) => c.title.startsWith('search test'))
const lastEdit = () => {
  const c = chat()
  const ids = Object.keys(c?.actions ?? {}).filter((id) => c.actions[id].name === 'vault_edit')
  return ids.length
    ? { id: ids.at(-1), action: c.actions[ids.at(-1)], edit: c.vaultEdits?.[ids.at(-1)] }
    : null
}

try {
  step('Setup: key and vault')
  await w.click('button[title=Settings]')
  await w.fill('input[aria-label="Claude API key"]', 'sk-ant-test')
  await w.press('input[aria-label="Claude API key"]', 'Enter')
  await w.click('button:has-text("Use an existing vault")')
  await w.waitForSelector('text=· connected')
  await w.click('button:text-is("Done")')

  step('Search: phrase, folder and accents')
  await send('search test')
  await idle()
  const result = requests()
    .flatMap((r) => r.messages)
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .find((c) => c.type === 'tool_result')
  const found = String(result?.content ?? '')
  check(
    /^2 notes matched cafe "release plan" folder:Projects \(1 with every term, listed first\)/.test(
      found
    ),
    'the result gives the total and ranks the note with every term first'
  )
  check(
    /- Projects\/Plan\.md\n/.test(found) && /Other\.md \(1 of 2 terms\)/.test(found),
    'the partial match is labelled'
  )
  check(found.includes('Café'), 'an accent-insensitive match is quoted as written')
  check((await w.locator('text=Searched notes for').count()) > 0, 'the search shows in the chat')
  check(
    requests()[0].tools.includes('vault_edit'),
    'the edit tool is offered with the vault connected'
  )

  step('An edit asks on its own card, then writes, keeps a copy and can be undone')
  await send('edit test one')
  await w.waitForSelector(card, { timeout: 30000 })
  const cardText = await w.locator(card).textContent()
  check(cardText.includes('Edit Projects/Plan.md'), 'the card names the note')
  check(
    (await w.locator(`${card} [aria-label="Text replaced"]`).textContent()) === 'Status: draft' &&
      (await w.locator(`${card} [aria-label="Replacement"]`).textContent()) === 'Status: approved',
    'the card shows exactly the text replaced and the replacement'
  )
  check(!cardText.includes('Allow for this chat'), 'there is no "allow for this chat"')
  await shot('01-edit-card')
  await w.click(`${card} button:text-is("Allow")`)
  await idle()
  check(
    plan() === ORIGINAL.replace('Status: draft', 'Status: approved'),
    'the note holds the edit and nothing else'
  )
  const first = lastEdit()
  check(first?.action.status === 'completed', 'the action is recorded as completed')
  check(
    !!first?.edit &&
      first.edit.backup.startsWith(`${CFG}/custard/vault-history/`) &&
      fs.readFileSync(first.edit.backup, 'utf8') === ORIGINAL,
    'the copy from before is in app data, outside the vault'
  )
  check(
    !fs.readdirSync(`${OUT}/vault/Projects`).some((f) => f.startsWith('.')),
    'no temporary file is left in the vault'
  )
  await w.waitForSelector('text=Edited Projects/Plan.md')
  await shot('02-edited')
  await w.locator('button:text-is("Undo")').last().click()
  check(await until(() => plan() === ORIGINAL), 'Undo puts the note back')
  await w.waitForSelector('text=Undone')
  check(!!lastEdit()?.edit?.undone, 'the chat records the Undo')
  await shot('03-undone')

  step('The note changes while the card is open: the edit is refused')
  await send('edit test two')
  await w.waitForSelector(card, { timeout: 30000 })
  const typed = ORIGINAL.replace('Friday', 'Saturday (typed in Obsidian)')
  fs.writeFileSync(PLAN, typed)
  await w.click(`${card} button:text-is("Allow")`)
  await idle()
  check(plan() === typed, 'the newer text is kept')
  check(lastEdit()?.action.status === 'not-run', 'the edit is recorded as not run')
  check(
    /changed while the edit waited for approval/.test(lastEdit()?.action.result ?? ''),
    'the model is told why'
  )
  await w.waitForSelector('text=· not run')

  step('The note changes after the edit: Undo is refused')
  await send('edit test three')
  await w.waitForSelector(card, { timeout: 30000 })
  await w.click(`${card} button:text-is("Allow")`)
  await idle()
  const edited = typed.replace('Status: draft', 'Status: approved')
  check(plan() === edited, 'the second edit lands on the current text')
  const later = `${edited}\nAdded later in Obsidian\n`
  fs.writeFileSync(PLAN, later)
  await w.locator('button:text-is("Undo")').last().click()
  await w.waitForSelector('[role=alert]:has-text("has changed since this edit")')
  check(plan() === later, 'Undo leaves the newer changes alone')
  check(
    (
      await w.locator('[role=alert]:has-text("has changed since this edit")').textContent()
    ).includes('vault-history'),
    'the refusal says where the copy is'
  )
  await shot('04-undo-refused')

  step('A declined edit changes nothing')
  fs.writeFileSync(PLAN, ORIGINAL)
  await send('edit test four')
  await w.waitForSelector(card, { timeout: 30000 })
  await w.click(`${card} button:text-is("Don't allow")`)
  await idle()
  check(plan() === ORIGINAL, 'the note is unchanged')
  check(lastEdit()?.action.status === 'not-run', 'it is recorded as not run')
} catch (err) {
  console.log('✕ crashed:', err.message)
  process.exitCode = 1
  await shot('error').catch(() => undefined)
} finally {
  await app.close()
}
