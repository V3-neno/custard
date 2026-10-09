// Stabilization item 3.3: generated media in the real Design workspace, in
// the built app, against the fake OpenAI Image API in
// test/e2e/mocks/s3-image-workspace.mjs and the dev-only slowmo video plugin.
// Mock only: nothing here reaches OpenAI or any real provider.
//
// Images, one path end to end:
//   request → approval card → stored result → the image drawn in the
//   workspace pane (checked by sampling the pixels the window composited,
//   not by finding the element) → an edit as v2 → selecting v1 again →
//   restart and reopen the chat → the selected version is drawn again →
//   export and "Save a copy" write the stored bytes.
// Also: a repeat of an edit whose outcome is unknown shows Design's card
// with the provider, operation, files, the rate wording and the warning.
// Video, through the same workspace (not a detached <video>):
//   a finished plugin video plays in the pane; a video still in progress
//   shows its job state with Check now / Cancel job / Stop tracking.
//
// Usage, from the repo root after `npx electron-vite build`:
//   node test/e2e/interrupt-mock.mjs <out> &
//   xvfb-run -a node test/e2e/design-image-workspace.mjs <out> <screenshot dir>
// Linux only as written. Needs the playwright package.
import { _electron as electron } from 'playwright'
import { createRequire } from 'module'
import crypto from 'crypto'
import fs from 'fs'
import { AMBER, BLUE, solidPng } from './mocks/s3-image-workspace.mjs'

const [, , OUT, SHOTS] = process.argv
const check = (cond, what) => {
  console.log((cond ? '✓ ' : '✕ ') + what)
  if (!cond) process.exitCode = 1
}
const step = (s) => console.log('\n## ' + s)
const CFG = OUT + '/cfg-s3-workspace'
const DATA = `${CFG}/custard`
const FILES = OUT + '/s3-files'
const EXPORTS = OUT + '/s3-exports'
const VAULT = OUT + '/s3-vault'
const PLUGINS = OUT + '/s3-plugins'
for (const d of [CFG, EXPORTS, VAULT, PLUGINS]) fs.rmSync(d, { recursive: true, force: true })
fs.rmSync(OUT + '/s3-images.json', { force: true })
for (const d of [FILES, EXPORTS, VAULT, PLUGINS, SHOTS]) fs.mkdirSync(d, { recursive: true })
fs.cpSync('test/fixtures/media-plugins/slowmo', `${PLUGINS}/slowmo`, { recursive: true })
fs.writeFileSync(`${FILES}/lantern-ref.png`, solidPng(8, 8, AMBER))

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')
const read = (f, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'))
  } catch {
    return fallback
  }
}
const requests = () => read(OUT + '/s3-images.json', [])
const artifacts = (chat) =>
  read(`${DATA}/design/${chat}/artifacts.json`, { artifacts: [] }).artifacts
const newestChat = () => {
  const dir = `${DATA}/conversations`
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(`${dir}/${f}`, 'utf8')))
    .sort((a, b) => b.updatedAt - a.updatedAt)[0]?.id
}

let app = null
let w = null
async function launch() {
  app = await electron.launch({
    executablePath: createRequire(import.meta.url)('electron'),
    args: [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), '--password-store=basic', '.'],
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:8899',
      OPENAI_BASE_URL: 'http://127.0.0.1:8899/s3/v1',
      XDG_CONFIG_HOME: CFG,
      CUSTARD_PLUGIN_DIR: PLUGINS
    }
  })
  await app.evaluate(({ safeStorage, dialog }, vault) => {
    safeStorage.setUsePlainTextEncryption?.(true)
    globalThis.__open = [vault]
    globalThis.__save = null
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: globalThis.__open })
    dialog.showSaveDialog = async () =>
      globalThis.__save ? { canceled: false, filePath: globalThis.__save } : { canceled: true }
    dialog.showMessageBox = async () => ({ response: 1 })
  }, VAULT)
  w = null
  for (let i = 0; !w && i < 300; i++) {
    w = app.windows().find((x) => x.url().endsWith('/renderer/index.html')) ?? null
    if (!w) await new Promise((r) => setTimeout(r, 100))
  }
  await w.setViewportSize({ width: 1400, height: 900 })
  w.on('pageerror', (e) => console.log('pageerror:', e.message))
  await w.waitForSelector('text=Custard')
}

