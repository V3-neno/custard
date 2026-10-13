// The MVP demo flow, end to end, against test/e2e/mock.mjs (fake Claude API and
// Spotify). Usage, from the repo root after `npx electron-vite build`:
//   node test/e2e/mock.mjs <out> <out>/plugin &   (with <out>/plugin a copy of plugin/
//                                                    and <out>/vault a copy of vault-template/)
//   node test/e2e/plugin-demo.mjs <out> <screenshot dir>
// The script itself writes a Music Preferences note (Nils Frahm under Focus) in <out>/vault.
// Linux only as written (XDG_CONFIG_HOME isolates the app's data), with a display
// or xvfb-run. Needs the playwright package, which isn't a dependency of this repo.
import { _electron as electron } from 'playwright'
import { createRequire } from 'module'
import fs from 'fs'
const [, , OUT, SHOTS] = process.argv
const PLUGIN_DIR = OUT + '/plugin'
// The demo bumps 1.0.0 to 1.0.1, so start the copy at 1.0.0 whatever the
// plugin's current version is.
const pluginJson = PLUGIN_DIR + '/spotify/plugin.json'
fs.writeFileSync(
  pluginJson,
  fs.readFileSync(pluginJson, 'utf8').replace(/"version": "[^"]+"/, '"version": "1.0.0"')
)
// The preference the demo expects the model to read from the vault. The
// starter vault has no music note, so the user's own note is written here.
fs.mkdirSync(OUT + '/vault/Areas', { recursive: true })
fs.writeFileSync(
  OUT + '/vault/Areas/Music Preferences.md',
  '# Music Preferences\n\n- **Focus / deep work:** Nils Frahm, Tycho, Ólafur Arnalds\n'
)
const app = await electron.launch({
  executablePath: createRequire(import.meta.url)('electron'),
  // --no-sandbox only for running as root in a Linux container.
  args: [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), '--password-store=basic', '.'],
  env: {
    ...process.env,
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:8899',
    XDG_CONFIG_HOME: OUT + '/cfg',
    CUSTARD_PLUGIN_DIR: PLUGIN_DIR
  }
})
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
const check = (cond, what) => {
  console.log((cond ? '✓ ' : '✕ ') + what)
  if (!cond) process.exitCode = 1
}
await app.evaluate(({ safeStorage, dialog, shell }, vault) => {
  safeStorage.setUsePlainTextEncryption?.(true)
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [vault] })
  // Plugin network goes through the host's transport; send it to the mock.
  globalThis.__custardPluginTransport = async (req) => {
    const target = 'http://127.0.0.1:8899' + req.url.pathname + req.url.search
    globalThis.__hosts = [...(globalThis.__hosts ?? []), req.url.host]
    const r = await fetch(target, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      signal: req.signal
    })
    return { status: r.status, headers: Object.fromEntries(r.headers), body: await r.text() }
  }
  // Act as the browser: approve consent and hit the loopback redirect.
  globalThis.__opened = []
  shell.openExternal = async (url) => {
    globalThis.__opened.push(url)
    if (url.startsWith('https://accounts.spotify.com/authorize')) {
      const p = new URL(url).searchParams
      setTimeout(() => fetch(`${p.get('redirect_uri')}?code=CODE&state=${p.get('state')}`), 300)
    }
  }
}, OUT + '/vault')
const w = await app.firstWindow()
await w.setViewportSize({ width: 1280, height: 900 })
w.on('pageerror', (e) => console.log('pageerror:', e.message))
const shot = (n) => w.screenshot({ path: `${SHOTS}/${n}.png` })
const fail = async (e) => {
  await shot('fail')
  console.log(e)
  await app.close()
  process.exit(1)
}
const settings = async () => {
  await openPlugins()
  await w.click('article[aria-label="Plugin Spotify"] button:text-is("Manage")')
}
const closeSettings = () => w.click('button:text-is("Done")')
const send = async (t) => {
  await w.fill('textarea', t)
  await w.keyboard.press('Enter')
}
const idle = () => w.waitForSelector('button[title=Send]', { timeout: 30000 })
const spotifyLog = () => JSON.parse(fs.readFileSync(OUT + '/spotify.json', 'utf8'))
const anthLog = () => JSON.parse(fs.readFileSync(OUT + '/anthropic.json', 'utf8'))
// Chat turns only: automatic memory's summarizer requests quote the user's
// messages too.
const chatLog = () =>
  anthLog().filter(
    (r) => !(typeof r.system === 'string' && r.system.startsWith('You decide what Custard'))
  )
