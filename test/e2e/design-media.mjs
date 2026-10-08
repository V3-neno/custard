// Design's plugin media in the built app, against test/e2e/interrupt-mock.mjs
// (with test/e2e/mocks/c-media.mjs) and the dev-only fixture plugin in
// test/fixtures/media-plugins/slowmo (copied into the plugin folder here):
//   - activating it asks for media:video; Design then reports video as
//     available through it
//   - its media tools aren't offered to the model, and a direct call is refused
//   - a video request shows one Design approval card naming the provider
//   - while the approval decision is pending nothing reaches the plugin;
//     once decided, the job completes and the stored video plays from
//     custard-media:// (inline and from a result link)
//   - a refused prompt fails cleanly; cancel is confirmed by the plugin
//   - disabling the plugin keeps saved video and says why new jobs can't run
// Usage, from the repo root after `npx electron-vite build`:
//   node test/e2e/interrupt-mock.mjs <out> &   (with <out>/plugin and <out>/vault as for memory.mjs)
//   node test/e2e/design-media.mjs <out> <screenshot dir>
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
const CFG = OUT + '/cfg-media'
fs.rmSync(CFG, { recursive: true, force: true })
fs.mkdirSync(SHOTS, { recursive: true })
fs.cpSync('test/fixtures/media-plugins/slowmo', `${OUT}/plugin/slowmo`, { recursive: true })

const read = (f, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'))
  } catch {
    return fallback
  }
}
const chatRequests = () =>
  read(OUT + '/anthropic.json', []).filter((r) => typeof r.system !== 'string')

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
if (process.env.WDEBUG) app.process().stdout.on('data', (d) => process.stdout.write('MAIN ' + d))
await app.evaluate(({ safeStorage, dialog }, vault) => {
  safeStorage.setUsePlainTextEncryption?.(true)
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [vault] })
  // Result links on media.example.com go to the mock.
  globalThis.__custardMediaTransport = async ({ url, signal }) => {
    const r = await fetch('http://127.0.0.1:8899/c-media' + url.pathname, { signal })
    return {
      status: r.status,
      headers: Object.fromEntries(r.headers),
      body: new Uint8Array(await r.arrayBuffer())
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

const send = async (t) => {
  await w.fill('textarea', t)
  await w.keyboard.press('Enter')
}
const idle = () => w.waitForSelector('button[title=Send]', { timeout: 30000 })
const card = () => w.locator('[role=alertdialog]')
const lastResults = () => {
  const msgs = chatRequests().at(-1)?.messages ?? []
  return msgs
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .filter((c) => c.type === 'tool_result')
    .map((c) => (typeof c.content === 'string' ? c.content : JSON.stringify(c.content)))
}
const shot = (n) => w.screenshot({ path: `${SHOTS}/${n}.png` })
const design = (code, arg) => w.evaluate(code, arg)
// The newest chat's id, from its saved file.
const chatId = () => {
  const dir = `${CFG}/custard/conversations`
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ f, t: fs.statSync(`${dir}/${f}`).mtimeMs }))
    .sort((a, b) => b.t - a.t)
  return files.length ? JSON.parse(fs.readFileSync(`${dir}/${files[0].f}`, 'utf8')).id : null
}
// The newest chat's jobs and outputs, through the app's own API.
const jobsOf = (chat) => design((c) => window.custard.design.jobs(c), chat)
// Plays a stored video in the app window and reports what Chromium saw.
const play = (url) =>
  design(
    (u) =>
      new Promise((resolve) => {
        const v = document.createElement('video')
        v.muted = true
        v.onloadedmetadata = () =>
          resolve({ ok: true, duration: v.duration, width: v.videoWidth, height: v.videoHeight })
        v.onerror = () => resolve({ ok: false, error: v.error?.code })
        v.src = u
      }),
    url
  )
// A turn that may ask for approval; answers the first card with `answer`.
const turn = async (t, answer = 'Allow') => {
  await send(t)
  const asked = await card()
    .first()
    .waitFor({ timeout: 8000 })
    .then(() => true)
    .catch(() => false)
  let text = ''
  if (asked) {
    text = await card().first().innerText()
    await card().first().getByRole('button', { name: answer, exact: true }).click()
  }
  await idle()
  return { asked, text }
}