const shot = (n) => w.screenshot({ path: `${SHOTS}/${n}.png` })
const send = async (t) => {
  await w.fill('textarea', t)
  await w.keyboard.press('Enter')
}
const idle = () => w.waitForSelector('button[title=Send]', { timeout: 40000 })
const card = () => w.locator('[role=alertdialog]').first()
// Sends; answers the first approval card with `answer` ('keep' leaves it).
const turn = async (t, answer = 'Allow') => {
  let text = null
  const watch = card()
    .waitFor({ timeout: 30000 })
    .then(async () => (text = await card().innerText()))
    .catch(() => {})
  await send(t)
  await Promise.race([idle(), watch])
  if (text !== null && answer !== 'keep')
    await card().getByRole('button', { name: answer, exact: true }).click()
  if (answer !== 'keep') await idle()
  return text
}
const pane = () => w.locator('aside[aria-label="Design outputs"]')
const versionButton = (n) =>
  pane().locator('[aria-label=Versions] button', { hasText: new RegExp(`^(◇ )?v${n}\\b`) })
const paneImage = () => pane().locator('img')

// What the window actually drew at the centre of the pane's image: the
// composited pixels, read back from the main process.
async function drawnColour() {
  const img = paneImage()
  await img.waitFor({ timeout: 10000 })
  const loaded = await img.evaluate((el) =>
    el.complete ? { ok: el.naturalWidth > 0, w: el.naturalWidth, h: el.naturalHeight } : null
  )
  const box = await img.boundingBox()
  if (!loaded?.ok || !box) return { loaded, rgb: null }
  const rect = {
    x: Math.round(box.x + box.width / 2) - 2,
    y: Math.round(box.y + box.height / 2) - 2,
    width: 4,
    height: 4
  }
  const rgb = await app.evaluate(async ({ BrowserWindow }, r) => {
    const win = BrowserWindow.getAllWindows().find((x) => x.isVisible())
    const image = await win.webContents.capturePage(r)
    const bmp = image.toBitmap() // BGRA
    const s = image.getSize()
    const i = (Math.floor(s.height / 2) * s.width + Math.floor(s.width / 2)) * 4
    return [bmp[i + 2], bmp[i + 1], bmp[i]]
  }, rect)
  return { loaded, rgb, box }
}
const near = (a, b) => !!a && a.every((x, k) => Math.abs(x - b[k]) <= 6)
const waitDrawn = async (want) => {
  let got = null
  for (let i = 0; i < 40; i++) {
    got = await drawnColour().catch(() => null)
    if (near(got?.rgb, want)) return got
    await w.waitForTimeout(150)
  }
  return got
}
const pressed = async () =>
  (await pane().locator('[aria-label=Versions] button[aria-pressed=true]').innerText()).trim()

