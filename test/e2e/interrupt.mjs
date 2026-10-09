// Step 1 (honest turn endings) in the built app, against test/e2e/interrupt-mock.mjs.
// Usage, from the repo root after `npx electron-vite build`:
//   node test/e2e/interrupt-mock.mjs <out> &   (with <out>/plugin a copy of plugin/
//                                               and <out>/vault a copy of vault-template/)
//   node test/e2e/interrupt.mjs <out> <screenshot dir>
// Linux only as written (XDG_CONFIG_HOME isolates the app's data), with a display
// or xvfb-run. Needs the playwright package, which isn't a dependency of this repo.
import { _electron as electron } from 'playwright'
import { createRequire } from 'module'
import fs from 'fs'

const [, , OUT, SHOTS] = process.argv
const check = (cond, what) => {
  console.log((cond ? '✓ ' : '✕ ') + what)
  if (!cond) process.exitCode = 1
}
const step = (s) => console.log('\n## ' + s)
// The mock may be mid-write; a partial file reads as "nothing yet".
const spotifyLog = () => {
  try {
    return JSON.parse(fs.readFileSync(OUT + '/spotify.json', 'utf8'))
  } catch {
    return []
  }
}
const queuePosts = () =>
  spotifyLog().filter((r) => r.path === '/v1/me/player/queue' && r.method === 'POST').length
const until = async (f, ms = 15000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await f()) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}
const conversations = () => {
  const dir = `${OUT}/cfg/custard/conversations`
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(`${dir}/${f}`, 'utf8')))
}

async function launch() {
  const app = await electron.launch({
    executablePath: createRequire(import.meta.url)('electron'),
    args: [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), '--password-store=basic', '.'],
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:8899',
      XDG_CONFIG_HOME: OUT + '/cfg',
      CUSTARD_PLUGIN_DIR: OUT + '/plugin'
    }
  })
  await app.evaluate(({ safeStorage, dialog, shell }, vault) => {
    safeStorage.setUsePlainTextEncryption?.(true)
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [vault] })
    globalThis.__custardPluginTransport = async (req) => {
      const r = await fetch('http://127.0.0.1:8899' + req.url.pathname + req.url.search, {
        method: req.method,
        headers: req.headers,
        body: req.body,
        signal: req.signal
      })
      return { status: r.status, headers: Object.fromEntries(r.headers), body: await r.text() }
    }
    shell.openExternal = async (url) => {
      if (url.startsWith('https://accounts.spotify.com/authorize')) {
        const p = new URL(url).searchParams
        setTimeout(() => fetch(`${p.get('redirect_uri')}?code=CODE&state=${p.get('state')}`), 300)
      }
    }
  }, OUT + '/vault')
  // The app's window, not a plugin's hidden sandbox window.
  let w = null
  for (let i = 0; !w && i < 300; i++) {
    w = app.windows().find((x) => x.url().endsWith('/renderer/index.html')) ?? null
    if (!w) await new Promise((r) => setTimeout(r, 100))
  }
  await w.setViewportSize({ width: 1280, height: 900 })
  w.on('pageerror', (e) => console.log('pageerror:', e.message))
  await w.waitForSelector('text=Custard')
  return { app, w }
}

let { app, w } = await launch()
const shot = (n) => w.screenshot({ path: `${SHOTS}/${n}.png` })
const send = async (t) => {
  await w.fill('textarea', t)
  await w.keyboard.press('Enter')
}
const idle = () => w.waitForSelector('button[title=Send]', { timeout: 30000 })
const card = '[aria-label="Allow plugin action"]'

