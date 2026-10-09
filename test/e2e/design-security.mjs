// Workstream D: the HTML preview sandbox in the built app, against
// test/e2e/interrupt-mock.mjs (with test/e2e/mocks/d-security.mjs). Mock
// model only. Adds to design-workspace.mjs's probe the rest of the
// docs/design/SANDBOX.md checklist: other schemes and Custard's own, path
// tricks, workers and frames, messages to the app, external app links,
// print, fullscreen, clipboard, and storage between the check run and the
// visible preview.
// Usage, from the repo root after `npx electron-vite build`:
//   node test/e2e/interrupt-mock.mjs <out> &   (with <out>/vault and <out>/plugin as for widgets.mjs)
//   xvfb-run -a node test/e2e/design-security.mjs <out> <screenshot dir>
// Linux only as written. Needs the playwright package.
import { _electron as electron } from 'playwright'
import { createRequire } from 'module'
import fs from 'fs'

const [, , OUT, SHOTS] = process.argv
const check = (cond, what) => {
  console.log((cond ? '✓ ' : '✕ ') + what)
  if (!cond) process.exitCode = 1
}
const step = (s) => console.log('\n## ' + s)
const CFG = OUT + '/cfg-design-d'
const DATA = `${CFG}/custard`
const VAULT = OUT + '/vault'
fs.rmSync(CFG, { recursive: true, force: true })
fs.rmSync(OUT + '/d-leak.json', { force: true })
fs.mkdirSync(SHOTS, { recursive: true })

const conversations = () => {
  const dir = `${DATA}/conversations`
  return fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => JSON.parse(fs.readFileSync(`${dir}/${f}`, 'utf8')))
    : []
}
const newest = () => conversations().sort((a, b) => b.updatedAt - a.updatedAt)[0]
const lastResult = () =>
  (newest()?.messages ?? [])
    .flatMap((m) =>
      Array.isArray(m.content)
        ? m.content
            .filter((x) => x.type === 'tool_result')
            .map((x) =>
              Array.isArray(x.content) ? x.content.map((c) => c.text).join('') : String(x.content)
            )
        : []
    )
    .at(-1) ?? ''
const leaks = () => {
  try {
    return JSON.parse(fs.readFileSync(OUT + '/d-leak.json', 'utf8'))
  } catch {
    return []
  }
}

let app
let w
async function launch() {
  app = await electron.launch({
    executablePath: createRequire(import.meta.url)('electron'),
    args: [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), '--password-store=basic', '.'],
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:8899',
      XDG_CONFIG_HOME: CFG,
      CUSTARD_PLUGIN_DIR: OUT + '/plugin'
    }
  })
  await app.evaluate(
    ({ safeStorage, dialog, shell, clipboard }, { vault }) => {
      safeStorage.setUsePlainTextEncryption?.(true)
      globalThis.__boxes = []
      globalThis.__opened = []
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [vault] })
      dialog.showMessageBox = async (...args) => {
        globalThis.__boxes.push(args.at(-1).message)
        return { response: 0 }
      }
      // Any external app link the preview manages to hand to the OS.
      shell.openExternal = async (url) => void globalThis.__opened.push(url)
      shell.openPath = async (p) => {
        globalThis.__opened.push(`path:${p}`)
        return ''
      }
      clipboard.writeText('D-SENTINEL')
    },
    { vault: VAULT }
  )
  w = null
  for (let i = 0; !w && i < 300; i++) {
    w = app.windows().find((x) => x.url().endsWith('/renderer/index.html')) ?? null
    if (!w) await new Promise((r) => setTimeout(r, 100))
  }
  await w.setViewportSize({ width: 1400, height: 900 })
  w.on('pageerror', (e) => console.log('pageerror:', e.message))
  await w.waitForSelector('text=Custard')
}
const send = async (t) => {
  await w.fill('textarea', t)
  await w.keyboard.press('Enter')
}
const idle = () => w.waitForSelector('button[title=Send]', { timeout: 40000 })
const turn = async (t) => {
  await send(t)
  await w.waitForTimeout(300)
  await idle()
}
const pane = () => w.locator('aside[aria-label="Design outputs"]')
const previewEval = (js) =>
  app.evaluate(async ({ BrowserWindow }, js) => {
    const win = BrowserWindow.getAllWindows().find((x) => x.isVisible())
    const view = win?.contentView.children.find(
      (v) =>
        v.webContents &&
        !v.webContents.isDestroyed() &&
        v.webContents.getURL().includes('.preview.invalid')
    )
    if (!view) return { missing: true }
    return {
      url: view.webContents.getURL(),
      value: await view.webContents.executeJavaScript(js).catch((e) => `ERR ${e}`)
    }
  }, js)

