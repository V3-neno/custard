// Background sync (Spotify 1.6.0 sync_recent) in the built app, against
// test/e2e/interrupt-mock.mjs: the review asks for it, it is off until turned
// on, Custard then calls it by itself (a minute after turning on) and the
// recently played tracks land in the event log once each; the model is never
// offered the tool. Usage as for widgets.mjs:
//   node test/e2e/background-sync.mjs <out> <screenshot dir>
// Linux only as written, with a display or xvfb-run. Needs the playwright package.
// Takes about two minutes: it waits for real scheduled calls.
import { _electron as electron } from 'playwright'
import { appLaunch } from '../platform/launch.mjs'
import fs from 'fs'

const [, , OUT, SHOTS] = process.argv
const check = (cond, what) => {
  console.log((cond ? '✓ ' : '✕ ') + what)
  if (!cond) process.exitCode = 1
}
const step = (s) => console.log('\n## ' + s)
const CFG = OUT + '/cfg-sync'
fs.rmSync(CFG, { recursive: true, force: true })
const read = (f, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'))
  } catch {
    return fallback
  }
}
const anth = () => read(OUT + '/anthropic.json', [])
const spotifyCalls = () => read(OUT + '/spotify.json', []).map((x) => `${x.method} ${x.path}`)
const until = async (f, ms = 15000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await f()) return true
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
}
const eventNotes = () => {
  const root = `${OUT}/vault/Custard/Plugins/Spotify/Events`
  if (!fs.existsSync(root)) return ''
  return fs
    .readdirSync(root, { recursive: true })
    .filter((f) => f.endsWith('.md'))
    .map((f) => fs.readFileSync(`${root}/${f}`, 'utf8'))
    .join('\n')
}
const played = () => (eventNotes().match(/"type":"played"/g) ?? []).length

const app = await electron.launch({
  ...appLaunch(),
  env: {
    ...process.env,
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:8899',
    XDG_CONFIG_HOME: CFG,
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
let w = null
for (let i = 0; !w && i < 300; i++) {
  w = app.windows().find((x) => x.url().endsWith('/renderer/index.html')) ?? null
  if (!w) await new Promise((r) => setTimeout(r, 100))
}
await w.setViewportSize({ width: 1280, height: 900 })
w.on('pageerror', (e) => console.log('pageerror:', e.message))
await w.waitForSelector('text=Custard')

const openPlugins = async () => {
  await w.click('button[title][class*="rounded-full"]:text-is("Plugins")')
  if (!(await w.locator('text=What Custard can reach').count()))
    await w.click('button[title][class*="rounded-full"]:text-is("Plugins")')
  await w.waitForSelector('text=What Custard can reach')
}

try {
  step('Setup: key, vault, Spotify 1.6.0')
  await w.click('button[title=Settings]')
  await w.fill('input[aria-label="Claude API key"]', 'sk-ant-test')
  await w.press('input[aria-label="Claude API key"]', 'Enter')
  await w.click('button:has-text("Use an existing vault")')
  await w.waitForSelector('text=· connected')
  await w.click('button:text-is("Done")')
  await openPlugins()
  await w.click('article[aria-label="Plugin Spotify"] button:text-is("Manage")')
  await w.click('button:has-text("Review and activate")')
  await w.waitForSelector('text=New permissions to approve', { timeout: 30000 })
  check(
    await w.locator('text=Run its "sync_recent" tool by itself every 30 minutes').isVisible(),
    'the review asks for background sync in plain words'
  )
  const boxes = w.locator('section:has-text("New permissions to approve") input[type=checkbox]')
  for (let i = 0; i < (await boxes.count()); i++) await boxes.nth(i).check()
  await w.click('button:text-matches("^Activate [0-9]")')
  await w.waitForSelector('text=Save configuration', { timeout: 30000 })
  await w.fill('input[aria-label="Client ID"]', '0123456789abcdef0123456789abcdef')
  await w.click('button:has-text("Save configuration")')
  await w.click('button:text-is("Connect")')
  await w.waitForSelector('text=· connected', { timeout: 15000 })
  await w.click('label:has-text("in Chat, Design and Skills") input[type=checkbox]')
  await w.waitForSelector('label:has-text("in Chat, Design and Skills") input:checked')

  step('Off by default')
  const box = w.locator('input[aria-label="Background sync for Spotify"]')
  check(!(await box.isChecked()), 'approving it left background sync off')
  await new Promise((r) => setTimeout(r, 2000))
  check(
    !spotifyCalls().includes('GET /v1/me/player/recently-played'),
    'nothing was requested while it is off'
  )

  step('Turned on, with the event log on')
  await w.locator('[data-event-log] input[type=checkbox]').click()
  await w.waitForSelector('[data-event-log-status]:has-text("Logging on")')
  await box.click()
  await w.waitForSelector('[data-background-sync-status]:has-text("first call")')
  check(true, 'Manage says the first call is coming')
  await w.locator('[data-background-sync]').screenshot({ path: SHOTS + '/sync-01-manage.png' })
  check(
    await until(() => played() === 2, 120000),
    'Custard called it by itself, and both recent plays are in the event note'
  )
  const note = eventNotes()
  check(/"source":"recently_played"/.test(note), 'marked as from recently played')
  check(note.indexOf('Synced 1') < note.indexOf('Synced 2'), 'oldest first')
  check(
    spotifyCalls().filter((c) => c === 'GET /v1/me/player/recently-played').length === 1,
    'one request, and no playback reads for it'
  )
  check(!/Bearer|access_token|refresh_token/.test(note), 'no token in the log')
  // Manage refreshes on its own actions; reopen it to read the status.
  await w.click('[role=dialog] button:text-is("Done")')
  await w.click('article[aria-label="Plugin Spotify"] button:text-is("Manage")')
  await w.waitForSelector('[data-background-sync-status]:has-text("1 call today")')
  check(true, 'Manage shows the last call and the count')
  await w.locator('[data-background-sync]').screenshot({ path: SHOTS + '/sync-02-done.png' })
  await w.click('[role=dialog] button:text-is("Done")')
  check(
    await w
      .locator('article[aria-label="Plugin Spotify"] >> text=Syncing in background')
      .isVisible(),
    'the hub card says it syncs in the background'
  )

  step('Never offered to a model')
  await w.click('button[title][class*="rounded-full"]:text-is("Chat")')
  await w.fill('textarea', 'plain after sync')
  await w.keyboard.press('Enter')
  await w.waitForSelector('button[title=Send]', { timeout: 30000 })
  const tools = anth()
    .filter((r) => typeof r.system !== 'string')
    .at(-1)?.tools
  check(
    Array.isArray(tools) &&
      tools.includes('spotify__recently_played') &&
      !tools.includes('spotify__sync_recent'),
    'the chat gets recently_played but not sync_recent'
  )

  step('Turned off')
  await openPlugins()
  await w.click('article[aria-label="Plugin Spotify"] button:text-is("Manage")')
  await w.locator('input[aria-label="Background sync for Spotify"]').click()
  check(
    await until(async () => !(await w.locator('[data-background-sync-status]').count())),
    'Manage no longer shows it syncing'
  )
} finally {
  await app.close()
  console.log('e2e done, exit', process.exitCode ?? 0)
}