try {
  step('Setup: key, vault, Spotify activated and connected')
  await w.click('button[title=Settings]')
  await w.fill('input[aria-label="Claude API key"]', 'sk-ant-test')
  await w.press('input[aria-label="Claude API key"]', 'Enter')
  await w.click('button:has-text("Use an existing vault")')
  await w.waitForSelector('text=· connected')
  await w.click('button:text-is("Plugins")')
  await w.click('button:has-text("Spotify")')
  await w.click('button:has-text("Review and activate")')
  await w.waitForSelector('text=New permissions to approve', { timeout: 30000 })
  const boxes = w.locator('section:has-text("New permissions to approve") input[type=checkbox]')
  for (let i = 0; i < (await boxes.count()); i++) await boxes.nth(i).check()
  await w.click('button:text-matches("^Activate [0-9]")')
  await w.waitForSelector('text=Save configuration', { timeout: 30000 })
  await w.fill('input[aria-label="Client ID"]', '0123456789abcdef0123456789abcdef')
  await w.click('button:has-text("Save configuration")')
  await w.click('button:text-is("Connect")')
  await w.waitForSelector('text=· connected', { timeout: 15000 })
  // Chat, Design and Skills use a plugin only once it's turned on for them.
  await w.click('label:has-text("in Chat, Design and Skills") input[type=checkbox]')
  await w.waitForSelector('label:has-text("in Chat, Design and Skills") input:checked')
  await w.click('button:text-is("Done")')

  step('Stop during an action, in a round with a later write')
  await send('stop test')
  // The note the model creates first needs its own approval.
  await w.waitForSelector(`${card}:has-text("Create note Log-before.md")`, { timeout: 30000 })
  await w.click(`${card} button:text-is("Allow")`)
  await w.waitForSelector(`${card}:has-text("Spotify queue")`, { timeout: 30000 })
  await w.click(`${card} button:text-is("Allow for this chat")`)
  check(
    await until(() => queuePosts() === 1),
    'the queue request reached Spotify (and gets no answer)'
  )
  await w.click('button[title=Stop]')
  await idle()
  await shot('step1-01-stopped')
  check(
    fs.existsSync(OUT + '/vault/Log-before.md') && !fs.existsSync(OUT + '/vault/Log-after.md'),
    'the write before ran, the write after the stop never did'
  )
  check(
    (await w.locator('text=· outcome unknown').count()) === 1,
    'the queue call shows "outcome unknown"'
  )
  check((await w.locator('text=· not run').count()) === 1, 'the later vault write shows "not run"')
  check(
    (await w.locator('[role=status]:has-text("Stopped by you.")').count()) === 1,
    'a "Stopped by you." notice sits in the chat'
  )
  check((await w.inputValue('textarea')) === '', 'the message was not put back in the box')
  const c1 = conversations().find((c) => c.title === 'stop test')
  check(
    JSON.stringify(Object.values(c1.actions).map((a) => a.status)) ===
      JSON.stringify(['completed', 'completed', 'unknown', 'not-run']),
    'saved statuses: completed, completed, unknown, not-run'
  )

  step('A repeat of the unknown action always asks, with a warning')
  await send('try again')
  await w.waitForSelector(card, { timeout: 30000 })
  const text = await w.locator(card).textContent()
  check(/outcome is unknown/.test(text), 'the card warns that the earlier outcome is unknown')
  check(
    (await w.locator(`${card} button:text-is("Allow for this chat")`).count()) === 0,
    'even though queueing was allowed for this chat, and with no "for this chat" option'
  )
  await shot('step1-02-repeat-warning')
  await w.click(`${card} button:has-text("Don't allow")`)
  await w.waitForSelector('text=I did not queue it again.', { timeout: 30000 })
  await idle()
  check(queuePosts() === 1, 'nothing more was sent to Spotify')

  step('An error after an action keeps the turn')
  await send('error test')
  await w.waitForSelector('[role=status]:has-text("Claude returned an error (400)")', {
    timeout: 30000
  })
  await idle()
  check((await w.inputValue('textarea')) === '', 'the message was not put back in the box')
  check(
    (await w.locator('text=Read Areas/Music Preferences.md').count()) >= 1,
    'the vault read that ran is still shown'
  )

  step('A cut-off reply offers Continue')
  await send('cut test')
  await w.waitForSelector('[role=status]:has-text("cut off")', { timeout: 30000 })
  await idle()
  await shot('step1-03-cut-off')
  await w.click('[role=status] button:text-is("Continue")')
  await w.waitForSelector('text=and here is the rest.', { timeout: 30000 })
  await idle()
  check(
    (await w.locator('[role=status] button:text-is("Continue")').count()) === 0,
    'Continue sent a message and went away'
  )

  step('A mixed round keeps its success, and Continue repeats nothing')
  await w.click('button[title="Chat history"]')
  await w.click('button:has-text("New chat")')
  await send('mixed test')
  await w.waitForSelector(`${card}:has-text("Create note Log-mixed.md")`, { timeout: 30000 })
  await w.click(`${card} button:text-is("Allow")`)
  await w.waitForSelector('[role=status]:has-text("cut off")', { timeout: 30000 })
  await idle()
  const c3 = conversations().find((c) => c.title === 'mixed test')
  check(
    JSON.stringify(Object.values(c3.actions).map((a) => a.status)) ===
      JSON.stringify(['completed', 'failed']),
    'saved statuses: the write completed, the read failed'
  )
  await w.click('[role=status] button:text-is("Continue")')
  await w.waitForSelector('text=and here is the rest.', { timeout: 30000 })
  await idle()
  const logAfter = fs.readFileSync(OUT + '/vault/Log-mixed.md', 'utf8')
  check(
    logAfter.split('mixed').length === 2 && (await w.locator(card).count()) === 0,
    `the write ran once, not again on Continue (Log-mixed.md: ${JSON.stringify(logAfter)})`
  )
  const lastReq = JSON.parse(fs.readFileSync(OUT + '/anthropic.json', 'utf8')).at(-1)
  check(
    JSON.stringify(lastReq.messages).includes('mixed') &&
      lastReq.messages.some(
        (m) =>
          Array.isArray(m.content) &&
          m.content.some((b) => b.type === 'tool_result' && b.is_error === false)
      ),
    'the Continue request still carries the completed result'
  )
  check(
    Object.keys(conversations().find((c) => c.title === 'mixed test').actions).length === 2,
    'no new actions were recorded on Continue'
  )

  step('The step limit ends the turn explicitly and keeps the progress')
  await w.click('button[title="Chat history"]')
  await w.click('button:has-text("New chat")')
  await send('loop test')
  await w.waitForSelector('[role=status]:has-text("Stopped after 25 steps")', { timeout: 60000 })
  await idle()
  await shot('step1-05-step-limit')
  const c4 = conversations().find((c) => c.title === 'loop test')
  const loopActions = Object.values(c4.actions)
  check(
    loopActions.length === 25 && loopActions.every((a) => a.status === 'completed'),
    `all 25 reads are kept as completed (${loopActions.length})`
  )
  check(
    c4.notices?.at(-1)?.kind === 'step-limit' && c4.notices.at(-1).after === c4.messages.length,
    'a step-limit notice is saved at the end of the chat'
  )
  check((await w.inputValue('textarea')) === '', 'the message was not put back in the box')
  await send('thanks')
  await w.waitForSelector('text=OK.', { timeout: 30000 })
  await idle()
  check(true, 'the chat carries on after the step limit')

  step('Custard is killed mid-action, then reopened')
  await w.click('button[title="Chat history"]')
  await w.click('button:has-text("New chat")')
  await send('crash test')
  await w.waitForSelector(card, { timeout: 30000 })
  await w.click(`${card} button:text-is("Allow")`)
  check(await until(() => queuePosts() === 2), 'the second queue request reached Spotify')
  check(
    conversations().find((c) => c.title === 'crash test').actions &&
      Object.values(conversations().find((c) => c.title === 'crash test').actions).some(
        (a) => a.status === 'running'
      ),
    'the running call was saved before it finished'
  )
  app.process().kill('SIGKILL')
  ;({ app, w } = await launch())
  await w.click('button[title="Chat history"]')
  await w.click('button:has-text("crash test")')
  await w.waitForSelector('[role=status]:has-text("Custard closed before this turn finished.")', {
    timeout: 15000
  })
  await shot('step1-04-reloaded')
  check(
    (await w.locator('text=· outcome unknown').count()) === 1,
    'the interrupted queue call shows "outcome unknown"'
  )
  await new Promise((r) => setTimeout(r, 3000))
  check(queuePosts() === 2, 'nothing was re-sent to Spotify after reopening')
  const c2 = conversations().find((c) => c.title === 'crash test')
  check(
    c2.messages.at(-1).role === 'user' &&
      c2.messages
        .at(-1)
        .content.some((b) => b.type === 'tool_result' && /^Outcome unknown/.test(b.content)),
    'the saved history is valid again, with an "Outcome unknown" result'
  )

  step('Declining the repeat after reopening sends nothing')
  await send('try again')
  await w.waitForSelector(card, { timeout: 30000 })
  check(
    /outcome is unknown/.test(await w.locator(card).textContent()),
    'the repeat asks with a warning after a crash too'
  )
  await w.click(`${card} button:has-text("Don't allow")`)
  await w.waitForSelector('text=I did not queue it again.', { timeout: 30000 })
  await idle()
  await new Promise((r) => setTimeout(r, 1000))
  check(queuePosts() === 2, 'nothing more was sent to Spotify')
  const c5 = conversations().find((c) => c.title === 'crash test')
  check(
    Object.values(c5.actions).at(-1).status === 'not-run',
    'the declined repeat is saved as not run'
  )
} catch (e) {
  await shot('step1-fail').catch(() => {})
  console.log(e)
  process.exitCode = 1
}
await app.close().catch(() => {})
console.log('\ne2e done, exit', process.exitCode ?? 0)
