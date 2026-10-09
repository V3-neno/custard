// Stabilization 4.3: preview behaviour and resource use in the built app,
// against test/e2e/interrupt-mock.mjs (with test/e2e/mocks/p-platform.mjs).
// Mock model only.
//   - WebRTC: ICE gathering sends nothing to a STUN/TURN listener and leaks
//     no host address
//   - keyboard: can focus get into and out of the preview without a mouse
//   - a page that exhausts its memory, and one that never yields, are
//     stopped and the app keeps answering
//   - repeated previews: memory, processes and webContents over N show/hide
//     cycles (PREVIEW_CYCLES, default 150), written to <out>/preview-growth.json
// Usage, from the repo root after `npx electron-vite build`:
//   node test/e2e/interrupt-mock.mjs <out> &   (with <out>/vault as for widgets.mjs)
//   xvfb-run -a node test/e2e/preview-platform.mjs <out> <screenshot dir>
// Packaged, sandbox on: sudo test/platform/packaged-linux.sh test/e2e/preview-platform.mjs
// Linux only as written. Needs the playwright package.
import { _electron as electron } from 'playwright'
import { appLaunch } from '../platform/launch.mjs'
import dgram from 'dgram'
import fs from 'fs'
import net from 'net'

const [, , OUT, SHOTS] = process.argv
const CYCLES = Number(process.env.PREVIEW_CYCLES ?? 150)
const check = (cond, what) => {
  console.log((cond ? '✓ ' : '✕ ') + what)
  if (!cond) process.exitCode = 1
}
const step = (s) => console.log('\n## ' + s)
const CFG = OUT + '/cfg-preview-platform'
const DATA = `${CFG}/custard`
fs.rmSync(CFG, { recursive: true, force: true })
fs.mkdirSync(SHOTS, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const within = (p, ms) => Promise.race([p, sleep(ms).then(() => 'timeout')])

// Anything the preview sends to the STUN/TURN address.
const udpSeen = []
const tcpSeen = []
const udp = dgram.createSocket('udp4')
udp.on('message', (m, r) => udpSeen.push(`${r.address}:${r.port} ${m.length}B`))
await new Promise((r) => udp.bind(3478, '0.0.0.0', r))
const tcp = net.createServer((s) => {
  tcpSeen.push(s.localAddress)
  s.destroy()
})
await new Promise((r) => tcp.listen(3478, '0.0.0.0', r))

const app = await electron.launch({
  ...appLaunch(),
  env: {
    ...process.env,
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:8899',
    XDG_CONFIG_HOME: CFG,
    CUSTARD_PLUGIN_DIR: OUT + '/plugin'
  }
})
const results = { checked: new Date().toISOString(), packaged: Boolean(process.env.CUSTARD_EXE) }
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
  await w.setViewportSize({ width: 1400, height: 900 })
  await w.waitForSelector('text=Custard')
  const idle = () => w.waitForSelector('button[title=Send]', { timeout: 40000 })
  const turn = async (t) => {
    await w.fill('textarea', t)
    await w.keyboard.press('Enter')
    await w.waitForTimeout(300)
    await idle()
  }
  const status = () =>
    w
      .locator('[data-preview-status]')
      .first()
      .getAttribute('data-preview-status')
      .catch(() => 'none')
  const waitStatus = async (want, ms = 20000) => {
    const end = Date.now() + ms
    let s = await status()
    while (!want.includes(s) && Date.now() < end) {
      await sleep(200)
      s = await status()
    }
    return s
  }
  const previewEval = (js) =>
    app.evaluate(async ({ webContents }, js) => {
      const wc = webContents
        .getAllWebContents()
        .find((x) => !x.isDestroyed() && x.getURL().includes('.preview.invalid'))
      if (!wc) return { missing: true }
      return { value: await wc.executeJavaScript(js).catch((e) => `ERR ${e}`) }
    }, js)

  step('Setup')
  await w.click('button[title=Settings]')
  await w.fill('input[aria-label="Claude API key"]', 'sk-ant-test')
  await w.press('input[aria-label="Claude API key"]', 'Enter')
  await w.click('button:has-text("Use an existing vault")')
  await w.waitForSelector('text=· connected')
  await w.click('button:text-is("Done")')
  await w.click('button:text-is("Design")')

  step('WebRTC')
  await turn('p webrtc test')
  check((await waitStatus(['ready', 'failed', 'stopped'])) === 'ready', 'the WebRTC page loaded')
  await sleep(9000)
  const rtc = (await previewEval('JSON.stringify(window.__p)')).value
  console.log('  page saw: ' + rtc)
  const p = JSON.parse(rtc ?? '{}')
  results.webrtc = { page: p, udp: [...udpSeen], tcp: [...tcpSeen] }
  check(udpSeen.length === 0, `nothing reached the STUN/TURN port over UDP (${udpSeen.length})`)
  check(tcpSeen.length === 0, `nothing reached it over TCP (${tcpSeen.length})`)
  const types = (p.candidates ?? []).map((c) => c.match(/ typ (\w+)/)?.[1])
  check(
    !types.some((t) => t === 'srflx' || t === 'relay'),
    `no server-reflexive or relay candidate (${JSON.stringify(types)})`
  )
  const raw = (p.candidates ?? []).filter((c) => /\d+\.\d+\.\d+\.\d+ \d+ typ host/.test(c))
  check(raw.length === 0, `no raw host IP in candidates (${raw.length}; mDNS names are fine)`)

  step('Keyboard')
  await turn('p keys test')
  check((await waitStatus(['ready', 'failed', 'stopped'])) === 'ready', 'the keyboard page loaded')
  await sleep(500)
  const focused = () =>
    app.evaluate(({ webContents }) => {
      const f = webContents.getFocusedWebContents()
      if (!f) return 'none'
      return f.getURL().includes('.preview.invalid') ? 'preview' : 'app'
    })
  // Into the preview from the app with Tab only.
  await w.click('textarea')
  let reached = false
  for (let i = 0; i < 60 && !reached; i++) {
    await w.keyboard.press('Tab')
    reached = (await focused()) === 'preview'
  }
  results.keyboard = { tabIntoPreview: reached }
  console.log(`  Tab from the composer reaches the preview: ${reached}`)
  // Out of the preview with the keyboard: focus it, then Tab past its last control.
  await app.evaluate(({ webContents }) =>
    webContents
      .getAllWebContents()
      .find((x) => x.getURL().includes('.preview.invalid'))
      ?.focus()
  )
  const sendKey = (key, mods = []) =>
    app.evaluate(
      ({ webContents }, { key, mods }) => {
        const wc = webContents
          .getAllWebContents()
          .find((x) => x.getURL().includes('.preview.invalid'))
        for (const type of ['keyDown', 'char', 'keyUp'])
          if (type !== 'char' || key.length === 1)
            wc?.sendInputEvent({ type, keyCode: key, modifiers: mods })
      },
      { key, mods }
    )
  let left = false
  for (let i = 0; i < 8 && !left; i++) {
    await sendKey('Tab')
    await sleep(100)
    left = (await focused()) !== 'preview'
  }
  const inside = JSON.parse((await previewEval('JSON.stringify(window.__p)')).value ?? '{}')
  console.log(`  inside the preview, Tab moved through: ${JSON.stringify(inside.focus)}`)
  console.log(`  Tab past the last control returns focus to the app: ${left}`)
  results.keyboard.focusOrder = inside.focus
  results.keyboard.tabOutOfPreview = left
  check(
    JSON.stringify(inside.focus?.slice(0, 4)) === JSON.stringify(['a', 'b', 'c', 'd']),
    'Tab moves through the page in order'
  )
  // Tab alone can't leave (recorded above); F6 hands focus back to the app.
  await sendKey('F6')
  await sleep(200)
  const back = await focused()
  results.keyboard.f6 = back
  check(back === 'app', `F6 returns focus to the app (${back})`)
  const pageSawF6 = JSON.parse((await previewEval('JSON.stringify(window.__p)')).value ?? '{}')
  check(!pageSawF6.keys?.includes('F6'), 'the page never sees that F6')
  await w.screenshot({ path: `${SHOTS}/p-01-keys.png` })

  step('A page that exhausts its memory')
  await turn('p oom test')
  const t0 = Date.now()
  const oom = await waitStatus(['stopped', 'failed'], 90000)
  const oomMsg = await w
    .locator('[data-preview-status]')
    .first()
    .innerText()
    .catch(() => '')
  console.log(
    `  status ${oom} after ${Math.round((Date.now() - t0) / 1000)} s: ${oomMsg.slice(0, 120)}`
  )
  results.oom = { status: oom, seconds: Math.round((Date.now() - t0) / 1000) }
  check(oom === 'stopped', 'the preview is reported stopped')
  check(
    (await within(
      w.evaluate(() => 1 + 1),
      3000
    )) === 2,
    'the app still answers'
  )
  await w.screenshot({ path: `${SHOTS}/p-02-oom.png` })

  step('A page that never yields')
  await turn('a loop test')
  const loop = await waitStatus(['stopped', 'failed'], 60000)
  console.log(`  status ${loop}`)
  check(loop === 'stopped', 'the looping preview is stopped')
  check(
    (await within(
      w.evaluate(() => 1 + 1),
      3000
    )) === 2,
    'the app still answers'
  )

  step(`Repeated previews (${CYCLES} cycles)`)
  await turn('p plain test')
  check((await waitStatus(['ready'])) === 'ready', 'the plain page loaded')
  const root = `${DATA}/design`
  const chat = fs.readdirSync(root).find((d) => fs.existsSync(`${root}/${d}/artifacts.json`))
  const index = JSON.parse(fs.readFileSync(`${root}/${chat}/artifacts.json`, 'utf8'))
  const list = Array.isArray(index) ? index : (index.artifacts ?? Object.values(index))
  const plain = list.find((a) => a.name === 'Plain')
  const target = {
    chat,
    artifactId: plain.id,
    versionId: (plain.versions.at?.(-1) ?? Object.values(plain.versions).at(-1)).id,
    width: 0
  }
  const sample = async (n) => {
    await sleep(1500)
    const m = await app.evaluate(({ app, webContents }) => {
      const metrics = app.getAppMetrics()
      const kb = (t) =>
        metrics.filter((x) => !t || x.type === t).reduce((a, x) => a + x.memory.workingSetSize, 0)
      return {
        totalMB: Math.round(kb() / 1024),
        browserMB: Math.round(kb('Browser') / 1024),
        heapMB: Math.round(process.memoryUsage().heapUsed / 1048576),
        processes: metrics.length,
        webContents: webContents.getAllWebContents().length
      }
    })
    return { cycle: n, ...m }
  }
  const series = [await sample(0)]
  for (let i = 1; i <= CYCLES; i++) {
    await w.evaluate(async (t) => {
      await window.custard.design.preview.show(t)
      await new Promise((r) => setTimeout(r, 150))
      await window.custard.design.preview.hide()
    }, target)
    if (i % 25 === 0 || i === CYCLES) {
      series.push(await sample(i))
      console.log('  ' + JSON.stringify(series.at(-1)))
    }
  }
  results.growth = series
  const first = series[1] ?? series[0]
  const last = series.at(-1)
  const perCycleKB = Math.round(
    ((last.browserMB - first.browserMB) * 1024) / Math.max(1, last.cycle - first.cycle)
  )
  results.browserKBPerCycle = perCycleKB
  console.log(`  browser process: ${perCycleKB} KB per preview after the first 25`)
  check(last.webContents <= series[0].webContents + 1, 'no webContents left behind')
  check(last.processes <= series[0].processes + 2, 'no renderer processes left behind')
  check(
    (await within(
      w.evaluate(() => 1 + 1),
      3000
    )) === 2,
    'the app still answers'
  )
} catch (e) {
  check(false, `crashed: ${e}`)
  await w?.screenshot({ path: `${SHOTS}/p-crash.png` }).catch(() => undefined)
} finally {
  fs.writeFileSync(OUT + '/preview-platform.json', JSON.stringify(results, null, 1))
  await app.close().catch(() => undefined)
  udp.close()
  tcp.close()
}
