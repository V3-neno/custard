// Design's output workspace in the built app, against test/e2e/interrupt-mock.mjs
// (with test/e2e/mocks/a-workspace.mjs). Mock model only: nothing here talks
// to a real provider.
//   - design_html saves complete documents as versions; the pane appears
//     beside the conversation only once the chat has an output
//   - the preview runs in its own view (no preload, no app API) showing the
//     selected version; desktop, tablet and phone widths; Code view
//   - revisions and variations are separate versions; selecting an older one
//     persists; a fragment is refused and the last good version stays
//   - attached images become local files of a version
//   - skills used are recorded and shown, a changed skill is detected and
//     only offered (the button fills the message box, nothing is sent)
//   - conflicting skills stop generation with a question
//   - the page can't see Custard's API and its requests never leave
//   - a page that hangs is stopped and reported; the app stays responsive
//   - export: a folder for a page with files, a file otherwise, asks before
//     replacing, refuses Custard's own places; exports survive deleting the chat
//   - outputs survive a restart; narrow windows switch between the two sides
// Usage, from the repo root after `npx electron-vite build`:
//   node test/e2e/interrupt-mock.mjs <out> &   (with <out>/vault and <out>/plugin as for widgets.mjs)
//   xvfb-run -a node test/e2e/design-workspace.mjs <out> <screenshot dir>
// Linux only as written. Needs the playwright package.
import { _electron as electron } from 'playwright'
import { createRequire } from 'module'
import fs from 'fs'
import zlib from 'zlib'

const [, , OUT, SHOTS] = process.argv
const check = (cond, what) => {
  console.log((cond ? '✓ ' : '✕ ') + what)
  if (!cond) process.exitCode = 1
}
const step = (s) => console.log('\n## ' + s)
const CFG = OUT + '/cfg-design-a'
const DATA = `${CFG}/custard`
const VAULT = OUT + '/vault'
const SKILLS = `${VAULT}/Custard/Skills`
const EXPORTS = OUT + '/a-exports'
const FILES = OUT + '/a-files'
fs.rmSync(CFG, { recursive: true, force: true })
fs.rmSync(EXPORTS, { recursive: true, force: true })
fs.rmSync(OUT + '/a-leak.json', { force: true })
fs.mkdirSync(EXPORTS, { recursive: true })
fs.mkdirSync(FILES, { recursive: true })
const skill = (name, description, body) => {
  fs.mkdirSync(`${SKILLS}/${name}`, { recursive: true })
  fs.writeFileSync(
    `${SKILLS}/${name}/SKILL.md`,
    `---\nname: ${name}\ndescription: ${description}\nmodes: design\n---\n${body}\n`
  )
}
skill('brand-guide', 'Brand colours and shapes for every page.', 'Amber on near-black.')
skill('print-layout', 'Print-ready layouts.', 'A4 margins.')