try {
  step('Setup: key and vault')
  await w.click('button[title=Settings]')
  await w.fill('input[aria-label="Claude API key"]', 'sk-ant-test')
  await w.press('input[aria-label="Claude API key"]', 'Enter')
  await w.click('button:has-text("Use an existing vault")')
  await w.waitForSelector('text=· connected')

  step('Activating the fixture asks for media:video')
  await w.click('button:text-is("Plugins")')
  await w.click('button:has-text("Slowmo")')
  await w.click('button:has-text("Review and activate")')
  await w.waitForSelector('text=New permissions to approve', { timeout: 30000 })
  const perms = await w.locator('section:has-text("New permissions to approve")').innerText()
  check(
    /media:video|Offer its "video"/.test(perms),
    `the media permission is listed (${perms.replace(/\s+/g, ' ').slice(-120)})`
  )
  await shot('c-01-activate')
  const boxes = w.locator('section:has-text("New permissions to approve") input[type=checkbox]')
  for (let i = 0; i < (await boxes.count()); i++) await boxes.nth(i).check()
  await w.click('button:text-matches("^Activate [0-9]")')
  await w.waitForSelector('button:text-is("Disable")', { timeout: 30000 })
  await w.click('button:text-is("Done")')

  step('Design reports video through the plugin')
  const report = await design(() => window.custard.design.capabilities())
  const t2v = report['video.text-to-video'].availability
  check(
    t2v.status === 'supported' && t2v.via?.pluginId === 'slowmo',
    `text-to-video is supported via slowmo (${JSON.stringify(t2v).slice(0, 120)})`
  )
  check(
    report['image.generate'].availability.status === 'unavailable',
    'image generation stays unavailable (the fixture offers video only)'
  )

  step("Its media tools aren't plain tools")
  await w.click('button:text-is("Design")')
  const direct = await turn('c direct test')
  const offered = chatRequests().at(-1).tools
  check(offered.includes('design_media'), 'Design offers design_media')
  check(
    !offered.some((n) => /^slowmo__(submit|status|result|cancel)$/.test(n)),
    'the plugin media tools are not offered'
  )
  check(offered.includes('slowmo__jobs'), "the plugin's other tools still are")
  check(!direct.asked, 'a direct call asks nothing')
  const said = JSON.stringify(chatRequests().at(-1).messages.at(-1))
  check(/slowmo__submit isn't available/.test(said), `and is refused (${said.slice(0, 120)})`)

  step('A video request: one Design card')
  const v = await turn('c video test')
  check(v.asked, 'an approval card was shown')
  check(
    /Slowmo test video/.test(v.text) && /Make a video from text/.test(v.text),
    'it names the provider and the operation'
  )
  check(
    /can't be cancelled|No price information/.test(v.text),
    'it says what it costs (no price given)'
  )
  await shot('c-02-card')
  const results = lastResults()
  const pending = results.some((r) => /waiting on a decision/.test(r))
  const chat = chatId()
  if (pending) {
    console.log('  (approval decision pending: checking that nothing was sent)')
    check(true, `submission held: ${results.find((r) => /waiting on a decision/.test(r))}`)
    const jobs = chat ? await jobsOf(chat) : []
    check(jobs.length === 0 || jobs.every((j) => !j.remoteId), 'no job reached the plugin')
  } else {
    const done = results.find((r) => /saved as a new version/.test(r))
    check(!!done, `the job completed and was saved (${results.at(-1)?.slice(0, 100)})`)
    const outputs = await design((c) => window.custard.design.list(c), chat)
    const video = outputs.find((o) => o.kind === 'video')
    const art = await design((a) => window.custard.design.get(a[0], a[1]), [chat, video.id])
    const ver = art.versions.at(-1)
    check(
      ver.status === 'succeeded' && ver.files[0].mime === 'video/webm',
      'a webm version was stored'
    )
    const url = `custard-media://${chat}/${art.id}/${ver.id}/${ver.files[0].path}`
    const p = await play(url)
    check(
      p.ok && p.width === 160 && Math.round(p.duration) === 2,
      `it plays (${JSON.stringify(p)})`
    )

    step('A result link from an approved host')
    await turn('c link test')
    check(
      lastResults().some((r) => /saved as a new version/.test(r)),
      'the linked result was fetched and saved'
    )

    step('Refused and cancelled jobs')
    await turn('c cancel test')
    check(
      lastResults().some((r) => /cancelled/.test(r)),
      `a cancel is confirmed (${lastResults().at(-1)?.slice(0, 80)})`
    )
    await turn('c reject test')
    check(
      lastResults().some((r) => /refused/.test(r)),
      `a refused prompt fails (${lastResults().at(-1)?.slice(0, 80)})`
    )
    // A refused prompt doesn't turn the provider off for the session.
    await turn('c video test')
    check(
      lastResults().some((r) => /^Submitted to Slowmo/.test(r)),
      'a new request after a refusal is still sent'
    )
  }

  step('Disabling the plugin')
  await w.click('button[title=Settings]')
  await w.click('button:text-is("Plugins")')
  await w.click('button:has-text("Slowmo")')
  await w.click('button:text-is("Disable")')
  await w.click('button:text-is("Done")')
  const after = (await design(() => window.custard.design.capabilities()))['video.text-to-video']
    .availability
  check(
    after.status === 'unavailable' && /turned off/.test(after.reason),
    `video is unavailable and says why (${after.reason})`
  )
  if (!pending && chat) {
    const outputs = await design((c) => window.custard.design.list(c), chat)
    check(
      outputs.some((o) => o.kind === 'video'),
      'saved video outputs are still listed'
    )
  }
  await shot('c-03-disabled')
} catch (err) {
  console.log('✕ error:', err)
  process.exitCode = 1
  await shot('c-error').catch(() => {})
} finally {
  await app.close()
}
