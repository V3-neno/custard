// Automatic memory in the built app, against test/e2e/interrupt-mock.mjs: a
// chat with a plugin action is remembered without being asked, a later chat
// sees it, small talk isn't saved, the per-chat and global switches stop it,
// and a capture waiting for a missing vault is saved after a restart.
// Usage, from the repo root after `npx electron-vite build`:
//   node test/e2e/interrupt-mock.mjs <out> &   (with <out>/plugin and <out>/vault as for interrupt.mjs)
//   node test/e2e/memory.mjs <out> <screenshot dir>
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
const read = (f, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(OUT + f, 'utf8'))
  } catch {
    return fallback
  }
}
const summaries = () => read('/memory.json', [])
const chatRequests = () => read('/anthropic.json', [])
const note = (p) => fs.readFileSync(`${OUT}/vault/${p}`, 'utf8')
const until = async (f, ms = 15000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await f()) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}
const conversations = () => {
  const dir = `${OUT}/cfg-mem/custard/conversations`
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
      XDG_CONFIG_HOME: OUT + '/cfg-mem',
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
const send = async (t) => {
  await w.fill('textarea', t)
  await w.keyboard.press('Enter')
}
const idle = () => w.waitForSelector('button[title=Send]', { timeout: 30000 })
const status = () => w.locator('[aria-label="Memory status"]').textContent()
const newChat = async () => {
  await w.click('button[title="Chat history"]')
  await w.click('button:has-text("New chat")')
}
const ownMemory = note('Custard/Memory.md')

try {
  step('Setup: key, vault, Spotify activated and connected')
  await w.click('button[title=Settings]')
  await w.fill('input[aria-label="Claude API key"]', 'sk-ant-test')
  await w.press('input[aria-label="Claude API key"]', 'Enter')
  await w.click('button:has-text("Use an existing vault")')
  await w.waitForSelector('text=· connected')
  check(
    await w.locator('input[aria-label="Remember automatically"]').isChecked(),
    '"Remember automatically" is on by default'
  )
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
  await w.click('button:text-is("Done")')

  step('A chat with a plugin action is remembered without being asked')
  await send('memory test: I like warm jazz. Find Nils Frahm for me')
  await idle()
  check(
    await until(async () => /^Saved to memory/.test(await status())),
    `the chat says it was saved (${await status()})`
  )
  const s1 = summaries()
  check(s1.length === 1, 'one summary call')
  check(
    s1[0]?.model === 'claude-haiku-4-5' && s1[0]?.tools === null && s1[0]?.format === 'json_schema',
    'on Haiku 4.5, with no tools, asking for JSON'
  )
  check(
    s1[0]?.max_tokens === 1500 && s1[0]?.evidence.length <= 8000,
    'bounded: 1,500 output tokens, at most 8,000 characters in'
  )
  check(
    /\[spotify__search, plugin spotify, read-only\] → completed/.test(s1[0]?.evidence ?? ''),
    "the evidence names the action and Custard's record of it"
  )
  const act = note('Custard/Plugins/Spotify/Activity.md')
  check(
    act.includes('### ') &&
      act.includes('Looked up Nils Frahm') &&
      act.includes('- Plugin: Spotify') &&
      act.includes(': the tool reported success') &&
      act.includes('- Outcome: Accepted by the tool, not confirmed'),
    "the plugin's Activity.md has a readable entry that does not call an unconfirmed action a success"
  )
  const mem = note('Custard/Memory.md')
  check(
    mem.startsWith(ownMemory.trimEnd()) &&
      mem.includes('## Remembered by Custard') &&
      mem.includes('Prefers warm jazz'),
    "Memory.md keeps the user's text and adds the preference in Custard's own section"
  )
  check(
    /^---\ncustard-plugin-id: spotify\n---/.test(note('Custard/Plugins/Spotify/Overview.md')) &&
      note('Custard/Plugins/Spotify/Overview.md').includes('treat it as a claim'),
    "on first use, Spotify got its own folder, identified by id, with its description marked as the plugin's claim"
  )
  check(
    mem.includes('[[Custard/Plugins/Spotify/Overview|Spotify]]') &&
      !fs.existsSync(`${OUT}/vault/Custard/Activity.md`),
    'Memory.md links it; plugin activity does not go to the general Activity note'
  )
  await w.screenshot({ path: `${SHOTS}/step2-04-memory-saved.png` })

  step('A later chat sees it')
  await newChat()
  await send('hello')
  await idle()
  const sys = JSON.stringify(chatRequests().at(-1)?.system)
  check(
    sys.includes('Prefers warm jazz') && !sys.includes('Looked up Nils Frahm'),
    "the next chat's system prompt carries the preference, but not Spotify's notes for small talk"
  )
  check(sys.includes('never authorize an action'), 'and says notes are not permission to act')
  check(summaries().length === 1, 'small talk is not summarized')
  check((await status()) === '', 'and the chat shows no memory status')

  await send('Did spotify find what I asked for earlier?')
  await idle()
  const sys2 = JSON.stringify(chatRequests().at(-1)?.system)
  check(
    sys2.includes('<plugin-notes plugin=\\"Spotify\\"') &&
      sys2.includes('Looked up Nils Frahm') &&
      sys2.includes('Accepted by the tool, not confirmed'),
    'naming Spotify brings its notes from the earlier chat'
  )
  check(summaries().length === 1, 'and asking about it is not itself summarized')

  step("Don't remember this chat")
  await w.click("text=Don't remember this chat")
  check(
    await until(async () => (await status()) === 'Not remembering this chat.'),
    'the chat says it is not being remembered'
  )
  await send('memory test: find Nils Frahm again')
  await idle()
  await new Promise((r) => setTimeout(r, 1000))
  check(summaries().length === 1, 'a plugin action in that chat is not summarized')
  await w.screenshot({ path: `${SHOTS}/step2-05-memory-off-chat.png` })

  step('Remember automatically off')
  await w.click('button[title=Settings]')
  await w.uncheck('input[aria-label="Remember automatically"]')
  check(
    (await w.locator('text=nothing new is saved').count()) === 1,
    'the setting explains what turning it off does'
  )
  await w.screenshot({ path: `${SHOTS}/step2-06-memory-setting.png` })
  await w.click('button:text-is("Done")')
  await newChat()
  await send('memory test: find Nils Frahm, third time')
  await idle()
  check(
    await until(async () => /Remember automatically is off/.test(await status())),
    `the chat says why it was not saved (${await status()})`
  )
  check(summaries().length === 1, 'nothing was summarized')
  check(
    JSON.stringify(chatRequests().at(-1)?.system).includes('Automatic memory is off'),
    'and the model is told memory is off'
  )

  step('Vault missing: waits, then saves after a restart')
  await w.click('button[title=Settings]')
  await w.check('input[aria-label="Remember automatically"]')
  await w.click('button:text-is("Done")')
  fs.renameSync(`${OUT}/vault`, `${OUT}/vault-away`)
  await newChat()
  await send('memory test: find Nils Frahm while the vault is away')
  await idle()
  check(
    await until(async () => /vault isn't available/.test(await status())),
    `the chat says it is waiting for the vault (${await status()})`
  )
  check(summaries().length === 1, 'no summary is made while the vault is missing')
  // Quit hard, as a crash would.
  app.process().kill('SIGKILL')
  fs.renameSync(`${OUT}/vault-away`, `${OUT}/vault`)
  ;({ app, w } = await launch())
  // The test's key store only opens after launch, so the waiting capture
  // goes ahead with the next turn (as it would after a key is added).
  await send('hello again')
  await idle()
  check(
    await until(
      () =>
        conversations().find((c) => c.title.startsWith('memory test: find Nils Frahm while'))
          ?.memory?.job?.status === 'saved'
    ),
    'after the restart and the next turn, with the vault back, it was saved'
  )
  check(summaries().length === 2, 'with one more summary call')
  check(
    note('Custard/Plugins/Spotify/Activity.md').split('\n### ').length === 3,
    "Spotify's Activity.md now has two entries"
  )
  check(
    fs.existsSync(`${OUT}/vault/Custard/.custard-vault-id`),
    'the vault has an id, so waiting captures only go back to it'
  )

  step('Per-plugin switch, then turning the plugin off')
  await w.click('button[title=Settings]')
  await w.click('button:text-is("Plugins")')
  await w.click('button:has-text("Spotify")')
  await w.uncheck('input[aria-label="Remember activity for Spotify"]')
  check(
    (await w.locator('text=its actions are left out of what Custard remembers').count()) === 1,
    'the plugin setting explains what turning it off does'
  )
  await w.screenshot({ path: `${SHOTS}/step2-07-plugin-memory.png` })
  await w.click('button:text-is("Done")')
  await newChat()
  await send('memory test: find Nils Frahm once more')
  await idle()
  await new Promise((r) => setTimeout(r, 1000))
  check(summaries().length === 2, "Spotify's actions are no longer remembered")
  await w.click('button[title=Settings]')
  await w.click('button:text-is("Plugins")')
  await w.click('button:has-text("Spotify")')
  await w.click('button:text-is("Disable")')
  check(
    await until(() =>
      note('Custard/Plugins/Spotify/Overview.md').includes(
        'turned off in Custard (its notes are kept)'
      )
    ),
    'turning Spotify off is noted in its Overview, and its notes stay'
  )
} catch (e) {
  await w.screenshot({ path: `${SHOTS}/memory-fail.png` }).catch(() => {})
  console.log(e)
  process.exitCode = 1
}
await app.close().catch(() => {})
console.log('\ne2e done, exit', process.exitCode ?? 0)
