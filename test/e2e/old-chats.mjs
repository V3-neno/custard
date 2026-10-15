// Old chats (B3), in the built app, against test/e2e/interrupt-mock.mjs:
//   - a normal chat before and after, stored in Custard's format
//   - History lists old chats (saved before B3, from a newer Custard, or
//     unreadable) as "Old format" beside new ones
//   - opening one shows it can't be opened, with Delete, and sends nothing
//   - deleting one removes its file and its attached files
//   - Delete all old chats asks first, says what goes, and removes the rest,
//     leaving the new chat, the vault's notes and settings as they were
//   - the startup sweep keeps an old chat's attached files and removes an
//     orphan folder
// Usage, from the repo root after `npx electron-vite build`:
//   node test/e2e/interrupt-mock.mjs <out> &   (with <out>/vault a copy of vault-template/)
//   node test/e2e/old-chats.mjs <out> <screenshot dir>
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
const CFG = OUT + '/cfg-old-chats'
const VAULT = OUT + '/vault'
const DATA = `${CFG}/custard`
const CHATS = `${DATA}/conversations`
const FILES = `${DATA}/attachments`
fs.rmSync(CFG, { recursive: true, force: true })

// Old chats, written before Custard starts, as an earlier Custard left them.
const OLD = '0ld0ld00-0000-4000-8000-000000000001'
const NEWER = '0ld0ld00-0000-4000-8000-000000000002'
const BROKEN = '0ld0ld00-0000-4000-8000-000000000003'
const DESIGN = '0ld0ld00-0000-4000-8000-000000000004'
const ORPHAN = '0ld0ld00-0000-4000-8000-0000000000ff'
fs.mkdirSync(CHATS, { recursive: true })
fs.writeFileSync(
  `${CHATS}/${OLD}.json`,
  JSON.stringify({
    id: OLD,
    mode: 'chat',
    title: 'Trip to Lisbon',
    createdAt: Date.now() - 86_400_000 * 3,
    updatedAt: Date.now() - 86_400_000 * 3,
    messages: [
      { role: 'user', content: 'Plan a trip to Lisbon' },
      { role: 'assistant', content: [{ type: 'text', text: 'Here is a plan.' }] }
    ],
    attachments: [{ id: 'a1', message: 0, name: 'map.png', kind: 'image' }]
  })
)
fs.writeFileSync(
  `${CHATS}/${NEWER}.json`,
  JSON.stringify({
    format: 'custard-chat',
    version: 2,
    id: NEWER,
    mode: 'chat',
    title: 'From a newer Custard',
    createdAt: Date.now() - 86_400_000 * 2,
    updatedAt: Date.now() - 86_400_000 * 2,
    messages: []
  })
)
fs.writeFileSync(`${CHATS}/${BROKEN}.json`, '{"id": "cut off')
fs.writeFileSync(
  `${CHATS}/${DESIGN}.json`,
  JSON.stringify({
    id: DESIGN,
    mode: 'design',
    title: 'Logo ideas',
    createdAt: Date.now() - 86_400_000 * 4,
    updatedAt: Date.now() - 86_400_000 * 4,
    messages: [{ role: 'user', content: 'Draw a logo' }]
  })
)
for (const id of [OLD, ORPHAN]) {
  fs.mkdirSync(`${FILES}/${id}`, { recursive: true })
  fs.writeFileSync(`${FILES}/${id}/a1.png`, 'png')
}
// A summary note an earlier Custard wrote for the old chat: never touched.
const NOTE = `${VAULT}/Custard/Chats/Trip to Lisbon ${OLD.slice(0, 8)}.md`
fs.mkdirSync(`${VAULT}/Custard/Chats`, { recursive: true })
fs.writeFileSync(
  NOTE,
  `---\ncustard-chat: "${OLD}"\ntitle: "Trip to Lisbon"\n---\n**Goal:** Lisbon`
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
}, VAULT)
let w = null
for (let i = 0; !w && i < 300; i++) {
  w = app.windows().find((x) => x.url().endsWith('/renderer/index.html')) ?? null
  if (!w) await new Promise((r) => setTimeout(r, 100))
}
await w.setViewportSize({ width: 1280, height: 900 })
const errors = []
w.on('pageerror', (e) => {
  errors.push(e.message)
  console.log('pageerror:', e.message)
})
await w.waitForSelector('text=Custard')
const until = async (f, ms = 15000) => {
  for (let t = 0; t < ms; t += 100) {
    if (await f()) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}
const send = async (t) => {
  await w.fill('textarea', t)
  await w.keyboard.press('Enter')
  await w.waitForSelector('button[title=Send]', { timeout: 30000 })
}
const requests = () => {
  try {
    return JSON.parse(fs.readFileSync(`${OUT}/anthropic.json`, 'utf8')).length
  } catch {
    return 0
  }
}
const newChats = () =>
  fs
    .readdirSync(CHATS)
    .map((f) => JSON.parse(fs.readFileSync(`${CHATS}/${f}`, 'utf8') || 'null'))
    .filter((c) => c?.format === 'custard-chat' && c.version === 1)
const rows = () => w.locator('aside .group')
const titles = async () =>
  (await w.locator('aside .group .truncate').allInnerTexts()).map((t) => t.trim())
const openHistory = async () => {
  await w.click('button[title="Chat history"]')
  await w.waitForSelector('aside >> text=All chats')
}

try {
  step('The startup sweep')
  check(fs.existsSync(`${FILES}/${OLD}/a1.png`), "an old chat's attached files are kept")
  check(
    await until(() => !fs.existsSync(`${FILES}/${ORPHAN}`)),
    'a folder with no chat file is removed'
  )

  step('A normal chat before')
  await w.click('button[title=Settings]')
  await w.fill('input[aria-label="Claude API key"]', 'sk-ant-test')
  await w.press('input[aria-label="Claude API key"]', 'Enter')
  await w.click('button:has-text("Use an existing vault")')
  await w.waitForSelector('text=· connected')
  await w.click('button:text-is("Done")')
  await send('first question in the new format')
  const before = newChats()
  check(before.length === 1, 'one chat is stored in format custard-chat, version 1')
  const c = before[0]
  check(
    c?.messages.length === 2 &&
      c.messages[0].role === 'user' &&
      c.messages[0].parts[0].text === 'first question in the new format' &&
      c.messages[1].role === 'assistant' &&
      c.messages[1].by?.provider === 'claude' &&
      Array.isArray(c.messages[1].parts),
    'its messages are parts, and the reply says who wrote it'
  )
  check(
    Object.keys(JSON.parse(fs.readFileSync(`${CHATS}/${c.id}.json`, 'utf8')))
      .slice(0, 2)
      .join() === 'format,version',
    'the file starts with format and version'
  )
  await w.screenshot({ path: SHOTS + '/old-chats-01-normal-before.png' })

  step('History lists old and new chats')
  await openHistory()
  const all = await titles()
  check(
    [
      'first question',
      'Trip to Lisbon',
      'From a newer Custard',
      'Untitled chat',
      'Logo ideas'
    ].every((x) => all.some((t) => t.includes(x))),
    `the new chat and four old ones are listed (${all.join(' | ')})`
  )
  const old = rows().filter({ has: w.locator('[data-chat-old]') })
  check((await old.count()) === 4, 'the four old ones are marked Old format')
  check(
    (await rows().filter({ hasText: 'Logo ideas' }).innerText()).includes('Design'),
    "an old chat's row names its mode"
  )
  check(
    !(await rows().filter({ hasText: 'first question' }).locator('[data-chat-old]').count()),
    'the new one is not'
  )
  check(
    await w.locator("text=4 old chats can't be opened.").isVisible(),
    'History says how many old chats there are'
  )
  await rows().filter({ hasText: 'Trip to Lisbon' }).hover()
  check(
    !(await rows()
      .filter({ hasText: 'Trip to Lisbon' })
      .locator('button:text-is("Forget")')
      .count()),
    'an old chat offers no Forget'
  )
  await w.screenshot({ path: SHOTS + '/old-chats-02-history.png' })

  step('Opening an old chat')
  const sentBefore = requests()
  await rows().filter({ hasText: 'Trip to Lisbon' }).locator('button').first().click()
  const view = w.locator('[aria-label="Old chat"]')
  await view.waitFor()
  check((await view.locator('h1').innerText()).trim() === 'Trip to Lisbon', 'it shows the title')
  check(
    (await view.innerText()).includes(
      "This chat was saved by an earlier Custard and can't be opened."
    ),
    'and says an earlier Custard saved it and it cannot be opened'
  )
  check(!(await w.locator('text=Plan a trip to Lisbon').count()), 'none of its messages show')
  check(!(await w.locator('text=Here is a plan.').count()), 'nor its answer')
  await w.screenshot({ path: SHOTS + '/old-chats-03-open.png' })
  // The other reasons have their own words.
  await openHistory()
  await rows().filter({ hasText: 'From a newer Custard' }).locator('button').first().click()
  await w.waitForSelector('text=saved by a newer Custard')
  check(true, 'one from a newer Custard says so')
  await openHistory()
  await rows().filter({ hasText: 'Untitled chat' }).locator('button').first().click()
  await w.waitForSelector("text=This chat's file can't be read")
  check(true, "one that can't be read says so")
  // One from another mode opens in that mode.
  await openHistory()
  await rows().filter({ hasText: 'Logo ideas' }).locator('button').first().click()
  await w.waitForSelector('[aria-label="Old chat"] >> text=Logo ideas')
  check(
    (await w.locator('button.molten-fill[title]').first().innerText()).trim() === 'Design',
    'an old Design chat opens in Design mode, as an old chat'
  )
  check(!(await w.locator('text=Draw a logo').count()), 'with none of its messages')
  await w.locator('button[title]:text-is("Chat")').click()
  check(requests() === sentBefore, 'opening old chats sent nothing')

  step('Deleting one')
  await openHistory()
  await rows().filter({ hasText: 'Trip to Lisbon' }).locator('button').first().click()
  await view.waitFor()
  await view.locator('button:text-is("Delete")').click()
  check(await until(() => !fs.existsSync(`${CHATS}/${OLD}.json`)), 'the chat file is deleted')
  check(await until(() => !fs.existsSync(`${FILES}/${OLD}`)), 'and its attached files')
  check(await until(async () => !(await view.count())), 'the old-chat view closes')
  check(fs.existsSync(NOTE), 'its summary note in the vault stays')

  step('Delete all old chats')
  await openHistory()
  check(
    await w.locator("text=3 old chats can't be opened.").isVisible(),
    'History now counts three'
  )
  await w.click('aside button:text-is("Delete all old chats")')
  const confirm = w.locator('[role=alertdialog][aria-label="Delete all old chats"]')
  await confirm.waitFor()
  const said = await confirm.innerText()
  check(said.includes('Delete all 3 old chats?'), 'it asks first, with the count')
  check(
    said.includes('the chat file, its attached files, its Design outputs and its widget records'),
    'it says what is removed'
  )
  check(
    said.includes(
      'Your memory, the notes in Custard/Chats, captures, usage totals and settings stay as they are.'
    ),
    'and what stays'
  )
  await w.screenshot({ path: SHOTS + '/old-chats-04-delete-all.png' })
  await confirm.locator('button:text-is("Keep them")').click()
  check(
    [NEWER, BROKEN, DESIGN].every((id) => fs.existsSync(`${CHATS}/${id}.json`)),
    'Keep them deletes nothing'
  )
  await w.click('aside button:text-is("Delete all old chats")')
  await confirm.locator('button:text-is("Delete 3 old chats")').click()
  check(
    await until(() => [NEWER, BROKEN, DESIGN].every((id) => !fs.existsSync(`${CHATS}/${id}.json`))),
    'all three files are deleted'
  )
  check(
    await until(async () => !(await w.locator("text=old chats can't be opened").count())),
    'the old-chats line is gone'
  )
  const left = await titles()
  check(
    left.length === 1 && left[0].includes('first question'),
    `only the new chat is left (${left.join(' | ')})`
  )
  check(fs.existsSync(NOTE), 'the vault note stays')
  check(fs.existsSync(`${DATA}/settings.json`), 'settings stay')

  step('A normal chat after')
  await rows().filter({ hasText: 'first question' }).locator('button').first().click()
  await w.waitForSelector('text=first question in the new format')
  await send('second question after the cleanup')
  const after = newChats()
  check(
    after.length === 1 && after[0].messages.length === 4,
    'the same chat goes on, with four stored messages'
  )
  const second = requests() > 0 ? JSON.parse(fs.readFileSync(`${OUT}/anthropic.json`, 'utf8')) : []
  const last = second.at(-1)?.messages ?? []
  check(
    last.length === 3 &&
      last[0].content === 'first question in the new format' &&
      last[2].content === 'second question after the cleanup',
    'its request carries the history, with typed messages as plain strings'
  )
  await w.screenshot({ path: SHOTS + '/old-chats-05-normal-after.png' })
  check(errors.length === 0, 'no page errors')
} catch (e) {
  console.log('error:', e)
  process.exitCode = 1
  await w.screenshot({ path: SHOTS + '/old-chats-fail.png' }).catch(() => {})
} finally {
  await app.close()
  console.log('\ne2e done, exit', process.exitCode ?? 0)
}
