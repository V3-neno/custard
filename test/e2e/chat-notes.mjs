// Chat notes in the built app, against test/e2e/interrupt-mock.mjs:
//   - a chat gets one summary note in Custard/Chats after a pause, made by a
//     tool-less summary call, with no links or markup from the model
//   - the note is rewritten as the chat goes on, and History shows where the
//     chat stands
//   - a note changed outside Custard is left alone from then on
//   - temporary chats get none, and Forget deletes the note
// Usage, from the repo root after `npx electron-vite build`:
//   node test/e2e/interrupt-mock.mjs <out> &   (with <out>/plugin a copy of plugin/
//                                               and <out>/vault a copy of vault-template/)
//   node test/e2e/chat-notes.mjs <out> <screenshot dir>
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
const CFG = OUT + '/cfg-chat-notes'
const VAULT = OUT + '/vault'
const CHATS = VAULT + '/Custard/Chats'
fs.rmSync(CFG, { recursive: true, force: true })
fs.rmSync(OUT + '/chatnotes.json', { force: true })
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
  globalThis.__asked = []
  dialog.showMessageBox = async (...args) => {
    const o = args.at(-1)
    globalThis.__asked.push({ message: o.message, detail: o.detail })
    return { response: 1, checkboxChecked: false }
  }
  // A short pause instead of the app's own, so the test doesn't wait.
  globalThis.__custardChatNoteDelay = 800
}, VAULT)
let w = null
for (let i = 0; !w && i < 300; i++) {
  w = app.windows().find((x) => x.url().endsWith('/renderer/index.html')) ?? null
  if (!w) await new Promise((r) => setTimeout(r, 100))
}
await w.setViewportSize({ width: 1280, height: 900 })
w.on('pageerror', (e) => console.log('pageerror:', e.message))
await w.waitForSelector('text=Custard')

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
const notes = () => {
  try {
    return fs.readdirSync(CHATS).filter((f) => f.endsWith('.md'))
  } catch {
    return []
  }
}
const calls = () => {
  try {
    return JSON.parse(fs.readFileSync(OUT + '/chatnotes.json', 'utf8'))
  } catch {
    return []
  }
}
const conversations = () => {
  const dir = `${CFG}/custard/conversations`
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(`${dir}/${f}`, 'utf8')))
}
const chat = (start) => conversations().find((c) => c.title.startsWith(start))
const newChat = async () => {
  if (!(await w.locator('aside button:has-text("New chat")').isVisible()))
    await w.click('button[title="Chat history"]')
  await w.click('button:has-text("New chat")')
}

