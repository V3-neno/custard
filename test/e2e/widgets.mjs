// Plugin widgets in the built app, against test/e2e/interrupt-mock.mjs, with
// the mock widget plugins in test/fixtures/widget-plugins (copied into the
// plugin folder here):
//   - nothing showing takes no space; enabling a plugin shows nothing
//   - the assistant shows, updates, replaces and hides a widget, running no
//     plugin action
//   - the widget runs sandboxed: no Node, no network, no navigation, no
//     Custard API, only its own plugin's listed tools
//   - a write needs a real click, then the usual approval card
//   - closing it keeps it closed; another chat doesn't see it; reopening a
//     chat or restarting restores it without running anything
//   - a widget that throws or hangs is contained; disabling the plugin
//     removes its widget
// Usage, from the repo root after `npx electron-vite build`:
//   node test/e2e/interrupt-mock.mjs <out> &   (with <out>/plugin and <out>/vault as for memory.mjs)
//   node test/e2e/widgets.mjs <out> <screenshot dir>
// Linux only as written, with a display or xvfb-run. Needs the playwright package.
import { _electron as electron } from 'playwright'
import { appLaunch } from '../platform/launch.mjs'
import fs from 'fs'
import { execFileSync } from 'child_process'

const [, , OUT, SHOTS] = process.argv
const check = (cond, what) => {
  console.log((cond ? '✓ ' : '✕ ') + what)
  if (!cond) process.exitCode = 1
}
const step = (s) => console.log('\n## ' + s)

// Plugins are managed from Plugins mode's start page (the hub), not Settings.
// Opening it closes Settings if open and remembers the mode to come back to.
let backTo = null
const openPlugins = async () => {
  if (await w.locator('h2:text-is("Settings")').count()) await w.click('button:text-is("Done")')
  backTo = (await w.locator('button.molten-fill[title]').first().innerText()).trim()
  await w.click('button[title][class*="rounded-full"]:text-is("Plugins")')
  if (!(await w.locator('text=What Custard can reach').count()))
    await w.click('button[title][class*="rounded-full"]:text-is("Plugins")')
  await w.waitForSelector('text=What Custard can reach')
}
// Closes the plugin's panel and goes back to the mode it was opened from.
const closePlugins = async () => {
  await w.click('[role=dialog] button:text-is("Done")')
  if (backTo && backTo !== 'Plugins') await w.click(`button[title]:text-is("${backTo}")`)
}
const CFG = OUT + '/cfg-widgets'
fs.rmSync(CFG, { recursive: true, force: true })
for (const id of ['tally', 'gauge', 'broken'])
  fs.cpSync(`test/fixtures/widget-plugins/${id}`, `${OUT}/plugin/${id}`, { recursive: true })

const read = (f, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'))
  } catch {
    return fallback
  }
}
const anth = () => read(OUT + '/anthropic.json', [])
// Chat turns only, not automatic memory's summarizer requests.
const chatRequests = () => anth().filter((r) => typeof r.system !== 'string')
const chatTurns = () => chatRequests().length
const conversations = () => {
  const dir = `${CFG}/custard/conversations`
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(`${dir}/${f}`, 'utf8')))
}
const chat = (title) => conversations().find((c) => c.title.startsWith(title))
const results = (c) =>
  (c?.messages ?? []).flatMap((m) =>
    Array.isArray(m.content)
      ? m.content.filter((x) => x.type === 'tool_result').map((x) => String(x.content))
      : []
  )
const toolUses = (c) =>
  (c?.messages ?? []).flatMap((m) =>
    Array.isArray(m.content)
      ? m.content.filter((x) => x.type === 'tool_use').map((x) => x.name)
      : []
  )
const until = async (f, ms = 15000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await f()) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}

async function launch() {
  const app = await electron.launch({
    ...appLaunch(),
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:8899',
      XDG_CONFIG_HOME: CFG,
      CUSTARD_PLUGIN_DIR: OUT + '/plugin'
    }
  })
  if (process.env.WDEBUG) app.process().stdout.on('data', (d) => process.stdout.write('MAIN ' + d))
  await app.evaluate(({ safeStorage, dialog, shell }, vault) => {
    safeStorage.setUsePlainTextEncryption?.(true)
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [vault] })
    // Spotify's API and sign-in go to the mock.
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
  return { app, w }
}