let chat = null
try {
  await launch()
  step('Setup: keys, vault, OpenAI Images, the slowmo video plugin')
  await w.click('button[title=Settings]')
  await w.fill('input[aria-label="Claude API key"]', 'sk-ant-test')
  await w.press('input[aria-label="Claude API key"]', 'Enter')
  await w.fill('input[aria-label="OpenAI API key"]', 'sk-openai-test')
  await w.press('input[aria-label="OpenAI API key"]', 'Enter')
  await w.waitForSelector('text=OpenAI API key · saved')
  await w.click('button:has-text("Use an existing vault")')
  await w.waitForSelector('text=· connected')
  await w.getByRole('tab', { name: 'Design' }).click()
  await w.selectOption('#design-image-provider', 'openai-images')
  await w.waitForSelector('#design-image-model')
  await w.click('button:text-is("Plugins")')
  await w.click('button:has-text("Slowmo")')
  await w.click('button:has-text("Review and activate")')
  await w.waitForSelector('text=New permissions to approve', { timeout: 30000 })
  const boxes = w.locator('section:has-text("New permissions to approve") input[type=checkbox]')
  for (let i = 0; i < (await boxes.count()); i++) await boxes.nth(i).check()
  await w.click('button:text-matches("^Activate [0-9]")')
  await w.waitForSelector('button:text-is("Disable")', { timeout: 30000 })
  // Chat, Design and Skills use a plugin only once it's turned on for them.
  await w.click('label:has-text("in Chat, Design and Skills") input[type=checkbox]')
  await w.waitForSelector('label:has-text("in Chat, Design and Skills") input:checked')
  await w.click('button:text-is("Done")')

  step('Request → approval → stored result → drawn in the workspace')
  await w.click('button:text-is("Design")')
  const asked = await turn('s3 gen test', 'keep')
  check(asked !== null, 'an approval card shows first')
  check(requests().length === 0, 'nothing is sent while it waits')
  check(
    /Pricing, not a quote for this request: .*per 1M tokens/.test(asked ?? '') &&
      /doesn't know the total before it runs/.test(asked ?? ''),
    'the card gives the published rate as a rate, not as the price of this request'
  )
  await card().getByRole('button', { name: 'Allow', exact: true }).click()
  await idle()
  check(requests().length === 1, `one request (${requests().length})`)
  chat = newestChat()
  await pane().waitFor({ timeout: 10000 })
  const first = await waitDrawn(AMBER)
  check(
    first?.loaded?.ok && first.loaded.w === 64 && first.loaded.h === 48,
    `the workspace image loaded its stored file (${JSON.stringify(first?.loaded)})`
  )
  check(near(first?.rgb, AMBER), `and the window drew it (centre pixel ${first?.rgb})`)
  check(
    (await pane().innerText()).includes('64×48') &&
      /OpenAI · gpt-image-2\.5-sunburst/.test(await pane().innerText()),
    "the viewer's footer shows the decoded size and the source"
  )
  await shot('s3-01-v1-drawn')

  step('Revision: an edit becomes v2 and is drawn')
  await app.evaluate((_, p) => (globalThis.__open = p), [`${FILES}/lantern-ref.png`])
  await w.click('button[aria-label="Attach files"]')
  await w.waitForSelector('[aria-label="Files to send"] li')
  await turn('s3 edit test')
  check(requests().at(-1)?.path === '/s3/v1/images/edits', 'the edit was sent once')
  const v2 = await waitDrawn(BLUE)
  check(near(v2?.rgb, BLUE), `v2 (the edit) is drawn (centre pixel ${v2?.rgb})`)
  check(/^v2/.test(await pressed()), `v2 is the selected version (${await pressed()})`)
  const origin = await pane()
    .locator('span[title]', { hasText: /^v2 · / })
    .first()
    .innerText()
    .catch(() => '')
  check(
    /^v2 · Change to v1: an edit of an attached image/.test(origin),
    `the viewer says it is an edit of an attached image (${origin})`
  )

  step('Version selection')
  await versionButton(1).click()
  const back = await waitDrawn(AMBER)
  check(near(back?.rgb, AMBER), `selecting v1 draws v1 again (centre pixel ${back?.rgb})`)
  check(/^v1/.test(await pressed()), 'v1 is shown as selected')
  let saved = artifacts(chat)[0]
  check(saved?.selected === saved?.versions[0]?.id, 'the selection is saved')
  await shot('s3-02-v1-selected')

  step('A repeat of an unknown edit: the card keeps everything')
  await turn('s3 fail test')
  const n = requests().length
  check(/s3fail/.test(requests().at(-1)?.prompt ?? ''), 'the failing edit was sent once')
  const repeat = await turn('s3 fail test', "Don't allow")
  check(
    /may already have happened/i.test(repeat ?? '') &&
      /Provider: OpenAI Images/.test(repeat ?? '') &&
      /Operation: Edit an image/.test(repeat ?? '') &&
      /Files sent to OpenAI Images: lantern-ref\.png/.test(repeat ?? '') &&
      /Pricing, not a quote for this request/.test(repeat ?? ''),
    `the repeat card names the provider, operation, files, rate and the warning (${(repeat ?? '').replace(/\s+/g, ' ').slice(0, 200)})`
  )
  check(requests().length === n, 'declining it sent nothing')
  check(near((await waitDrawn(AMBER))?.rgb, AMBER), 'the workspace still draws the selected v1')
} catch (err) {
  console.log('✕ crashed:', err)
  process.exitCode = 1
  await shot('s3-error').catch(() => {})
} finally {
  await Promise.race([app?.close().catch(() => {}), new Promise((r) => setTimeout(r, 5000))])
}