try {
  step('Setup: key and vault')
  await w.click('button[title=Settings]')
  await w.fill('input[aria-label="Claude API key"]', 'sk-ant-test')
  await w.press('input[aria-label="Claude API key"]', 'Enter')
  await w.click('button:has-text("Use an existing vault")')
  await w.waitForSelector('text=· connected')
  await w.click('button:text-is("Done")')

  step('A chat gets a summary note after a pause')
  await send('notes test: help me plan an evening playlist')
  check(
    await until(() => notes().length === 1),
    `one note in Custard/Chats (${notes().join(' | ')})`
  )
  const name = notes()[0]
  check(
    /^\d{4}-\d{2}-\d{2} notes test.* [0-9a-f-]{8}\.md$/.test(name),
    `named by date, title and id (${name})`
  )
  const first = fs.readFileSync(`${CHATS}/${name}`, 'utf8')
  check(
    first.includes('Summary number 1') && first.includes('**Goal:** Plan a calm evening playlist'),
    'it holds the summary'
  )
  check(!/https?:|\]\(/.test(first), 'with no link from the model')
  check(calls().length === 1 && calls()[0].tools === null, 'made by one summary call with no tools')
  check(calls()[0].evidence.includes('help me plan an evening playlist'), 'from the chat itself')
  check(!first.includes('No actions ran'), 'and no empty action record')
  check(
    await until(() => chat('notes test')?.chatNote?.status === 'saved'),
    'the chat records it as saved'
  )

  step('The note follows the chat, and History shows where it stands')
  await send('notes test: add some piano')
  check(
    await until(() => fs.readFileSync(`${CHATS}/${name}`, 'utf8').includes('Summary number 2')),
    'the same note is rewritten after the next turn'
  )
  check(notes().length === 1, 'still one note')
  await w.click('button[title="Chat history"]')
  await w.waitForSelector('aside [data-chat-summary]')
  const histRow = w.locator('aside .group').first()
  check(
    (await histRow.innerText()).includes('Calm evening playlist'),
    "History's title is the summary's, not the first message"
  )
  check(
    (await histRow.locator('[data-chat-summary]').innerText()).includes(
      'Plan a calm evening playlist'
    ),
    'with the goal underneath'
  )
  check(
    (await histRow.locator('[data-chat-tags]').innerText()).replace(/\s+/g, ' ') ===
      'playlist queue-rules',
    'and its tags'
  )
  check(
    fs.readFileSync(`${CHATS}/${name}`, 'utf8').includes('tags: ["playlist","queue-rules"]'),
    'the note carries the tags for Obsidian'
  )
  await w.fill('input[aria-label="Find a chat"]', 'half done')
  check((await w.locator('aside .group').count()) === 1, 'and finds the chat by it')
  await w.screenshot({ path: SHOTS + '/chatnotes-01-history.png' })
  await w.fill('input[aria-label="Find a chat"]', '')
  await w.keyboard.press('Escape')

  step('A summary in a script the user never used is written again')
  await newChat()
  const beforeLang = calls().length
  await send('note language test: a quiet evening playlist please')
  check(
    await until(() => chat('note language test')?.chatNote?.status === 'saved'),
    'the note is saved'
  )
  check(calls().length === beforeLang + 2, 'after a second summary call')
  const langNote = notes().find((f) => f.includes('note language test'))
  const langText = langNote ? fs.readFileSync(`${CHATS}/${langNote}`, 'utf8') : ''
  check(
    langText.includes('**Goal:** Plan a calm evening playlist') &&
      !/[\u4e00-\u9fff]/.test(langText),
    'in the language of the chat'
  )
  await w.click('button[title="Chat history"]')
  await w.fill('input[aria-label="Find a chat"]', 'notes test')
  await w.locator('aside div.group button').first().click()

  step('A note changed outside Custard is left alone')
  fs.appendFileSync(`${CHATS}/${name}`, '\nMy own line.\n')
  const before = calls().length
  await send('notes test: one more')
  check(
    await until(() => chat('notes test')?.chatNote?.status === 'edited'),
    'the chat records the note as changed'
  )
  await new Promise((r) => setTimeout(r, 1500))
  check(
    fs.readFileSync(`${CHATS}/${name}`, 'utf8').includes('My own line.'),
    'and the note keeps the change'
  )
  check(calls().length === before, 'with no summary call made for it')

  step('Temporary chats get no note')
  await newChat()
  await w.click('[aria-label="Temporary chat"]')
  await send('temp notes test: secret plans')
  await new Promise((r) => setTimeout(r, 2500))
  check(notes().length === 2, 'no note for a temporary chat')
  check(!calls().some((c) => c.evidence.includes('secret plans')), 'and no summary call')

  step('Forget deletes the note')
  await newChat()
  await send('forget notes test: something')
  check(await until(() => notes().length === 3), 'another chat gets its note')
  const second = notes().find((n) => n !== name && n !== langNote)
  await w.click('button[title="Chat history"]')
  // Its row shows the summary's title; the search finds it by its first words.
  await w.fill('input[aria-label="Find a chat"]', 'forget notes test')
  const row = w.locator('aside div.group').first()
  await row.hover()
  await row.locator('button:text-is("Forget")').click()
  check(
    await until(() => chat('forget notes test')?.memory?.forgotten === true),
    'the chat is forgotten'
  )
  const asked = await app.evaluate(() => globalThis.__asked.at(-1))
  check(
    !!asked?.detail?.includes(`Custard/Chats/${second}`),
    'it asked first, listing the chat note'
  )
  check(
    !notes().includes(second) && notes().includes(name),
    "its note is deleted, the other chat's kept"
  )
  await w.keyboard.press('Escape')
} catch (e) {
  console.log('error:', e)
  process.exitCode = 1
  await w.screenshot({ path: SHOTS + '/chatnotes-fail.png' }).catch(() => {})
} finally {
  await app.close()
  console.log('\ne2e done, exit', process.exitCode ?? 0)
}