// A real 8x8 PNG for the reference.
function png() {
  const crc = (b) => {
    let c = ~0
    for (const x of b) {
      c ^= x
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
    }
    return ~c >>> 0
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type), data])
    const c = Buffer.alloc(4)
    c.writeUInt32BE(crc(td))
    return Buffer.concat([len, td, c])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(8, 0)
  ihdr.writeUInt32BE(8, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const raw = Buffer.concat(
    Array.from({ length: 8 }, () => Buffer.from([0, ...Array(8).fill([245, 174, 63]).flat()]))
  )
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}
fs.writeFileSync(`${FILES}/logo.png`, png())

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
const artifacts = (chat) => {
  try {
    return JSON.parse(fs.readFileSync(`${DATA}/design/${chat}/artifacts.json`, 'utf8')).artifacts
  } catch {
    return []
  }
}
const leaks = () => {
  try {
    return JSON.parse(fs.readFileSync(OUT + '/a-leak.json', 'utf8'))
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
  // The preview has dialogs disabled, so Electron answers a page's alert()
  // itself. Without a listener Playwright also tries to dismiss it, finds no
  // dialog and crashes the run; this listener just ignores that.
  const quiet = (page) => page.on('dialog', (d) => d.dismiss().catch(() => {}))
  app.windows().forEach(quiet)
  app.on('window', quiet)
  await app.evaluate(
    ({ safeStorage, dialog }, { vault }) => {
      safeStorage.setUsePlainTextEncryption?.(true)
      globalThis.__open = [vault]
      globalThis.__save = null
      globalThis.__boxes = []
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: globalThis.__open })
      dialog.showSaveDialog = async () =>
        globalThis.__save ? { canceled: false, filePath: globalThis.__save } : { canceled: true }
      dialog.showMessageBox = async (...args) => {
        const o = args.at(-1)
        globalThis.__boxes.push(o.message)
        return { response: 0 }
      }
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
// The preview is a native view, which page screenshots don't include: it is
// captured on its own beside each shot.
const shot = async (n) => {
  await w.screenshot({ path: `${SHOTS}/${n}.png` })
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((x) => x.isVisible())
    const view = win?.contentView.children.find((v) =>
      v.webContents?.getURL().includes('.preview.invalid')
    )
    if (!view || !view.getVisible()) return null
    return {
      png: (await view.webContents.capturePage()).toPNG().toString('base64'),
      bounds: view.getBounds()
    }
  })
  if (png) {
    fs.writeFileSync(`${SHOTS}/${n}-preview.png`, Buffer.from(png.png, 'base64'))
    fs.writeFileSync(`${SHOTS}/${n}-preview.json`, JSON.stringify(png.bounds))
  }
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
const versions = () => pane().locator('[aria-label=Versions] button')

// The preview's own web contents, seen from the main process.
const preview = () =>
  app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((x) => x.isVisible())
    const view = win?.contentView.children.find(
      (v) =>
        v.webContents &&
        !v.webContents.isDestroyed() &&
        v.webContents.getURL().includes('.preview.invalid')
    )
    if (!view) return null
    const wc = view.webContents
    return {
      url: wc.getURL(),
      text: await wc
        .executeJavaScript('document.body ? document.body.innerText : ""')
        .catch((e) => `ERR ${e}`),
      bounds: view.getBounds(),
      visible: view.getVisible?.() ?? null,
      zoom: wc.getZoomFactor(),
      preload: wc.session.getPreloads?.().length ?? 0
    }
  })
const until = async (fn, ms = 15000) => {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v || Date.now() > end) return v
    await new Promise((r) => setTimeout(r, 200))
  }
}