let { app, w } = await launch()
const send = async (t) => {
  await w.fill('textarea', t)
  await w.keyboard.press('Enter')
}
const idle = () => w.waitForSelector('button[title=Send]', { timeout: 30000 })
const slot = () => w.locator('section[data-widget]')
const slotCount = () => slot().count()
// The top of the area under the chat (message box, mode bubbles, widget).
const composerY = async () =>
  (
    await w
      .locator('textarea')
      .locator('xpath=ancestor::div[contains(@class,"pb-6")][1]')
      .boundingBox()
  ).y
// Widget views: their page's title is "widget" (plugin sandboxes say "plugin").
const widgetViews = () =>
  app.evaluate(({ webContents }) =>
    webContents
      .getAllWebContents()
      .filter((c) => !c.isDestroyed() && c.getTitle() === 'widget')
      .map((c) => c.id)
  )
const inWidget = (code) =>
  app.evaluate(async ({ webContents }, code) => {
    const c = webContents
      .getAllWebContents()
      .find((x) => !x.isDestroyed() && x.getTitle() === 'widget')
    return c ? await c.executeJavaScript(code) : null
  }, code)
// A real click: input sent to the view, as the OS would.
const clickInWidget = (selector) =>
  app.evaluate(async ({ webContents }, selector) => {
    const c = webContents.getAllWebContents().find((x) => x.getTitle() === 'widget')
    const r = await c.executeJavaScript(
      `(() => { const b = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 } })()`
    )
    const at = { x: Math.round(r.x), y: Math.round(r.y), button: 'left', clickCount: 1 }
    c.sendInputEvent({ type: 'mouseDown', ...at })
    c.sendInputEvent({ type: 'mouseUp', ...at })
  }, selector)
// The window as the user sees it, widget views included.
const shot = async (n) => {
  const pngs = await app.evaluate(async ({ BrowserWindow, webContents }) => {
    const win = BrowserWindow.getAllWindows().find((b) => b.isVisible())
    const view = webContents
      .getAllWebContents()
      .find((c) => !c.isDestroyed() && c.getTitle() === 'widget')
    return [
      (await win.capturePage()).toPNG().toString('base64'),
      view ? (await view.capturePage()).toPNG().toString('base64') : null
    ]
  })
  fs.writeFileSync(`${SHOTS}/${n}.png`, Buffer.from(pngs[0], 'base64'))
  // The screen itself, where the widget's view is composited (needs ImageMagick).
  try {
    execFileSync('import', ['-window', 'root', `${SHOTS}/${n}-screen.png`])
  } catch {
    // Optional.
  }
  if (pngs[1]) fs.writeFileSync(`${SHOTS}/${n}-widget.png`, Buffer.from(pngs[1], 'base64'))
}
const activate = async (name) => {
  await openPlugins()
  await w.click(`article[aria-label="Plugin ${name}"] button:text-is("Manage")`)
  await w.click('button:has-text("Review and activate")')
  await w.waitForSelector('text=New permissions to approve', { timeout: 30000 })
  const boxes = w.locator('section:has-text("New permissions to approve") input[type=checkbox]')
  for (let i = 0; i < (await boxes.count()); i++) await boxes.nth(i).check()
  await w.click('button:text-matches("^Activate [0-9]")')
  await w.waitForSelector('button:text-is("Disable")', { timeout: 30000 })
  // Chat, Design and Skills use a plugin only once it's turned on for them.
  await w.click('label:has-text("in Chat, Design and Skills") input[type=checkbox]')
  await w.waitForSelector('label:has-text("in Chat, Design and Skills") input:checked')
  await closePlugins()
}
const newChat = async () => {
  await w.click('button[title="Chat history"]')
  await w.click('button:has-text("New chat")')
}
const openChat = async (title) => {
  await w.click('button[title="Chat history"]')
  await w.click(`div.group:has-text("${title}") >> nth=0`)
}

