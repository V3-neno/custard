// Step 5 privacy regression in the built app, against test/e2e/interrupt-mock.mjs:
// text from an attached file reaches a Spotify search query (and so the
// action's label), the search result, and a "Continue in a new chat"
// summary. None of it may reach the memory summarizer or a saved note.
// Usage, from the repo root after `npx electron-vite build`:
//   node test/e2e/interrupt-mock.mjs <out> &   (with <out>/plugin and <out>/vault as for memory.mjs)
//   node test/e2e/attachments-leak.mjs <out> <screenshot dir>
// Linux only as written, with a display or xvfb-run. Needs the playwright package.
import { _electron as electron } from 'playwright'
import { createRequire } from 'module'
import fs from 'fs'
import path from 'path'

const [, , OUT, SHOTS] = process.argv
const check = (cond, what) => {
  console.log((cond ? '✓ ' : '✕ ') + what)
  if (!cond) process.exitCode = 1
}
const step = (s) => console.log('\n## ' + s)
const CFG = OUT + '/cfg-leak'
const FILES = OUT + '/files-leak'
fs.mkdirSync(FILES, { recursive: true })
const FILE = 'Osprey-Notes-8890.md'
const SECRET = 'LEAK-OSPREY-5521 velvet anchor'
const FORBIDDEN = /osprey|8890|5521|velvet anchor|LEAK-/i
fs.writeFileSync(`${FILES}/${FILE}`, `${SECRET}\nSecond line of the synthetic file.\n`)

const read = (f, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(OUT + f, 'utf8'))
  } catch {
    return fallback
  }
}
const summaries = () => read('/memory.json', [])
const conversations = () => {
  const dir = `${CFG}/custard/conversations`
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(`${dir}/${f}`, 'utf8')))
}
const until = async (f, ms = 15000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await f()) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}
const vaultFiles = (dir = `${OUT}/vault`) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    return e.isDirectory() ? vaultFiles(p) : [{ p, text: fs.readFileSync(p, 'utf8') }]
  })
const vaultBefore = new Set(vaultFiles().map((f) => f.p))

async function launch() {
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
  await app.evaluate(({ safeStorage, dialog, shell }, vault) => {
    safeStorage.setUsePlainTextEncryption?.(true)
    globalThis.__pick = null
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: globalThis.__pick ?? [vault]
    })
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
const byId = (id) => conversations().find((c) => c.id === id)
const labelsOf = (c) => Object.values(c?.actions ?? {}).map((a) => `${a.label} ${a.result ?? ''}`)

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
  // Chat, Design and Skills use a plugin only once it's turned on for them.
  await w.click('label:has-text("in Chat, Design and Skills") input[type=checkbox]')
  await w.waitForSelector('label:has-text("in Chat, Design and Skills") input:checked')
  await w.click('button:text-is("Done")')

  step('A chat with a file whose text reaches an answer, a search query, its label and its result')
  await app.evaluate((_, p) => (globalThis.__pick = p), [`${FILES}/${FILE}`])
  await w.click('button[aria-label="Attach files"]')
  await w.waitForSelector('[aria-label="Files to send"] li')
  await app.evaluate(() => (globalThis.__pick = null))
  await send('quote test: what does the file say?')
  await idle()
  await send('leak test: search Spotify for the first line')
  await idle()
  const a = conversations().find((c) => c.title.startsWith('quote test'))
  check(
    labelsOf(a).some(
      (l) =>
        l.includes('Searched Spotify for "LEAK-OSPREY-5521') &&
        l.includes('Echo of LEAK-OSPREY-5521')
    ),
    'the search label and its result both hold the file text (the leak route is exercised)'
  )
  check(
    await until(() => byId(a.id)?.memory?.job?.status === 'saved'),
    `the chat was remembered (${byId(a.id)?.memory?.job?.status})`
  )
  const evA = summaries().at(-1)?.evidence ?? ''
  check(!FORBIDDEN.test(evA), 'the summarizer got no file name or text')
  check(
    /- A1: spotify__search \[spotify__search, plugin spotify, read-only\] → completed$/m.test(evA),
    'the action went as its tool name and recorded status only'
  )

  step('Continue in a new chat: the summary repeats the file text')
  await send('too long test')
  await w.waitForSelector('[aria-label="Chat length"] button:has-text("Continue in a new chat")', {
    timeout: 30000
  })
  await w.click('[aria-label="Chat length"] button:has-text("Continue in a new chat")')
  await w.waitForSelector('[aria-label="Continued chat"]', { timeout: 30000 })
  const b0 = conversations().find((c) => c.continuedFrom?.from.id === a.id)
  check(
    (b0?.continuedFrom?.summary?.state ?? '').includes('LEAK-OSPREY-5521'),
    'the continuation summary holds the file text (the leak route is exercised)'
  )
  const calls = summaries().length
  await send('carry test: search Spotify for what the summary says')
  await idle()
  check(
    labelsOf(byId(b0.id)).some((l) => l.includes('LEAK-OSPREY-5521')),
    "the new chat's search label holds the text from the summary"
  )
  check(
    await until(() => byId(b0.id)?.memory?.job?.status === 'saved'),
    `the continued chat was remembered (${byId(b0.id)?.memory?.job?.status})`
  )
  const evB = summaries()
    .slice(calls)
    .map((s) => s.evidence)
    .join('\n')
  check(
    evB.length > 0 && !FORBIDDEN.test(evB),
    "the continued chat's evidence held no file name or text"
  )

  step('Saved notes')
  const all = summaries()
    .map((s) => s.evidence)
    .join('\n')
  check(
    !FORBIDDEN.test(all),
    `no summarizer call at all saw the file (${summaries().length} calls)`
  )
  const added = vaultFiles().filter((f) => !vaultBefore.has(f.p))
  check(added.length >= 2, `capture notes were saved (${added.length})`)
  check(
    vaultFiles().every((f) => !FORBIDDEN.test(f.text) && !FORBIDDEN.test(f.p)),
    'no note or note name in the vault holds the file name or text'
  )
  check(
    added.some((f) =>
      f.text.includes('This chat had attached files, so this note was made only from')
    ),
    'the notes say why their details were left out'
  )
} catch (err) {
  console.log('error:', err.message)
  await w.screenshot({ path: `${SHOTS}/step5-leak-error.png` }).catch(() => {})
  process.exitCode = 1
} finally {
  await app.close()
}
console.log('\ne2e done, exit', process.exitCode ?? 0)
