// Stabilization 4.4: realistic media sizes through the plugin sandbox and
// IPC, in the built app, against test/e2e/interrupt-mock.mjs (with
// test/e2e/mocks/p-platform.mjs) and the bigmedia fixture plugin
// (test/platform/fixtures/bigmedia, which builds its files inside its own
// sandbox and contacts nothing). Mock model only; no provider.
// For each case: the result (saved or refused, and the message), the app
// window's longest event-loop stall while it ran, Custard's peak memory, and
// whether the stored file renders or plays in the app window.
// Usage, from the repo root after `npx electron-vite build`:
//   node test/e2e/interrupt-mock.mjs <out> &   (with <out>/plugin and <out>/vault as for widgets.mjs)
//   xvfb-run -a node test/e2e/media-sizes.mjs <out> <screenshot dir>
// Packaged, sandbox on: sudo test/platform/packaged-linux.sh test/e2e/media-sizes.mjs
// Writes <out>/media-sizes.json. Linux only as written. Needs the playwright package.
import { _electron as electron } from 'playwright'
import { appLaunch } from '../platform/launch.mjs'
import fs from 'fs'

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
const CFG = OUT + '/cfg-media-sizes'
fs.rmSync(CFG, { recursive: true, force: true })
fs.mkdirSync(SHOTS, { recursive: true })
fs.rmSync(`${OUT}/plugin/bigmedia`, { recursive: true, force: true })
fs.cpSync('test/platform/fixtures/bigmedia', `${OUT}/plugin/bigmedia`, { recursive: true })
fs.copyFileSync(
  'test/fixtures/media-plugins/slowmo/src/clip.ts',
  `${OUT}/plugin/bigmedia/src/clip.ts`
)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const read = (f, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'))
  } catch {
    return fallback
  }
}
const chatRequests = () =>
  read(OUT + '/anthropic.json', []).filter((r) => typeof r.system !== 'string')
const lastResults = () =>
  (chatRequests().at(-1)?.messages ?? [])
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .filter((c) => c.type === 'tool_result')
    .map((c) => (typeof c.content === 'string' ? c.content : JSON.stringify(c.content)))