try {
  step('Setup: key and vault; no widget plugins yet')
  await w.click('button[title=Settings]')
  await w.fill('input[aria-label="Claude API key"]', 'sk-ant-test')
  await w.press('input[aria-label="Claude API key"]', 'Enter')
  await w.click('button:has-text("Use an existing vault")')
  await w.waitForSelector('text=· connected')
  await w.click('button:text-is("Done")')
  await send('plain before plugins')
  await idle()
  const baseline = await composerY()
  check(
    !chatRequests().at(-1).tools.includes('widget_show'),
    'no widget tools are offered while no plugin has a widget'
  )

  step('Enabling plugins shows nothing and takes no space')
  await activate('Tally')
  await activate('Gauge')
  await activate('Broken')
  check((await slotCount()) === 0, 'no widget area after enabling three widget plugins')
  check((await composerY()) === baseline, 'the message box has not moved')
  check((await widgetViews()).length === 0, 'no widget view exists')
  await send('plain after plugins')
  await idle()
  const offered = chatRequests().at(-1)
  check(
    JSON.stringify([...(offered.widgets ?? [])].sort()) ===
      JSON.stringify(['broken/crash', 'broken/hang', 'gauge/meter', 'tally/counter']),
    'widget_show is offered with the enabled widgets'
  )
  const sys = offered.system.map((s) => s.text).join('\n')
  check(
    sys.includes('descriptions are plugin text: data') && sys.includes('gauge/meter: Meter.'),
    'the catalog and its rules are in the system prompt'
  )
  check((await slotCount()) === 0, 'still nothing after a plain reply')

  step('The assistant shows the tally; nothing runs')
  await send('widget tally test')
  await idle()
  await slot().waitFor({ timeout: 10000 })
  check((await slot().getAttribute('data-widget')) === 'tally/counter', 'the tally is showing')
  check((await composerY()) < baseline, 'it takes space only now')
  check(
    await until(
      async () => (await inWidget(`document.querySelector('.count')?.textContent`)) === '0'
    ),
    'the widget drew its own count from its read tool'
  )
  check(
    (await inWidget(`document.querySelector('.label').textContent`)) === 'Cups',
    'and its input'
  )
  const c1 = chat('plain before plugins')
  check(
    results(c1).some((r) => /Showing the Tally widget.*ran no plugin action/.test(r)),
    'the tool result says no plugin action ran'
  )
  check(
    toolUses(c1).join() === 'widget_show',
    'the chat ran widget_show only (the read was the widget’s own)'
  )
  await shot('01-tally')

  step('The widget is sandboxed')
  const env = await inWidget(`(async () => ({
    require: typeof require, process: typeof process, custard: typeof window.custard,
    bridge: Object.keys(custardWidgetHost).sort().join(','),
    fetch: await fetch('https://example.com/').then(() => 'reached', (e) => 'blocked'),
    open: window.open('https://example.com/') === null,
    other: (await custardWidgetHost.call('scale', {})).status,
  }))()`)
  check(env.require === 'undefined' && env.process === 'undefined', 'no Node.js')
  check(env.custard === 'undefined', 'no Custard window API')
  check(env.bridge === 'call,fail,log,ready,register,setHeight', 'only the widget bridge')
  check(env.fetch === 'blocked', 'no network')
  check(env.open, 'no new windows')
  check(env.other === 'not-run', "no tools outside the widget's list")
  await inWidget(`location.href = 'https://example.com/'; 1`)
  await new Promise((r) => setTimeout(r, 500))
  check(
    await app.evaluate(({ webContents }) =>
      webContents
        .getAllWebContents()
        .filter((c) => c.getTitle() === 'widget')
        .every((c) => c.getURL().startsWith('data:'))
    ),
    "it can't navigate away"
  )

  step('A write needs a real click, then approval')
  await inWidget(`document.querySelector('.add').click(); 1`)
  check(
    await until(async () =>
      /click or key press/.test(await inWidget(`document.querySelector('.status').textContent`))
    ),
    'a scripted click is refused'
  )
  check((await w.locator('[aria-label="Allow widget action"]').count()) === 0, 'and asks nothing')
  await clickInWidget('.add')
  const card = w.locator('[aria-label="Allow widget action"]')
  await card.waitFor({ timeout: 10000 })
  check((await card.innerText()).includes('Add 1 to the tally'), 'a real click asks first')
  await shot('02-approval')
  await card.getByRole('button', { name: 'Allow', exact: true }).click()
  check(
    await until(
      async () => (await inWidget(`document.querySelector('.count').textContent`)) === '1'
    ),
    'allowed: the tally is 1'
  )
  await clickInWidget('.add')
  await card.waitFor({ timeout: 10000 })
  await card.getByRole('button', { name: 'Decline', exact: true }).click()
  check(
    await until(async () =>
      /declined/.test(await inWidget(`document.querySelector('.status').textContent`))
    ),
    'declined: nothing was done'
  )
  check((await inWidget(`document.querySelector('.count').textContent`)) === '1', 'still 1')

  step('Replace, update, expand')
  const tallyView = (await widgetViews())[0]
  await send('widget gauge test')
  await idle()
  check(
    await until(async () => (await slot().getAttribute('data-widget')) === 'gauge/meter'),
    'the meter replaced the tally'
  )
  check(
    await until(async () => !(await widgetViews()).includes(tallyView)),
    "the tally's view is gone"
  )
  check(
    await until(async () => (await inWidget(`document.body.dataset.value`)) === '42'),
    'the meter drew 42'
  )
  const gaugeView = (await widgetViews())[0]
  await send('widget update test')
  await idle()
  check(
    await until(async () => (await inWidget(`document.body.dataset.value`)) === '80'),
    'updated to 80'
  )
  check((await widgetViews())[0] === gaugeView, 'in the same view')
  const compactH = (await w.locator('[data-widget-body]').boundingBox()).height
  await slot().getByRole('button', { name: 'Expand' }).click()
  check(
    await until(async () => (await inWidget(`document.body.dataset.presentation`)) === 'expanded'),
    'the widget was told to expand'
  )
  check(
    await until(
      async () => (await w.locator('[data-widget-body]').boundingBox()).height > compactH
    ),
    'and asked for more height'
  )
  await shot('03-meter-expanded')

  step('Close: gone, no space, stays closed')
  await slot().getByRole('button', { name: 'Close the Meter widget' }).click()
  check(await until(async () => (await slotCount()) === 0), 'the area is gone')
  check((await composerY()) === baseline, 'the message box is back where it was')
  check(await until(async () => (await widgetViews()).length === 0), 'its view is destroyed')
  await send('plain after closing')
  await idle()
  check((await slotCount()) === 0, 'a reply without a request does not reopen it')
  await newChat()
  await openChat('plain before plugins')
  await w.waitForSelector('text=plain after closing')
  check((await slotCount()) === 0, 'neither does reopening the chat')
  await send('widget gauge test')
  await idle()
  check(
    await until(async () => (await slot().getAttribute('data-widget')) === 'gauge/meter'),
    'a new request shows it again'
  )

  step('Chats keep their own widget')
  await newChat()
  check(await until(async () => (await slotCount()) === 0), 'a new chat has no widget')
  check(await until(async () => (await widgetViews()).length === 0), 'and no view')
  await send('plain in another chat')
  await idle()
  check((await slotCount()) === 0, 'still none after it answers')
  const callsBefore = chatTurns()
  await openChat('plain before plugins')
  check(
    await until(async () => (await slot().getAttribute('data-widget')) === 'gauge/meter'),
    'going back restores the meter'
  )
  check(
    await until(async () => (await inWidget(`document.body.dataset.value`)) === '42'),
    'with its last input'
  )
  check(chatTurns() === callsBefore, 'restoring sent nothing to the model')

  step('Failures stay in the widget')
  await newChat()
  await send('widget crash test')
  await idle()
  check(
    await until(async () => /crash-on-mount-3381/.test(await slot().innerText())),
    'a widget that throws shows an error in its area'
  )
  check(await until(async () => (await widgetViews()).length === 0), 'its view is gone')
  await shot('04-crash')
  await send('widget hang test')
  await idle()
  check(
    await until(async () => /isn't available/.test(await slot().innerText()), 20000),
    'a widget that hangs is stopped'
  )
  check(await until(async () => (await widgetViews()).length === 0), 'its view is gone')
  await send('plain after a hang')
  await idle()
  check(true, 'the chat still answers')
  await slot()
    .getByRole('button', { name: /Close the/ })
    .click()
  check(await until(async () => (await slotCount()) === 0), 'the error closes')

  step('Disabling the plugin removes its widget')
  await send('widget tally test again')
  await idle()
  await slot().waitFor({ timeout: 10000 })
  await openPlugins()
  await w.click('article[aria-label="Plugin Tally"] button:text-is("Manage")')
  await w.click('button:text-is("Disable")')
  await w.waitForSelector('button:text-is("Enable")')
  await closePlugins()
  check(await until(async () => (await slotCount()) === 0), 'the tally is gone')
  check(await until(async () => (await widgetViews()).length === 0), 'and its view')

  step('A restart restores without replaying')
  await openChat('plain before plugins')
  await slot().waitFor({ timeout: 10000 })
  await app.close()
  ;({ app, w } = await launch())
  const before = chatTurns()
  await openChat('plain before plugins')
  check(
    await until(async () => (await slot().getAttribute('data-widget')) === 'gauge/meter'),
    'the meter is back after a restart'
  )
  check(chatTurns() === before, 'nothing was sent to the model')
  check(
    fs.existsSync(`${CFG}/custard/widgets.json`) &&
      !fs.readFileSync(`${CFG}/custard/widgets.json`, 'utf8').includes('"count"'),
    'widgets.json keeps only identity and input'
  )
  await shot('05-restored')

  step("Spotify's own player widget, on the same host")
  await openPlugins()
  await w.click('article[aria-label="Plugin Spotify"] button:text-is("Manage")')
  await w.click('button:has-text("Review and activate")')
  await w.waitForSelector('text=New permissions to approve', { timeout: 30000 })
  check(
    await w.locator('text=Show its "player" panel').isVisible(),
    'the review asks for the player widget permission'
  )
  const spBoxes = w.locator('section:has-text("New permissions to approve") input[type=checkbox]')
  for (let i = 0; i < (await spBoxes.count()); i++) await spBoxes.nth(i).check()
  await w.click('button:text-matches("^Activate [0-9]")')
  await w.waitForSelector('text=Save configuration', { timeout: 30000 })
  await w.fill('input[aria-label="Client ID"]', '0123456789abcdef0123456789abcdef')
  await w.click('button:has-text("Save configuration")')
  await w.click('button:text-is("Connect")')
  await w.waitForSelector('text=· connected', { timeout: 15000 })
  // Chat, Design and Skills use a plugin only once it's turned on for them.
  await w.click('label:has-text("in Chat, Design and Skills") input[type=checkbox]')
  await w.waitForSelector('label:has-text("in Chat, Design and Skills") input:checked')
  await closePlugins()
  await newChat()
  await send('widget spotify test')
  await idle()
  check(
    await until(async () => (await slot().getAttribute('data-widget')) === 'spotify/player'),
    'the assistant shows the Spotify player'
  )
  check(
    await until(async () => /Says[\s\S]*Pause/.test(await inWidget('document.body.innerText'))),
    'it reads and draws playback itself'
  )
  const spotifyCalls = () => read(OUT + '/spotify.json', []).map((x) => `${x.method} ${x.path}`)
  check(!spotifyCalls().includes('PUT /v1/me/player/pause'), 'showing it changed nothing')
  await clickInWidget('button[aria-label="Pause Spotify playback"]')
  const pauseCard = w.locator('[aria-label="Allow widget action"]')
  await pauseCard.waitFor({ timeout: 10000 })
  check((await pauseCard.innerText()).includes('pause'), 'Pause asks first')
  await pauseCard.getByRole('button', { name: 'Allow', exact: true }).click()
  check(
    await until(async () => spotifyCalls().includes('PUT /v1/me/player/pause')),
    'allowed: the pause reached Spotify'
  )
  check(
    await until(async () => /Resume/.test(await inWidget('document.body.innerText'))),
    'and the player shows Resume'
  )
  await shot('06-spotify')
  const spotifyBody = async () => (await w.locator('[data-widget-body]').boundingBox()).height
  const fitted = await spotifyBody()
  check(fitted < 240, `the player asks only for the height it needs (${fitted}px)`)
  await slot().getByRole('button', { name: 'Expand' }).click()
  check(
    await until(async () => (await spotifyBody()) > fitted),
    'expanded, it grows to fit Restart and the larger artwork'
  )
  await shot('07-spotify-expanded')
} catch (e) {
  console.log(e)
  process.exitCode = 1
}
await app.close()
console.log('e2e done, exit', process.exitCode ?? 0)
