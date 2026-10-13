// Earlier chats as reference (Step 6) in the built app, against
// test/e2e/interrupt-mock.mjs:
//   - a new chat's prompt lists the newest earlier chats from their notes in
//     Custard/Chats, never its own, and offers chats_search and chats_read
//   - the tools find and read a note; a note from a chat that held web or
//     plugin text makes the chat count as holding outside text
//   - "Reference a chat" in the message box sends a chat's note with the
//     message, shown under it, and opens that chat from there
//   - temporary chats are never listed or shown earlier chats
// Usage, from the repo root after `npx electron-vite build`:
//   node test/e2e/interrupt-mock.mjs <out> &   (with <out>/plugin a copy of plugin/
//                                               and <out>/vault a copy of vault-template/)
//   node test/e2e/earlier-chats.mjs <out> <screenshot dir>
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
const CFG = OUT + '/cfg-earlier-chats'
const VAULT = OUT + '/vault'
const CHATS = VAULT + '/Custard/Chats'
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
const conversations = () => {
  const dir = `${CFG}/custard/conversations`
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(`${dir}/${f}`, 'utf8')))
}
const chat = (start) => conversations().find((c) => c.title.startsWith(start))
// The model request for a message, newest first.
const request = (ask) =>
  JSON.parse(fs.readFileSync(OUT + '/anthropic.json', 'utf8'))
    .filter((r) => JSON.stringify(r.messages).includes(ask))
    .at(-1)
const systemOf = (r) => (r?.system ?? []).map((s) => s.text).join('\n')
const toolResult = (r) =>
  r?.messages
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .filter((c) => c.type === 'tool_result')
    .map((c) => (typeof c.content === 'string' ? c.content : JSON.stringify(c.content)))
    .join('\n') ?? ''
const newChat = async () => {
  if (!(await w.locator('aside button:has-text("New chat")').isVisible()))
    await w.click('button[title="Chat history"]')
  await w.click('button:has-text("New chat")')
}
const outsidePill = () => w.locator('text=Outside text').isVisible()