let chatId
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
  check((await pane().count()) === 0, 'no workspace before the chat has outputs')

  step('A first HTML output')
  await turn('a html test')
  chatId = newest().id
  check(
    /Saved "Landing"/.test(lastResult()),
    `design_html saved it (${lastResult().split('\n')[0]})`
  )
  check(/all 1 reference resolve/.test(lastResult()), 'the local CSS file resolves')
  check(/Preview loaded in the sandbox/.test(lastResult()), 'the hidden preview check loaded it')
  check(/No runtime errors while loading/.test(lastResult()), 'and saw no runtime errors')
  await pane().waitFor({ timeout: 10000 })
  check((await pane().locator('h2').innerText()).includes('Landing'), 'the workspace shows Landing')
  await w.waitForSelector('[data-preview-status=ready]', { timeout: 15000 })
  let p = await until(preview)
  check(
    p && p.text.includes('Version one'),
    `the preview shows version 1 (${p?.text?.slice(0, 40)})`
  )
  check(p && p.preload === 0, 'the preview session has no preload')
  const box = await w.locator('[data-preview-box]').boundingBox()
  check(
    p?.bounds && Math.abs(p.bounds.x - box.x) < 2 && Math.abs(p.bounds.width - box.width) < 2,
    'the preview view sits over the box in the pane'
  )
  const stored = artifacts(chatId)[0]
  check(
    stored?.versions[0].files
      .map((f) => f.path)
      .sort()
      .join() === 'css/site.css,index.html',
    'the version holds index.html and css/site.css'
  )
  await shot('a-01-first')

  step('Widths and code')
  await pane().getByRole('button', { name: 'Phone', exact: true }).click()
  p = await until(async () => {
    const x = await preview()
    return x?.bounds?.width === 390 ? x : null
  })
  check(p?.bounds?.width === 390, `phone width is 390 (${p?.bounds?.width})`)
  await shot('a-02-phone')
  // A narrow pane: tablet is scaled down to fit rather than cut off.
  await w.evaluate(() => localStorage.setItem('custard.design.paneWidth', '400'))
  const sep = w.locator('[role=separator]')
  const sb = await sep.boundingBox()
  await w.mouse.move(sb.x + 3, sb.y + 100)
  await w.mouse.down()
  await w.mouse.move(1400 - 420, sb.y + 100, { steps: 5 })
  await w.mouse.up()
  await pane().getByRole('button', { name: 'Tablet', exact: true }).click()
  await w.waitForSelector('text=/Scaled to \\d+% to fit/', { timeout: 5000 }).catch(() => {})
  p = await preview()
  check(p && p.zoom < 1, `tablet in a narrow pane is scaled to fit (zoom ${p?.zoom?.toFixed(2)})`)
  await shot('a-03-tablet-narrow')
  await pane().getByRole('button', { name: 'Desktop', exact: true }).click()
  await pane().getByRole('button', { name: 'Code', exact: true }).click()
  const code = await w.locator('pre[aria-label="index.html"]').innerText({ timeout: 5000 })
  check(code.includes('<!doctype html>') && code.includes('Version one'), 'Code shows the document')
  check(
    await w.locator('text=Also in this version: css/site.css').count(),
    'and lists its other files'
  )
  check((await preview()) === null, 'no preview runs while Code is shown')
  await shot('a-04-code')
  await pane().getByRole('button', { name: 'Preview', exact: true }).click()

  step('Revisions, variations, selection')
  await turn('a revise test')
  await turn('a variation test')
  let a = artifacts(chatId)[0]
  check(
    JSON.stringify(a.versions.map((v) => [v.n, v.relation])) ===
      JSON.stringify([
        [1, 'first'],
        [2, 'revision'],
        [3, 'variation']
      ]),
    'v2 is a revision and v3 a variation'
  )
  check(a.versions[2].parent === a.versions[0].id, 'v3 is a variation of v1')
  check(
    a.versions[1].files.some((f) => f.path === 'css/site.css'),
    'v2 kept the local CSS file'
  )
  check((await versions().count()) === 3, 'three version chips')
  check(
    (await pane().locator('h2').innerText()).includes('variation of v1'),
    'the header says v3 is a variation of v1'
  )
  p = await until(async () =>
    (await preview())?.text?.includes('Another option') ? preview() : null
  )
  check(!!p, 'the preview shows v3')
  await versions().nth(1).click()
  p = await until(async () => {
    const x = await preview()
    return x?.text?.includes('Version two') ? x : null
  })
  check(!!p, 'choosing v2 shows it')
  check(artifacts(chatId)[0].selected === a.versions[1].id, 'and the choice is saved')
  await shot('a-05-versions')

  step('A failed attempt keeps the last good version')
  await turn('a fragment test')
  check(
    /fragment.*Nothing was saved/s.test(lastResult()),
    `a fragment is refused (${lastResult().slice(0, 60)})`
  )
  check(artifacts(chatId)[0].versions.length === 3, 'no version was added')
  check(artifacts(chatId)[0].selected === a.versions[1].id, 'v2 is still selected')

  step('An attached image as a local file')
  await app.evaluate((_, f) => (globalThis.__open = [f]), `${FILES}/logo.png`)
  await w.click('button[aria-label="Attach files"]')
  await w.waitForSelector('[aria-label="Files to send"] li', { timeout: 5000 })
  await turn('a reference test')
  a = artifacts(chatId)[0]
  const v4 = a.versions[3]
  check(
    v4?.files.some((f) => f.path === 'assets/logo.png' && f.mime === 'image/png'),
    'v4 holds assets/logo.png'
  )
  check(v4?.parent === a.versions[1].id, 'v4 revises the selected v2')
  const img = await until(() =>
    app.evaluate(async ({ webContents }) => {
      const wc = webContents
        .getAllWebContents()
        .find((x) => x.getURL().includes('.preview.invalid'))
      return wc?.executeJavaScript('document.images[0]?.naturalWidth || 0').catch(() => 0)
    })
  )
  check(img === 8, `the logo loads in the preview (${img}px)`)
  await shot('a-06-reference')

  step('Skills: recorded, shown, changes offered')
  await turn('a skills test')
  a = artifacts(chatId)[0]
  const v5 = a.versions.at(-1)
  check(
    v5.skills.length === 1 &&
      v5.skills[0].name === 'brand-guide' &&
      v5.skills[0].how === 'explicit',
    'the named skill is recorded'
  )
  check(/^[0-9a-f]{64}$/.test(v5.skills[0].fingerprint), 'with its fingerprint')
  check(/Used: brand-guide/.test(lastResult()), 'the result says it was used')
  check(
    /"print-layout" is related but not a clear fit/.test(lastResult()),
    'and that the similar one was not'
  )
  const used = pane().locator('[aria-label="Skills used"]')
  check((await used.innerText()).includes('brand-guide'), 'Skills used shows it')
  fs.appendFileSync(`${SKILLS}/brand-guide/SKILL.md`, 'Now with teal.\n')
  await w.evaluate(() => window.dispatchEvent(new Event('focus')))
  await w.waitForSelector('text=1 changed since', { timeout: 5000 }).catch(() => {})
  check((await used.innerText()).includes('1 changed since'), 'a changed skill is noticed')
  await used.locator('button[aria-expanded]').click()
  await shot('a-07-skills')
  const before = conversations().length
  const sentBefore = newest().messages.length
  await used.getByRole('button', { name: 'Use the updated skill' }).click()
  const draft = await w.locator('textarea').inputValue()
  check(
    draft.includes('following the updated "brand-guide" skill'),
    'the offer fills the message box'
  )
  await w.waitForTimeout(500)
  check(
    newest().messages.length === sentBefore && conversations().length === before,
    'and sends nothing'
  )
  check(artifacts(chatId)[0].versions.length === a.versions.length, 'and nothing was restyled')
  await w.fill('textarea', '')

  step('Conflicting skills ask first')
  await turn('a conflict test')
  check(
    /Ask the user first/.test(lastResult()),
    `generation stopped with a question (${lastResult().slice(0, 80)})`
  )
  check(artifacts(chatId)[0].versions.length === a.versions.length, 'and nothing was saved')

  step('Export')
  await app.evaluate((_, p) => (globalThis.__save = p), `${EXPORTS}/landing`)
  await pane().getByRole('button', { name: 'Export', exact: true }).click()
  await w.waitForSelector('text=/Exported 3 files to/', { timeout: 5000 }).catch(() => {})
  check(
    fs.existsSync(`${EXPORTS}/landing/index.html`) &&
      fs.existsSync(`${EXPORTS}/landing/assets/logo.png`),
    'a page with files is exported as a folder'
  )
  await pane().getByRole('button', { name: 'Export', exact: true }).click()
  await w
    .waitForSelector('text=/already exists; choose a new folder name/', { timeout: 5000 })
    .catch(() => {})
  check(
    (await pane().innerText()).includes('already exists; choose a new folder name'),
    'never merged into an existing folder'
  )
  await turn('a second test')
  await app.evaluate((_, p) => (globalThis.__save = p), `${EXPORTS}/card.html`)
  await pane().getByRole('button', { name: 'Export', exact: true }).click()
  await w.waitForTimeout(500)
  check(
    fs.readFileSync(`${EXPORTS}/card.html`, 'utf8').includes('Second output'),
    'a single page is exported as a file'
  )
  await pane().getByRole('button', { name: 'Export', exact: true }).click()
  await w.waitForTimeout(500)
  const boxes = await app.evaluate(() => globalThis.__boxes)
  check(
    boxes.some((m) => /Replace card\.html\?/.test(m)),
    'replacing asks first'
  )
  for (const [where, what] of [
    [`${DATA}/settings-copy.html`, "Custard's own files"],
    [`${SKILLS}/brand-guide/page.html`, 'skills folder'],
    [`${OUT}/plugin/x.html`, 'plugin folder']
  ]) {
    await app.evaluate((_, p) => (globalThis.__save = p), where)
    await pane().getByRole('button', { name: 'Export', exact: true }).click()
    await w.waitForTimeout(400)
    check(
      (await pane().innerText()).includes(what) && !fs.existsSync(where),
      `export refuses ${what}`
    )
  }
  check(
    (await pane().locator('nav[aria-label=Outputs] button').count()) === 2,
    'two outputs, two tabs'
  )
  await shot('a-08-export')

  step('The page is contained')
  await turn('a probe test')
  const probe = /PROBE (\{[^}]*\})/.exec(lastResult())?.[1]
  const seen = probe ? JSON.parse(probe) : {}
  check(
    seen.custard === 'undefined' &&
      seen.require === 'undefined' &&
      seen.process === 'undefined' &&
      seen.ipc === 'undefined',
    `the page sees no Custard API, require or process (${probe})`
  )
  check(
    /\.preview\.invalid$/.test(seen.origin ?? ''),
    `its origin is the preview's own (${seen.origin})`
  )
  check(!/LEAKED/.test(lastResult()), 'fetch, XHR, WebSocket and window.open all failed')
  check(
    /requests? to outside the page blocked|Content Security Policy/.test(lastResult()),
    'the blocked loads are reported (by the CSP or the session)'
  )
  await w.waitForSelector('[data-preview-status=ready]', { timeout: 15000 })
  await w.waitForTimeout(1500)
  p = await preview()
  check(
    p && p.url.includes('.preview.invalid/index.html'),
    `the preview didn't navigate away (${p?.url})`
  )
  check(
    leaks().length === 0,
    `nothing reached the mock server (${JSON.stringify(leaks()).slice(0, 120)})`
  )
  check(
    (await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)) === 1,
    'no new window opened'
  )
  check(
    !(await app.evaluate(() => globalThis.__boxes)).some((m) => /alert from the page/.test(m)),
    'no dialog shown'
  )
  // Storage stays inside one preview.
  await app.evaluate(({ webContents }) =>
    webContents
      .getAllWebContents()
      .find((x) => x.getURL().includes('.preview.invalid'))
      ?.executeJavaScript('localStorage.setItem("k", "v")')
  )
  await pane().locator('nav[aria-label=Outputs] button').first().click()
  await w.waitForSelector('[data-preview-status=ready]', { timeout: 15000 })
  const ls = await app.evaluate(({ webContents }) =>
    webContents
      .getAllWebContents()
      .find((x) => x.getURL().includes('.preview.invalid'))
      ?.executeJavaScript('localStorage.getItem("k")')
  )
  check(ls === null, 'storage from one preview is not seen by the next')
  await shot('a-09-probe')

  step('A page that hangs')
  const t0 = Date.now()
  await send('a loop test')
  // The app answers while the check runs.
  await w.waitForTimeout(1500)
  const responsive = await Promise.race([
    w.evaluate(() => 1 + 1),
    new Promise((r) => setTimeout(() => r('timeout'), 2000))
  ])
  check(responsive === 2, 'the app stays responsive while it runs')
  await idle()
  check(
    /didn't load: it didn't finish loading within 10 s/.test(lastResult()),
    `the check stopped it (${Math.round((Date.now() - t0) / 1000)} s)`
  )
  await w
    .waitForSelector('text=/didn.t finish loading within 10 s/', { timeout: 20000 })
    .catch(() => {})
  check(
    (await pane().innerText()).includes("didn't finish loading within 10 s"),
    'the workspace says the preview was stopped'
  )
  await shot('a-10-loop')

  step('Narrow window')
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    win.setMinimumSize(300, 300)
    win.setSize(760, 900)
  })
  await w.setViewportSize({ width: 760, height: 900 })
  await w.waitForTimeout(500)
  await w.locator('button:text-is("Conversation"):visible').waitFor({ timeout: 5000 })
  check(await pane().isVisible(), 'outputs are shown on their own')
  await shot('a-11-narrow-outputs')
  await w.locator('button:text-is("Conversation"):visible').click()
  check(
    !(await pane()
      .isVisible()
      .catch(() => false)),
    'Conversation hides the outputs'
  )
  p = await preview()
  check(!p || p.bounds?.width === 0 || p.visible === false, 'and the preview with them')
  await shot('a-12-narrow-chat')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1400, 900))
  await w.setViewportSize({ width: 1400, height: 900 })
} catch (err) {
  console.log('✕ error:', err)
  process.exitCode = 1
} finally {
  await app?.close()
}