const app = await electron.launch({
  ...appLaunch(),
  env: {
    ...process.env,
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:8899',
    XDG_CONFIG_HOME: CFG,
    CUSTARD_PLUGIN_DIR: OUT + '/plugin'
  }
})
const report = {
  checked: new Date().toISOString(),
  packaged: Boolean(process.env.CUSTARD_EXE),
  cases: []
}
let w = null
try {
  await app.evaluate(({ safeStorage, dialog }, vault) => {
    safeStorage.setUsePlainTextEncryption?.(true)
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [vault] })
  }, OUT + '/vault')
  for (let i = 0; !w && i < 300; i++) {
    w = app.windows().find((x) => x.url().endsWith('/renderer/index.html')) ?? null
    if (!w) await sleep(100)
  }
  await w.setViewportSize({ width: 1280, height: 900 })
  await w.waitForSelector('text=Custard')
  const card = () => w.locator('[role=alertdialog]')
  const idle = () => w.waitForSelector('button[title=Send]', { timeout: 120000 })
  const chatId = () => {
    const dir = `${CFG}/custard/conversations`
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => ({ f, t: fs.statSync(`${dir}/${f}`).mtimeMs }))
      .sort((a, b) => b.t - a.t)
    return files.length ? JSON.parse(fs.readFileSync(`${dir}/${files[0].f}`, 'utf8')).id : null
  }
  const memory = () =>
    app.evaluate(({ app }) => {
      const m = app.getAppMetrics()
      const mb = (t) =>
        Math.round(
          m.filter((x) => !t || x.type === t).reduce((a, x) => a + x.memory.workingSetSize, 0) /
            1024
        )
      return {
        totalMB: mb(),
        browserMB: mb('Browser'),
        heapMB: Math.round(process.memoryUsage().heapUsed / 1048576)
      }
    })

  step('Setup: key, vault, fixture plugin')
  await w.click('button[title=Settings]')
  await w.fill('input[aria-label="Claude API key"]', 'sk-ant-test')
  await w.press('input[aria-label="Claude API key"]', 'Enter')
  await w.click('button:has-text("Use an existing vault")')
  await w.waitForSelector('text=· connected')
  await openPlugins()
  await w.click('article[aria-label^="Plugin Bigmedia"] button:text-is("Manage")')
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
  // Images from the fixture rather than the built-in provider, if Design asks which.
  await w.click('button[title=Settings]')
  await w.getByRole('tab', { name: 'Design' }).click()
  const sel = w.locator('#design-image-provider')
  if (await sel.count()) {
    const opts = await sel.locator('option').evaluateAll((o) => o.map((x) => x.value))
    const mine = opts.find((v) => /bigmedia/.test(v))
    if (mine) await sel.selectOption(mine)
  }
  await w.click('button:text-is("Done")')
  await w.click('button:text-is("Design")')

  const run = async (label, words, expect) => {
    step(`${label}: "${words}"`)
    const before = await memory()
    // The app window's longest stall while the case runs.
    await w.evaluate(() => {
      window.__lag = 0
      let last = performance.now()
      window.__lagTimer = setInterval(() => {
        const now = performance.now()
        window.__lag = Math.max(window.__lag, now - last - 50)
        last = now
      }, 50)
    })
    let peak = before
    let sampling = true
    const sampler = (async () => {
      while (sampling) {
        const m = await memory().catch(() => null)
        if (m && m.totalMB > peak.totalMB) peak = m
        await sleep(200)
      }
    })()
    const seen = lastResults().length
    const t0 = Date.now()
    await w.fill('textarea', `p media test ${words}`)
    await w.keyboard.press('Enter')
    const asked = await card()
      .first()
      .waitFor({ timeout: 15000 })
      .then(() => true)
      .catch(() => false)
    if (asked) await card().first().getByRole('button', { name: 'Allow', exact: true }).click()
    await sleep(500)
    await idle()
    const seconds = (Date.now() - t0) / 1000
    sampling = false
    await sampler
    const lag = await w.evaluate(() => {
      clearInterval(window.__lagTimer)
      return Math.round(window.__lag)
    })
    const results = lastResults().slice(seen)
    const text = results.at(-1) ?? ''
    const saved = results.some((r) => /saved as a new version/.test(r))
    const c = {
      label,
      words,
      saved,
      seconds,
      lagMs: lag,
      before,
      peak,
      message: text.slice(0, 240)
    }
    // The stored file, loaded the way the workspace loads it.
    if (saved) {
      const chat = chatId()
      const outputs = await w.evaluate((ch) => window.custard.design.list(ch), chat)
      const out = outputs.at(-1)
      const art = await w.evaluate((a) => window.custard.design.get(a[0], a[1]), [chat, out.id])
      const ver = art.versions.at(-1)
      c.files = ver.files.map((f) => ({ mime: f.mime, bytes: f.bytes ?? f.size }))
      const url = `custard-media://${chat}/${art.id}/${ver.id}/${ver.files[0].path}`
      c.render = await w.evaluate(
        (u) =>
          new Promise((resolve) => {
            const t = performance.now()
            const done = (r) => resolve({ ...r, ms: Math.round(performance.now() - t) })
            if (/\.webm$/.test(u)) {
              const v = document.createElement('video')
              v.muted = true
              v.onloadedmetadata = () =>
                done({ ok: true, duration: v.duration, width: v.videoWidth })
              v.onerror = () => done({ ok: false, error: v.error?.code })
              v.src = u
            } else {
              const i = new Image()
              i.onload = () =>
                i.decode().then(
                  () => done({ ok: true, width: i.naturalWidth }),
                  () => done({ ok: false, error: 'decode' })
                )
              i.onerror = () => done({ ok: false, error: 'load' })
              i.src = u
            }
            setTimeout(() => done({ ok: false, error: 'timeout' }), 30000)
          }),
        url
      )
    }
    console.log(
      `  ${saved ? 'saved' : 'not saved'} in ${seconds.toFixed(1)} s; app stall ${lag} ms; ` +
        `memory ${before.totalMB} -> peak ${peak.totalMB} MB (browser ${before.browserMB} -> ${peak.browserMB})`
    )
    console.log(`  ${c.message.replace(/\s+/g, ' ').slice(0, 200)}`)
    if (c.render) console.log(`  render: ${JSON.stringify(c.render)}`)
    report.cases.push(c)
    expect(c)
    check(lag < 1000, `the app window never stalled for a second (${lag} ms)`)
    check(
      (await Promise.race([w.evaluate(() => 2), sleep(3000).then(() => 'timeout')])) === 2,
      'the app still answers'
    )
  }

  await run('Image, 1024 px (3 MB)', 'png=1024', (c) => {
    check(c.saved, 'saved')
    check(c.render?.ok && c.render.width === 1024, 'renders at full size')
  })
  await run('Image, 2048 px (12 MB, 16 MB as base64)', 'png=2048', (c) => {
    check(c.saved, 'saved')
    check(c.render?.ok && c.render.width === 2048, 'renders at full size')
  })
  await run('Image, 3400 px (33 MB, 44 MB as base64)', 'png=3400', (c) => {
    check(c.saved, 'saved (under the 48 MB data limit)')
    check(c.render?.ok && c.render.width === 3400, 'renders at full size')
  })
  await run('Image over the limit, 3700 px (41 MB, 55 MB as base64)', 'png=3700', (c) => {
    check(!c.saved, 'refused')
    // Recorded: whether the message says the result was too large.
    c.saysSize = /larger than|too large|size/i.test(c.message)
    console.log(`  the message names the size: ${c.saysSize}`)
  })
  await run('Video, 30 MB', 'webm=30', (c) => {
    check(c.saved, 'saved')
    check(c.render?.ok && Math.round(c.render.duration) === 2, 'plays')
  })
  await run('Four images of 3 MB', 'png=1024 files=4', (c) => check(c.saved, 'saved'))
  await run('Two files with the same name', 'png=256 files=2 samename', (c) =>
    // Recorded: what a provider's naming slip does to a (paid) result.
    console.log(`  outcome: ${c.saved ? 'saved' : 'not saved'}`)
  )
  await run('Five files (over the count limit)', 'png=256 files=5', (c) =>
    check(!c.saved, 'refused')
  )
  await run('Malformed base64', 'png=512 badb64', (c) => {
    check(!c.saved, 'refused')
    check(/base64/i.test(c.message), `says so (${c.message.slice(0, 100)})`)
  })
  await run('Truncated PNG', 'png=512 truncated', (c) => {
    // The header is right, so the type check passes. Chromium draws what it
    // can of a cut-off PNG (no error event); the check is that it doesn't hang.
    check(
      !c.saved || c.render?.error !== 'timeout',
      `no hang when shown (${JSON.stringify(c.render)})`
    )
  })
  await run('Declared PNG, actually WebM', 'mismatch', (c) => {
    check(!c.saved, 'refused')
    check(/says it is image\/png/i.test(c.message), `says why (${c.message.slice(0, 100)})`)
  })
  await run('Result retrieval fails', 'png=256 resultfail', (c) => {
    check(!c.saved, 'not saved')
  })
  await w.screenshot({ path: `${SHOTS}/m-01-sizes.png` })
} catch (e) {
  check(false, `crashed: ${e}`)
  await w?.screenshot({ path: `${SHOTS}/m-crash.png` }).catch(() => undefined)
} finally {
  fs.writeFileSync(OUT + '/media-sizes.json', JSON.stringify(report, null, 1))
  await app.close().catch(() => undefined)
}