try {
  step('Restart and reopen')
  await launch()
  await w.click('button:text-is("Design")')
  await w.click('button[title="Design history"]')
  await w.locator('aside button .truncate').first().click()
  await pane().waitFor({ timeout: 10000 })
  const again = await waitDrawn(AMBER)
  check(near(again?.rgb, AMBER), `after a restart the selected v1 is drawn (${again?.rgb})`)
  check(/^v1/.test(await pressed()), 'and shown as selected')
  check(
    requests().every((r) => r.keyOk),
    'every request used the saved key'
  )

  step('Export')
  const stored = (v) => {
    const a = artifacts(chat)[0]
    const ver = a.versions[v - 1]
    return fs.readFileSync(`${DATA}/design/${chat}/${a.id}/${ver.id}/${ver.files[0].path}`)
  }
  await app.evaluate((_, p) => (globalThis.__save = p), `${EXPORTS}/lantern-v1.png`)
  await pane().getByRole('button', { name: 'Export', exact: true }).click()
  await w.waitForSelector('text=/Exported to/', { timeout: 5000 }).catch(() => {})
  const out1 = fs.existsSync(`${EXPORTS}/lantern-v1.png`)
    ? fs.readFileSync(`${EXPORTS}/lantern-v1.png`)
    : null
  check(
    !!out1 && sha(out1) === sha(stored(1)) && sha(out1) === sha(solidPng(64, 48, AMBER)),
    'Export writes the selected version (v1) byte for byte'
  )
  await versionButton(2).click()
  check(near((await waitDrawn(BLUE))?.rgb, BLUE), 'selecting v2 after the restart draws v2')
  await app.evaluate((_, p) => (globalThis.__save = p), `${EXPORTS}/lantern-v2.png`)
  await pane().getByRole('button', { name: 'Save a copy', exact: true }).click()
  await w.waitForSelector('text=/Saved to/', { timeout: 5000 }).catch(() => {})
  const out2 = fs.existsSync(`${EXPORTS}/lantern-v2.png`)
    ? fs.readFileSync(`${EXPORTS}/lantern-v2.png`)
    : null
  check(
    !!out2 && sha(out2) === sha(stored(2)) && sha(out2) === sha(solidPng(64, 48, BLUE)),
    "the viewer's Save a copy writes v2 byte for byte"
  )
  await shot('s3-03-after-restart')

  step('Video in the same workspace')
  await turn('c video test')
  await pane()
    .locator('video')
    .waitFor({ timeout: 10000 })
    .catch(() => {})
  const video = await pane()
    .locator('video')
    .evaluate(
      (v) =>
        new Promise((resolve) => {
          const done = () => resolve({ ok: true, w: v.videoWidth, h: v.videoHeight, d: v.duration })
          if (v.readyState >= 1) return done()
          v.onloadedmetadata = done
          v.onerror = () => resolve({ ok: false, error: v.error?.code })
          setTimeout(() => resolve({ ok: false, error: 'timeout' }), 8000)
        })
    )
    .catch((e) => ({ ok: false, error: String(e).slice(0, 80) }))
  check(
    video.ok && video.w === 160 && Math.round(video.d) === 2,
    `the finished plugin video loads in the workspace's own player (${JSON.stringify(video)})`
  )
  const played = await pane()
    .locator('video')
    .evaluate(async (v) => {
      v.muted = true
      await v.play()
      await new Promise((r) => setTimeout(r, 600))
      v.pause()
      return v.currentTime
    })
    .catch(() => 0)
  check(played > 0, `and plays there (currentTime ${played.toFixed?.(2)})`)
  await shot('s3-04-video')

  step('A video still in progress, in the workspace')
  await turn('s3 long video test')
  const text = await pane().innerText()
  const controls = ['Check now', 'Cancel job', 'Stop tracking'].filter((b) => text.includes(b))
  console.log(`  pane shows: ${text.replace(/\s+/g, ' ').slice(0, 160)}`)
  check(
    controls.length === 3,
    `the pending video shows its job state and controls in the workspace; needs request stab-3 R1 (found: ${controls.join(', ') || 'none'})`
  )
  await shot('s3-05-video-pending')
} catch (err) {
  console.log('✕ crashed (after restart):', err)
  process.exitCode = 1
  await shot('s3-error-2').catch(() => {})
} finally {
  await Promise.race([app?.close().catch(() => {}), new Promise((r) => setTimeout(r, 5000))])
}