try {
  step('After a restart')
  await launch()
  await w.click('button:text-is("Design")')
  await w.click('button[title="Design history"]')
  await w.locator('aside button .truncate').first().click()
  await pane().waitFor({ timeout: 10000 })
  check(
    (await pane().locator('nav[aria-label=Outputs] button').count()) === 4,
    'all four outputs are back'
  )
  await pane().locator('nav[aria-label=Outputs] button').first().click()
  const sel = artifacts(chatId)[0]
  check(
    (await pane().locator('[aria-pressed=true]').innerText()).includes(
      `v${sel.versions.find((v) => v.id === sel.selected).n}`
    ),
    'with the selected version'
  )

  step('Deleting the chat')
  await w.click('button[title="Design history"]')
  const row = w.locator('aside .group').first()
  await row.hover()
  await row.locator('button[title=Delete]').click()
  await w.waitForTimeout(800)
  check(!fs.existsSync(`${DATA}/design/${chatId}`), "the chat's outputs are deleted")
  check(
    fs.existsSync(`${EXPORTS}/landing/index.html`) && fs.existsSync(`${EXPORTS}/card.html`),
    'exports are left alone'
  )
} catch (err) {
  console.log('✕ error:', err)
  process.exitCode = 1
} finally {
  await app?.close()
  fs.rmSync(`${SKILLS}/brand-guide`, { recursive: true, force: true })
  fs.rmSync(`${SKILLS}/print-layout`, { recursive: true, force: true })
}