try {
  step('Setup: key and vault')
  await w.click('button[title=Settings]')
  await w.fill('input[aria-label="Claude API key"]', 'sk-ant-test')
  await w.press('input[aria-label="Claude API key"]', 'Enter')
  await w.click('button:has-text("Use an existing vault")')
  await w.waitForSelector('text=· connected')
  await w.click('button:text-is("Done")')

  step('Two earlier chats with notes')
  await send('Evening playlist: help me plan one')
  check(await until(() => chat('Evening playlist')?.chatNote?.status === 'saved'), 'first note')
  await newChat()
  await send('Garden plan: what to sow in spring')
  check(await until(() => chat('Garden plan')?.chatNote?.status === 'saved'), 'second note')
  const playlist = chat('Evening playlist')
  const garden = chat('Garden plan')

  step('A new chat is shown the newest earlier chats')
  await newChat()
  await send('Hello again, list test')
  const listed = systemOf(request('list test'))
  check(listed.includes('Earlier chats, newest first'), 'the prompt lists earlier chats')
  check(
    listed.includes(`"Garden plan: what to sow in spring" (Chat`) &&
      listed.includes(`chat ${playlist.id}`),
    'both, by title and id'
  )
  check(listed.indexOf('Garden plan') < listed.indexOf('Evening playlist'), 'newest first')
  check(listed.includes('Where it stands: Summary number'), 'with where each stands')
  check(
    ['chats_search', 'chats_read'].every((t) => request('list test').tools.includes(t)),
    'chats_search and chats_read are offered'
  )
  check(!(await outsidePill()), 'notes from chats without outside text add no Outside text pill')
  await new Promise((r) => setTimeout(r, 1500))
  await send('Hello again, list test two')
  check(
    !systemOf(request('list test two')).includes(`"Hello again, list test`),
    "a chat's own note is never in its list"
  )

  step('chats_search and chats_read')
  await newChat()
  await send('e search test')
  const found = toolResult(request('e search test'))
  check(
    found.includes('found') && found.includes('Evening playlist'),
    `search finds it (${found.slice(0, 80)})`
  )
  check(
    (await w.locator('text=Searched earlier chats for "evening playlist"').count()) === 1,
    'the chat shows what was searched'
  )
  await newChat()
  await send('e read test')
  const read = toolResult(request('e read test'))
  check(
    read.includes('Summary note of the earlier chat') && read.includes('Keep it instrumental'),
    'read returns the note'
  )
  check(!(await outsidePill()), 'still no Outside text')

  step('A note from a chat with outside text')
  fs.writeFileSync(
    `${CHATS}/2026-10-01 Web research 99999999.md`,
    '---\ncustard-chat: "99999999-aaaa-bbbb-cccc-dddddddddddd"\nmode: "Chat"\ntitle: "Web research"\nupdated: "2099-01-01 10:00"\noutside: "true"\n---\n# Web research\n\n**Goal:** Read about tea\n'
  )
  await newChat()
  await send('outside list test')
  const withOutside = systemOf(request('outside list test'))
  check(
    withOutside.includes('"Web research"') && !withOutside.includes('Read about tea'),
    'is listed by its title only'
  )
  await new Promise((r) => setTimeout(r, 500))
  check(!(await outsidePill()), 'so listing it adds no Outside text')
  await newChat()
  await send('e read test, outside')
  check(
    toolResult(request('e read test, outside')).includes('Read about tea'),
    'chats_read returns its note'
  )
  check(await until(() => outsidePill()), 'and then the chat shows Outside text')
  check(chat('e read test, outside')?.outside?.includes('chats'), 'recorded as from earlier chats')
  fs.rmSync(`${CHATS}/2026-10-01 Web research 99999999.md`)

  step('Reference a chat from the message box')
  await newChat()
  await w.click('button[aria-label="Reference a chat"]')
  await w.waitForSelector('[role=dialog][aria-label="Reference a chat"]')
  const rows = w.locator('ul[aria-label="Chats you can reference"] button')
  check(
    (await rows.count()) >= 2 &&
      (await rows.allInnerTexts()).some((t) => t.includes('Summary number')),
    'chats with a note are listed with where they stand'
  )
  await w.fill('input[aria-label="Find a chat to reference"]', 'garden')
  check((await rows.count()) === 1, 'and can be found by name')
  await w.screenshot({ path: SHOTS + '/earlier-01-picker.png' })
  await rows.first().click()
  check(
    (await w.locator('ul[aria-label="Chats to reference"] li').innerText()).includes('Garden plan'),
    'the picked chat shows above the message box'
  )
  await send('ref test: what did we decide?')
  const sys = systemOf(request('ref test'))
  check(
    sys.includes('<earlier-chat title="Garden plan: what to sow in spring"'),
    'its note goes with the message'
  )
  check(sys.includes('Keep it instrumental'), 'with the note text')
  check(
    (await w.locator('ul[aria-label="Chats to reference"]').count()) === 0,
    'the box is cleared'
  )
  const sent = w.locator('[aria-label="Referenced chats"]')
  check((await sent.innerText()).includes('Garden plan'), 'the message shows what it referenced')
  check(chat('ref test')?.references?.[0]?.chat === garden.id, 'and the chat keeps it')
  check(!(await outsidePill()), 'a note without outside text adds no Outside text')
  await send('ref test follow-up')
  check(
    systemOf(request('ref test follow-up')).includes('<earlier-chat title="Garden plan'),
    'later messages in the chat still see it'
  )
  await w.screenshot({ path: SHOTS + '/earlier-02-referenced.png' })
  await sent.locator('button').click()
  check(
    await until(
      async () =>
        (await w.locator('text=Garden plan: what to sow in spring').count()) > 0 &&
        !(await w.locator('[aria-label="Referenced chats"]').count())
    ),
    'clicking it opens that chat'
  )

  step('Temporary chats')
  await newChat()
  await w.click('[aria-label="Temporary chat"]')
  await send('temp earlier test: private')
  check(
    !systemOf(request('temp earlier test')).includes('Earlier chats, newest first'),
    'a temporary chat is not shown earlier chats'
  )
  await new Promise((r) => setTimeout(r, 2000))
  await newChat()
  await w.click('button[aria-label="Reference a chat"]')
  await w.waitForSelector('[role=dialog][aria-label="Reference a chat"]')
  check(
    !(await rows.allInnerTexts()).some((t) => t.includes('temp earlier test')),
    'and is never listed to reference'
  )
  await w.keyboard.press('Escape')

  step("A chat note links that chat's captures")
  await newChat()
  await send('links test: remember that I like warm jazz')
  const linked = () => chat('links test')
  const captured = () => {
    try {
      return fs
        .readdirSync(VAULT + '/Custard/Captures', { withFileTypes: true })
        .filter(
          (d) =>
            d.isFile() &&
            fs
              .readFileSync(`${VAULT}/Custard/Captures/${d.name}`, 'utf8')
              .includes(linked()?.id ?? '-')
        )
        .map((d) => d.name.replace(/\.md$/, ''))
    } catch {
      return []
    }
  }
  check(
    await until(() => captured().length > 0, 20000),
    `the chat was captured (${captured().join(' | ')})`
  )
  // The note is written after a turn; one more turn makes sure the capture
  // exists by then.
  await send('links test: thanks')
  check(
    await until(() => {
      const n = linked()?.chatNote
      if (n?.status !== 'saved' || n.upTo !== linked().messages.length) return false
      const text = fs.readFileSync(`${VAULT}/${n.path}`, 'utf8')
      return captured().every((c) => text.includes(`[[Custard/Captures/${c}]]`))
    }, 20000),
    'its note links each capture'
  )
} catch (e) {
  console.log('error:', e)
  process.exitCode = 1
} finally {
  await app.close()
}