const toolResults = (req) =>
  req.messages
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .filter((c) => c.type === 'tool_result')

try {
  await w.waitForSelector('text=Custard')
  step('Setup: key, vault')
  await w.click('button[title=Settings]')
  await w.fill('input[aria-label="Claude API key"]', 'sk-ant-test')
  await w.press('input[aria-label="Claude API key"]', 'Enter')
  await w.click('button:has-text("Use an existing vault")')
  await w.waitForSelector('text=· connected')
  await closeSettings()

  step('1-2. Plugins workspace, Spotify selected, edits only inside plugin/spotify')
  await w.click('button:text-is("Plugins")')
  await w.click('button[aria-label="Open Spotify"]')
  await w.waitForSelector('text=Workspace · plugin/spotify')
  await shot('01-plugins-workspace')
  await send(
    'Bump the version to 1.0.1, check you cannot touch core files, then validate and test.'
  )
  // Every file change is shown in full and approved on its own.
  const card = w.locator('[role=alertdialog]')
  await card.first().waitFor({ timeout: 60000 })
  const cardText = await card.first().innerText()
  check(
    cardText.includes('Replace plugin.json') && cardText.includes('+   "version": "1.0.1"'),
    'the version bump is shown as a diff before it is written'
  )
  check(
    JSON.parse(fs.readFileSync(pluginJson, 'utf8')).version === '1.0.0',
    'nothing is written before Allow'
  )
  await card.first().getByRole('button', { name: 'Allow', exact: true }).click()
  await w.waitForSelector('text=It is not active yet', { timeout: 60000 })
  await idle()
  await shot('02-edit-validate-test')
  const bump = chatLog().filter(
    (r) => r.messages[0] && JSON.stringify(r.messages[0]).includes('Bump')
  )
  const results = toolResults(bump.at(-1)).map((r) =>
    typeof r.content === 'string' ? r.content : JSON.stringify(r.content)
  )
  console.log(results.map((r) => '   ' + r.slice(0, 160).replace(/\n/g, ' ')).join('\n'))
  check(
    bump[0].tools.includes('fs_write') && !bump[0].tools.some((t) => /bash|shell|exec/i.test(t)),
    'code tools offered, no shell: ' + bump[0].tools.join(',')
  )
  check(
    JSON.parse(fs.readFileSync(PLUGIN_DIR + '/spotify/plugin.json', 'utf8')).version === '1.0.1',
    'plugin.json in plugin/spotify now says 1.0.1'
  )
  check(!fs.existsSync(PLUGIN_DIR + '/escape.txt'), '../escape.txt was not written')
  check(
    results.filter((r) => /outside|not allowed|absolute|refused|can't|isn't allowed/i.test(r))
      .length >= 3,
    'core read, absolute path and escape write refused'
  )

  step('3. Not activated automatically')
  await settings()
  await w.waitForSelector('text=Review and activate')
  check(
    (await w.locator('text=Not activated').count()) > 0,
    'Spotify still "Not activated" after validate and test'
  )

  step('4. Review and grant permissions')
  await w.click('button:has-text("Review and activate")')
  await w.waitForSelector('text=New permissions to approve', { timeout: 30000 })
  const boxes = w.locator('section:has-text("New permissions to approve") input[type=checkbox]')
  const n = await boxes.count()
  check(
    await w.locator('button:has-text("Activate 1.0.1")').isDisabled(),
    `Activate disabled until all ${n} permissions are ticked`
  )
  for (let i = 0; i < n; i++) await boxes.nth(i).check()
  await w.click('button:has-text("Run tests")')
  await w.waitForSelector('li:has-text("✓")', { timeout: 60000 })
  const failed = await w.locator('li.text-ember-600').count()
  check(
    failed === 0,
    `review test run: ${await w.locator('li:has-text("✓")').count()} passed, ${failed} failed`
  )
  await shot('03-review')

  step('5. Activate and connect')
  await w.click('button:has-text("Activate 1.0.1")')
  await w.waitForSelector('text=v1.0.1', { timeout: 30000 })
  await w.fill('input[aria-label="Client ID"]', '0123456789abcdef0123456789abcdef')
  await w.click('button:has-text("Save configuration")')
  await w.waitForSelector('text=Saved.')
  await w.click('button:text-is("Connect")')
  await w.waitForSelector('text=· connected', { timeout: 15000 })
  await shot('04-activated-connected')
  // Chat, Design and Skills use a plugin only once it's turned on for them.
  await w.click('label:has-text("in Chat, Design and Skills") input[type=checkbox]')
  await w.waitForSelector('label:has-text("in Chat, Design and Skills") input:checked')
  const cfgDir = fs.readdirSync(OUT + '/cfg')[0]
  const store = `${OUT}/cfg/${cfgDir}/plugins/spotify`
  const files = fs.readdirSync(store)
  console.log('   store:', store, files.join(','))
  const plainFiles = files
    .filter((f) => f !== 'secrets.bin' && f !== 'builds')
    .map((f) => fs.readFileSync(`${store}/${f}`, 'utf8'))
    .join('')
  check(
    !plainFiles.includes('AT-secret') && !plainFiles.includes('RT-secret'),
    'tokens not in state/config/data files'
  )
  await closePlugins()

  step('6-9. Chat: five focus songs from saved preferences')
  await w.click('button:text-is("Chat")')
  await send('Queue five songs for focus')
  await w.waitForSelector('[aria-label="Allow plugin action"]', { timeout: 30000 })
  await shot('05-approval')
  check(
    (await w.locator('[aria-label="Allow plugin action"]').textContent()).includes('5 tracks'),
    'approval card names 5 tracks'
  )
  check(
    !spotifyLog().some((r) => r.path === '/v1/me/player/queue' && r.method === 'POST'),
    'nothing queued before Allow'
  )
  await w.click('[aria-label="Allow plugin action"] button:text-is("Allow")')
  await w.waitForSelector('text=I queued five focus tracks', { timeout: 30000 })
  await idle()
  await shot('06-queued')
  const q = chatLog().filter((r) => JSON.stringify(r.messages[0]).includes('Queue five'))
  check(
    q[0].tools.includes('spotify__add_to_queue') && q[0].tools.includes('vault_read'),
    'plugin tools offered next to vault tools'
  )
  check(
    !q[0].system.includes('AT-secret') && !JSON.stringify(q.at(-1).messages).includes('AT-secret'),
    'token never in model context'
  )
  const prefRead = toolResults(q[1])[0]
  check(
    JSON.stringify(prefRead).includes('Nils Frahm'),
    'preferences came from the vault via vault_read'
  )
  const posts = spotifyLog().filter((r) => r.path === '/v1/me/player/queue' && r.method === 'POST')
  check(
    posts.length === 5,
    `5 queue requests reached Spotify, in order: ${posts.map((p) => p.query.uri.slice(-2)).join(' ')}`
  )
  check(
    spotifyLog().every(
      (r) =>
        r.method === 'GET' ||
        r.path === '/api/token' ||
        (r.method === 'POST' && r.path === '/v1/me/player/queue')
    ),
    'no playback change: only searches, queue adds and a queue read'
  )
  const queueResult = JSON.stringify(toolResults(q.at(-1)).at(-1))
  console.log('   queue result:', queueResult.slice(0, 300))
  check(/added to queue/.test(queueResult), 'tool reported the actual per-track outcome')
  check(
    (await app.evaluate(() => globalThis.__hosts)).every((h) => /spotify\.com$/.test(h)),
    'plugin network only to Spotify hosts'
  )

  step('9b. Recommendation only')
  const before = spotifyLog().length
  await send('Recommend three more like that')
  await w.waitForSelector('text=I have not queued anything', { timeout: 30000 })
  await idle()
  check(
    spotifyLog().length === before &&
      (await w.locator('[aria-label="Allow plugin action"]').count()) === 0,
    'no Spotify request and no approval card'
  )

  step('10. Disable')
  await settings()
  await w.click('button:text-is("Disable")')
  await w.waitForSelector('button:text-is("Enable")')
  await closePlugins()
  const before2 = spotifyLog().length
  await send('Queue one more')
  await w.waitForSelector('text=nothing was queued', { timeout: 30000 })
  await idle()
  await shot('07-disabled')
  const st = chatLog().filter((r) => JSON.stringify(r.messages).includes('Queue one more'))
  check(!st[0].tools.some((t) => t.startsWith('spotify__')), 'spotify tools no longer offered')
  // The refused call's result, in the request after it. Its tool is no longer
  // offered, so Custard sends it as text (see main/history), not tool_result.
  const staleResult = JSON.stringify(st.at(-1).messages.at(-1).content)
  console.log('   stale call result:', staleResult.slice(0, 200))
  check(
    /not available|disabled|isn't|unknown|not offered/i.test(staleResult),
    'stale spotify__add_to_queue call refused'
  )
  check(spotifyLog().length === before2, 'nothing reached Spotify after disable')

  step('11. Faulty update, automatic rollback, then manual rollback')
  await settings()
  await w.click('button:text-is("Enable")')
  await w.waitForSelector('button:text-is("Disable")')
  const idx = PLUGIN_DIR + '/spotify/src/index.ts'
  const good = fs.readFileSync(idx, 'utf8')
  const mf = PLUGIN_DIR + '/spotify/plugin.json'
  fs.writeFileSync(idx, "throw new Error('broken')\n" + good)
  fs.writeFileSync(
    mf,
    fs.readFileSync(mf, 'utf8').replace('"version": "1.0.1"', '"version": "1.0.2"')
  )
  await w.click('button:text-is("Refresh")')
  await w.click('button:has-text("Review update")')
  await w.waitForSelector('button:has-text("Activate 1.0.2")', { timeout: 30000 })
  await w.click('button:has-text("Activate 1.0.2")')
  await w.waitForSelector('text=still the active version', { timeout: 30000 })
  await shot('08-failed-update')
  console.log('   ', await w.locator('text=still the active version').first().textContent())
  check(
    /broken/.test(await w.locator('text=still the active version').first().textContent()),
    'the error says what the plugin threw'
  )
  await w.click('button:has-text("Cancel")')
  check((await w.locator('text=v1.0.1').count()) > 0, '1.0.1 still active after the failed update')
  // A build that loads but is wrong, then a manual rollback.
  fs.writeFileSync(idx, good.replace(/^/, '// 1.0.3 wrong but loads\n'))
  fs.writeFileSync(
    mf,
    fs.readFileSync(mf, 'utf8').replace('"version": "1.0.2"', '"version": "1.0.3"')
  )
  await w.click('button:text-is("Refresh")')
  await w.click('button:has-text("Review update")')
  await w.waitForSelector('button:has-text("Activate 1.0.3")', { timeout: 30000 })
  await w.click('button:has-text("Activate 1.0.3")')
  await w.waitForSelector('text=v1.0.3', { timeout: 30000 })
  await w.click('button:has-text("Roll back to 1.0.1")')
  await w.waitForSelector('text=v1.0.1', { timeout: 30000 })
  await shot('09-rolled-back')
  check(true, 'rolled back to 1.0.1 without rebuilding')
  console.log(
    'opened:',
    JSON.stringify(await app.evaluate(() => globalThis.__opened.map((u) => u.slice(0, 70))))
  )
} catch (e) {
  await fail(e)
}
await app.close()
console.log('\ne2e done, exit', process.exitCode ?? 0)
