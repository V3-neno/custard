// Automatic memory in the built app, against test/e2e/interrupt-mock.mjs: a
// chat with a plugin action is remembered without being asked, a later chat
// sees it, small talk isn't saved, a one-message preference is, Forget
// deletes what a chat saved, the per-chat and global switches stop it, and a
// capture waiting for a missing vault is saved after a restart.
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
const captures = () => {
  try {
    return fs.readdirSync(`${OUT}/vault/Custard/Captures`).sort()
  } catch {
    return []
  }
}
const capture = (f) => note(`Custard/Captures/${f}`)
const SPOTIFY = 'Custard/Plugins/Spotify/Activity'
const pluginNotes = () => {
  try {
    return fs.readdirSync(`${OUT}/vault/${SPOTIFY}`).sort()
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
    // Confirmations: remember what was asked, answer the second button.
    globalThis.__asked = []
    dialog.showMessageBox = async (...args) => {
      const o = args.at(-1)
      globalThis.__asked.push({ message: o.message, detail: o.detail })
      return { response: 1, checkboxChecked: false }
    }
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
// What became of a chat's latest capture, from the saved chat.
const chat = (start) => conversations().find((c) => c.title.startsWith(start))
const job = (start) => chat(start)?.memory?.job
const tempSwitch = '[aria-label="Temporary chat"]'
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
    await until(() => job('memory test: I like warm jazz')?.status === 'saved'),
    `it was saved (${job('memory test: I like warm jazz')?.status})`
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
  check(captures().length === 1, `one new note in Custard/Captures (${captures().join(', ')})`)
  const main = capture(captures()[0] ?? 'missing')
  check(
    main.includes('custard-capture:') &&
      main.includes('Custard writes this note once and never changes it') &&
      main.includes('## Preferences\n\n- Prefers warm jazz') &&
      !main.includes('### Looked up Nils Frahm'),
    'it holds the general preference; the Spotify activity goes to the plugin'
  )
  check(pluginNotes().length === 1, `one new note in ${SPOTIFY} (${pluginNotes().join(', ')})`)
  const act = note(`${SPOTIFY}/${pluginNotes()[0] ?? 'missing'}`)
  check(
    act.includes('plugin: "spotify"') &&
      act.includes('### Looked up Nils Frahm') &&
      act.includes('- Plugin: Spotify') &&
      act.includes(': ran: the tool returned a result'),
    'it is readable, with the action as Custard recorded it'
  )
  check(
    act.includes('- Checked afterwards: nothing checked it') &&
      act.includes('- Requested outcome: not checked') &&
      !act.includes('it worked'),
    'the summary claimed success without a check, and that is not written down'
  )
  const overview = note('Custard/Plugins/Spotify/Overview.md')
  check(
    /^---\ncustard-plugin-id: spotify\n---/.test(overview) &&
      overview.includes('treat it as a claim'),
    "on first use, Spotify got its own folder, identified by id, with its description marked as the plugin's claim"
  )
  check(
    note('Custard/Memory.md') === ownMemory && !fs.existsSync(`${OUT}/vault/Custard/Activity.md`),
    "Memory.md is the user's and is not touched, and there is no shared Activity note"
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
  check(!job('hello'), 'and nothing was captured from it')
  check((await w.locator('[aria-label="Memory status"]').count()) === 0, 'there is no memory bar')

  await send('Did spotify find what I asked for earlier?')
  await idle()
  const sys2 = JSON.stringify(chatRequests().at(-1)?.system)
  check(
    sys2.includes('<plugin-notes plugin=\\"Spotify\\"') &&
      sys2.includes('Looked up Nils Frahm') &&
      sys2.includes('Requested outcome: not checked') &&
      sys2.includes('Current state in Custard: enabled'),
    'naming Spotify brings its notes from the earlier chat, with its state now'
  )
  check(summaries().length === 1, 'and asking about it is not itself summarized')

  step('A preference in a one-message chat is remembered')
  await newChat()
  await send('From now on I prefer short answers')
  await idle()
  check(
    await until(() => job('From now on I prefer')?.status === 'saved'),
    'saved after one message, with no action'
  )
  check(summaries().length === 2, 'with one summary call')
  const prefNote = captures().find((f) => capture(f).includes('Prefers short answers'))
  check(!!prefNote, 'in a new note of its own')
  check(
    / [0-9a-f]{8}\.md$/.test(prefNote ?? ''),
    `its name ends with an id from the capture, not only the minute (${prefNote})`
  )

  step('Forget this chat, from the history')
  await w.click('button[title="Chat history"]')
  const row = w.locator('div.group:has-text("From now on I prefer")')
  await row.hover()
  await row.locator('button:text-is("Forget")').click()
  check(
    await until(() => chat('From now on I prefer')?.memory?.forgotten === true),
    'the chat is forgotten'
  )
  await w.screenshot({ path: `${SHOTS}/step2-05b-history-forget.png` })
  await w.click('div.group:has-text("From now on I prefer") >> nth=0')
  const asked = await app.evaluate(() => globalThis.__asked.at(-1))
  check(
    asked?.message === 'Forget this chat?' && asked.detail.includes(`Custard/Captures/${prefNote}`),
    'it asked first, listing the note it would delete'
  )
  check(!captures().includes(prefNote), 'the note is deleted')
  check(captures().length === 1, "and the other chat's note is kept")
  await send('I prefer long answers again, remember that')
  await idle()
  await new Promise((r) => setTimeout(r, 1000))
  check(summaries().length === 2, 'a later preference in that chat is not summarized')

  step('Temporary chat')
  await newChat()
  check(
    (await w.getAttribute(tempSwitch, 'aria-checked')) === 'false',
    'a new chat is not temporary by default'
  )
  await w.click(tempSwitch)
  check(
    (await w.getAttribute(tempSwitch, 'aria-checked')) === 'true',
    'the header switch says the chat is temporary'
  )
  await w.screenshot({ path: `${SHOTS}/step2-05-temporary-chat.png` })
  await send('memory test: find Nils Frahm in a temporary chat')
  await idle()
  await new Promise((r) => setTimeout(r, 1000))
  check(summaries().length === 2, 'a plugin action in a temporary chat is not summarized')
  check(
    chat('memory test: find Nils Frahm in a temporary')?.memory?.temporary === true,
    'it is saved as temporary from its first message'
  )
  check(
    JSON.stringify(chatRequests().at(-1)?.system).includes('Automatic memory is off'),
    'and the model is told it is not remembered'
  )
  // The switch and the chat change after React re-renders (the chat is
  // cleared in an effect), so wait for that state rather than reading it
  // straight after the click.
  await w.click(tempSwitch)
  check(
    await until(
      async () =>
        (await w.getAttribute(tempSwitch, 'aria-checked')) === 'false' &&
        (await w.locator('text=memory test: find Nils Frahm in a temporary').count()) === 0,
      5000
    ),
    'switching it off starts a new, normal chat'
  )
  await w.click('button[title="Chat history"]')
  check(
    (await w
      .locator('div.group:has-text("in a temporary chat") >> span:has(svg):has-text("Temporary")')
      .count()) === 1,
    'the history marks it as temporary'
  )
  // Opening a chat loads it over IPC first; the switch follows the loaded chat.
  await w.click('div.group:has-text("in a temporary chat") >> nth=0')
  await w.waitForSelector('text=memory test: find Nils Frahm in a temporary chat', {
    timeout: 15000
  })
  check(
    await until(async () => (await w.getAttribute(tempSwitch, 'aria-checked')) === 'true', 5000),
    'opening it again shows the switch on'
  )

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
    await until(
      () => job('memory test: find Nils Frahm, third')?.reason === 'Remember automatically is off.'
    ),
    'the chat records why it was not saved'
  )
  check(summaries().length === 2, 'nothing was summarized')
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
    await until(() =>
      /vault isn't available/.test(job('memory test: find Nils Frahm while')?.reason ?? '')
    ),
    'the capture waits for the vault'
  )
  check(summaries().length === 2, 'no summary is made while the vault is missing')
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
  check(summaries().length === 3, 'with one more summary call')
  check(pluginNotes().length === 2, "in a second note in Spotify's Activity folder")
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
  check(summaries().length === 3, "Spotify's actions are no longer remembered")
  const overviewBefore = note('Custard/Plugins/Spotify/Overview.md')
  await w.click('button[title=Settings]')
  await w.click('button:text-is("Plugins")')
  await w.click('button:has-text("Spotify")')
  await w.click('button:text-is("Disable")')
  await w.click('button:text-is("Done")')
  await newChat()
  await send('What happened with spotify before?')
  await idle()
  const sys3 = JSON.stringify(chatRequests().at(-1)?.system)
  check(
    sys3.includes('Current state in Custard: turned off in Custard (its notes are kept)'),
    'turning Spotify off reaches the model from the app'
  )
  check(
    note('Custard/Plugins/Spotify/Overview.md') === overviewBefore && pluginNotes().length === 2,
    'and its notes stay exactly as they were'
  )
} catch (e) {
  await w.screenshot({ path: `${SHOTS}/memory-fail.png` }).catch(() => {})
  console.log(e)
  process.exitCode = 1
}
await app.close().catch(() => {})
console.log('\ne2e done, exit', process.exitCode ?? 0)