try {
  await launch()
  step('Setup: key and vault')
  await w.click('button[title=Settings]')
  await w.fill('input[aria-label="Claude API key"]', 'sk-ant-test')
  await w.press('input[aria-label="Claude API key"]', 'Enter')
  await w.click('button:has-text("Use an existing vault")')
  await w.waitForSelector('text=· connected')
  await w.click('button:text-is("Done")')
  await w.click('button:text-is("Design")')
  // Anything a page posts to the app's window is recorded here.
  await w.evaluate(() => {
    window.__dmsgs = []
    window.addEventListener('message', (e) => window.__dmsgs.push(String(e.data)))
  })

  step('The escape probe (hidden check run)')
  await turn('d escape test')
  const result = lastResult()
  console.log('  ' + result.split('\n')[0].slice(0, 200))
  check(/Saved "Escape"/.test(result), 'design_html saved the probe')
  check(!/D LEAKED/.test(result), 'the check run saw no probe get out')

  step('The visible preview')
  await pane().waitFor({ timeout: 10000 })
  const status = await w
    .waitForSelector('[data-preview-status]:not([data-preview-status=loading])', { timeout: 15000 })
    .then((e) => e.getAttribute('data-preview-status'))
    .catch(() => 'none')
  check(status === 'ready', `the preview loaded (${status})`)
  await w.waitForTimeout(1500)
  const p = await previewEval(
    'JSON.stringify({ d: window.__d, prior: document.body.dataset.prior, cookie: document.body.dataset.priorCookie })'
  )
  const seen = (() => {
    try {
      return JSON.parse(p.value)
    } catch {
      return {}
    }
  })()
  console.log('  probes:', JSON.stringify(seen.d))
  const d = seen.d ?? {}
  check(
    d.frames?.top && d.frames?.parent && d.frames?.opener === null,
    `it is its own top frame with no opener (${JSON.stringify(d.frames)})`
  )
  for (const via of [
    'lan',
    'loopback-https',
    'file',
    'media-scheme',
    'dotdot',
    'dotdot2',
    'backslash',
    'eventsource',
    'import',
    'worker',
    'clipboard',
    'fullscreen'
  ])
    check(d[via] === 'BLOCKED', `${via}: refused (${d[via] ?? 'no answer'})`)
  check(seen.prior === 'none', 'localStorage from the check run is not in the visible preview')
  check(seen.cookie === 'none', 'cookies from the check run are not in the visible preview')

  step('Print, app links and navigation away')
  await previewEval('setTimeout(window.__dRisky, 0); 1')
  await w.waitForTimeout(2500)
  const after = await Promise.race([
    previewEval('document.body.innerText.slice(0, 80)'),
    new Promise((r) => setTimeout(() => r({ hung: true }), 5000))
  ])
  const state = await w
    .locator('[data-preview-status]')
    .first()
    .getAttribute('data-preview-status')
    .catch(() => 'none')
  console.log('  preview status after:', state)
  console.log('  after:', JSON.stringify(after).slice(0, 160))
  check(
    after.url?.includes('.preview.invalid/index.html'),
    `the preview stayed on its own page (${after.url})`
  )
  check(!/D-NAVIGATED/.test(String(after.value)), 'a data: navigation did not replace the page')

  step('Nothing reached the app or the OS')
  check(
    leaks().length === 0,
    `nothing reached the mock server (${JSON.stringify(leaks()).slice(0, 160)})`
  )
  const opened = await app.evaluate(() => globalThis.__opened)
  check(opened.length === 0, `no app link or path was opened (${JSON.stringify(opened)})`)
  const msgs = await w.evaluate(() => window.__dmsgs)
  check(
    !msgs.some((m) => m.startsWith('D-')),
    `the app window received no message from the page (${JSON.stringify(msgs)})`
  )
  check(
    (await app.evaluate(({ clipboard }) => clipboard.readText())) === 'D-SENTINEL',
    'the clipboard is unchanged'
  )
  check(
    (await app.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((x) => !x.isDestroyed()).length
    )) === 1,
    'no extra window (print preview, popup) is open'
  )
  check(
    !(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen())),
    'the window did not go full screen'
  )
  check((await app.evaluate(() => globalThis.__boxes)).length === 0, 'no dialog shown')
  const responsive = await Promise.race([
    w.evaluate(() => 1 + 1),
    new Promise((r) => setTimeout(() => r('timeout'), 2000))
  ])
  check(responsive === 2, 'the app is responsive')
  await w.screenshot({ path: `${SHOTS}/d-01-escape.png` })

  step('window.print()')
  await previewEval('setTimeout(window.__dPrint, 0); 1')
  await w.waitForTimeout(3000)
  const within = (p, ms) =>
    Promise.race([p, new Promise((r) => setTimeout(() => r('timeout'), ms))])
  const mainOk =
    (await within(
      app.evaluate(() => 1 + 1),
      5000
    )) === 2
  const rendererOk =
    (await within(
      w.evaluate(() => 1 + 1),
      5000
    )) === 2
  const previewOk = mainOk && (await within(previewEval('1 + 1'), 3000))?.value === 2
  console.log(`  after print: main ${mainOk}, app page ${rendererOk}, preview ${previewOk}`)
  check(mainOk, "Custard's main process still answers after print()")
  check(rendererOk, "Custard's window still answers after print()")
  check(previewOk, 'the preview keeps running (print refused)')
  if (!mainOk) throw new Error('main process blocked by print(); later steps skipped')

  step('A second preview shares nothing with the first')
  await within(
    previewEval(
      'localStorage.setItem("d-cross", "1"); indexedDB.open("d-cross").onsuccess = () => {}; 1'
    ),
    3000
  )
  await turn('d plain test')
  await w.waitForSelector('[data-preview-status=ready]', { timeout: 15000 })
  await w.waitForTimeout(800)
  const q = await previewEval(
    'new Promise((res) => indexedDB.databases().then((d) => res(JSON.stringify({ ls: localStorage.getItem("d-cross"), idb: d.map((x) => x.name) }))))'
  )
  console.log('  second preview:', JSON.stringify(q).slice(0, 200))
  const cross = (() => {
    try {
      return JSON.parse(q.value)
    } catch {
      return {}
    }
  })()
  check(cross.ls === null, 'localStorage from the first preview is not in the second')
  check(Array.isArray(cross.idb) && !cross.idb.includes('d-cross'), 'nor its IndexedDB')
  check(
    (await app.evaluate(
      ({ webContents }) =>
        webContents
          .getAllWebContents()
          .filter((x) => !x.isDestroyed() && x.getURL().includes('.preview.invalid')).length
    )) === 1,
    'only one preview is alive'
  )
} catch (err) {
  console.log('✕ crashed:', err)
  process.exitCode = 1
} finally {
  // A print dialog left open can wedge Electron's shutdown: don't wait on it.
  await Promise.race([app?.close().catch(() => {}), new Promise((r) => setTimeout(r, 5000))])
  app?.process().kill('SIGKILL')
}
