// Workstream B (OpenAI images) in the built app, against the fake OpenAI
// Image API in test/e2e/mocks/b-images.mjs. Mock only: nothing here reaches
// OpenAI, so it says nothing about the live API, its models or prices.
//   - Design settings: choose OpenAI Images and a model; what Design can do
//   - generate: one approval card naming OpenAI, the operation and the price
//     source; one request with the chosen model and the saved key, no retry;
//     the image is saved on its version and the app window can show it
//   - edit: the attached file is sent, and only after approval
//   - variation: unsupported, nothing sent and no card
//   - a 500: one request, outcome unknown, never resent
//   - a refusal (400): failed, the reason is kept, the last good image stays
//   - declined: nothing sent
//   - the OpenAI key is in no Design file
// Usage, from the repo root after `npx electron-vite build`:
//   node test/e2e/interrupt-mock.mjs <out> &
//   xvfb-run -a node test/e2e/design-images.mjs <out> <screenshot dir>
// Linux only as written. Needs the playwright package.
import { _electron as electron } from 'playwright'
import { createRequire } from 'module'
import fs from 'fs'
import { png } from './mocks/b-images.mjs'

const [, , OUT, SHOTS] = process.argv
const check = (cond, what) => {
  console.log((cond ? '✓ ' : '✕ ') + what)
  if (!cond) process.exitCode = 1
}
const step = (s) => console.log('\n## ' + s)
const CFG = OUT + '/cfg-images'
const DATA = `${CFG}/custard`
const FILES = OUT + '/b-files'
fs.rmSync(CFG, { recursive: true, force: true })
fs.rmSync(OUT + '/b-images.json', { force: true })
fs.mkdirSync(FILES, { recursive: true })
fs.mkdirSync(SHOTS, { recursive: true })

const read = (f, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'))
  } catch {
    return fallback
  }
}
const imageRequests = () => read(OUT + '/b-images.json', [])
const conversations = () => {
  const dir = `${DATA}/conversations`
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(`${dir}/${f}`, 'utf8')))
}
const newest = () => conversations().sort((a, b) => b.updatedAt - a.updatedAt)[0]
const lastResult = () =>
  (newest()?.messages ?? [])
    .flatMap((m) =>
      Array.isArray(m.content)
        ? m.content.filter((x) => x.type === 'tool_result').map((x) => String(x.content))
        : []
    )
    .at(-1) ?? ''
const artifacts = (chat) =>
  read(`${DATA}/design/${chat}/artifacts.json`, { artifacts: [] }).artifacts
const jobs = () => {
  const j = read(`${DATA}/design/jobs.json`, {})
  return Array.isArray(j) ? j : (j.jobs ?? [])
}

// A small real PNG to attach.
fs.writeFileSync(`${FILES}/kettle.png`, png(2, 2))

const app = await electron.launch({
  executablePath: createRequire(import.meta.url)('electron'),
  args: [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), '--password-store=basic', '.'],
  env: {
    ...process.env,
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:8899',
    OPENAI_BASE_URL: 'http://127.0.0.1:8899/v1',
    XDG_CONFIG_HOME: CFG
  }
})
await app.evaluate(({ safeStorage, dialog }) => {
  safeStorage.setUsePlainTextEncryption?.(true)
  globalThis.__pick = []
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: globalThis.__pick })
})
const pickNext = (names) =>
  app.evaluate(
    (_, paths) => (globalThis.__pick = paths),
    names.map((n) => `${FILES}/${n}`)
  )
let w = null
for (let i = 0; !w && i < 300; i++) {
  w = app.windows().find((x) => x.url().endsWith('/renderer/index.html')) ?? null
  if (!w) await new Promise((r) => setTimeout(r, 100))
}
await w.setViewportSize({ width: 1280, height: 900 })
w.on('pageerror', (e) => console.log('pageerror:', e.message))
await w.waitForSelector('text=Custard')
const shot = (n) => w.screenshot({ path: `${SHOTS}/${n}.png` })
const send = async (t) => {
  await w.fill('textarea', t)
  await w.keyboard.press('Enter')
}
const idle = () => w.waitForSelector('button[title=Send]', { timeout: 30000 })
const card = () => w.locator('[role=alertdialog]').first()
// Sends, and answers the approval card if one shows. Returns its text.
const turn = async (t, answer = 'Allow') => {
  let text = null
  const watch = card()
    .waitFor({ timeout: 30000 })
    .then(async () => {
      text = await card().textContent()
    })
    .catch(() => {})
  await send(t)
  await Promise.race([idle(), watch])
  if (text !== null) {
    if (answer === 'shot') return text
    await card().getByRole('button', { name: answer, exact: true }).click()
  }
  await idle()
  return text
}
// Loads a stored file through custard-media:// in the app window.
const loads = (url) =>
  w.evaluate(
    (u) =>
      new Promise((r) => {
        const img = new Image()
        img.onload = () => r({ ok: true, w: img.naturalWidth, h: img.naturalHeight })
        img.onerror = () => r({ ok: false })
        img.src = u
      }),
    url
  )

try {
  step('Setup: keys')
  await w.click('button[title=Settings]')
  await w.fill('input[aria-label="Claude API key"]', 'sk-ant-test')
  await w.press('input[aria-label="Claude API key"]', 'Enter')
  await w.fill('input[aria-label="OpenAI API key"]', 'sk-openai-test')
  await w.press('input[aria-label="OpenAI API key"]', 'Enter')
  await w.waitForSelector('text=OpenAI API key · saved')

  step('Design settings')
  await w.getByRole('tab', { name: 'Design' }).click()
  await w.waitForSelector('#design-image-provider')
  const before = await w.locator('text=What Design can do now').locator('..').textContent()
  check(
    /No default image provider is chosen/.test(before),
    'with no provider chosen, Design says so instead of picking one'
  )
  check(
    /Video from text.*no video generator of its own/.test(before),
    'video is unavailable without a plugin'
  )
  await w.selectOption('#design-image-provider', 'openai-images')
  await w.waitForSelector('#design-image-model')
  const models = await w.locator('#design-image-model option').allTextContents()
  check(
    models.join() === 'GPT Image 2.5 Sunburst,GPT Image 2.5 Flare,GPT Image 2',
    `only current image models are offered (${models.join(', ')})`
  )
  await w.waitForFunction(() => /Generate images\s*available/.test(document.body.textContent ?? ''))
  const after = await w.locator('text=What Design can do now').locator('..').textContent()
  check(/Generate images\s*available/.test(after), 'generating images becomes available')
  check(/Edit images\s*available · .*may change parts/.test(after), 'editing is marked uncertain')
  check(
    /Image variations.*doesn't offer image variations/.test(after),
    'variations are unsupported'
  )
  await shot('b-01-design-settings')
  const settings = read(`${DATA}/settings.json`, {})
  check(!JSON.stringify(settings).includes('sk-openai-test'), 'Design settings hold no key')
  await w.click('button:text-is("Done")')

  step('Generate')
  await w.click('button:text-is("Design")')
  const asked = await turn('b gen test', 'shot')
  check(asked !== null, 'an approval card shows before anything is sent')
  check(imageRequests().length === 0, 'nothing is sent while the card waits')
  check(
    /OpenAI Images: Generate an image/.test(asked ?? '') &&
      /Pricing, not a quote for this request: image output \$30\.00,.*per 1M tokens.*\(from OpenAI API pricing page/.test(
        asked ?? ''
      ) &&
      /can't be cancelled/.test(asked ?? '') &&
      /No files are sent/.test(asked ?? ''),
    'the card names OpenAI, the operation, the price with its source and no files'
  )
  await shot('b-02-approval')
  await card().getByRole('button', { name: 'Allow', exact: true }).click()
  await idle()
  let reqs = imageRequests()
  check(reqs.length === 1, `one request reached OpenAI (${reqs.length})`)
  check(
    reqs[0]?.path === '/v1/images/generations' &&
      reqs[0].model === 'gpt-image-2.5-sunburst' &&
      reqs[0].n === 1 &&
      reqs[0].output_format === 'png',
    'it asked the chosen image model for one png'
  )
  check(reqs[0]?.keyOk === true, 'with the OpenAI key saved in AI settings')
  check(
    /^Made by OpenAI Images/.test(lastResult()),
    `the model is told it's made (${lastResult().slice(0, 50)})`
  )
  const chat = newest().id
  let outs = artifacts(chat)
  const v1 = outs[0]?.versions[0]
  check(
    outs.length === 1 &&
      outs[0].kind === 'image' &&
      v1?.status === 'succeeded' &&
      v1.source.kind === 'image-provider' &&
      v1.source.model === 'gpt-image-2.5-sunburst' &&
      v1.files[0]?.mime === 'image/png',
    'the image is saved as an image output with its source'
  )
  const url = `custard-media://${chat}/${outs[0].id}/${v1.id}/${v1.files[0].path}`
  const shown = await loads(url)
  check(shown.ok && shown.w === 3 && shown.h === 2, 'the app window can show it')
  await shot('b-03-generated')

  step('Edit with an attached file')
  await pickNext(['kettle.png'])
  await w.click('button[aria-label="Attach files"]')
  await w.waitForSelector('[aria-label="Files to send"] li')
  const editCard = await turn('b edit test', 'shot')
  check(
    /OpenAI Images: Edit an image/.test(editCard ?? '') &&
      /Files sent to OpenAI Images: kettle\.png/.test(editCard ?? '') &&
      /may change parts of the image/.test(editCard ?? ''),
    'the card names the file sent and that unchanged parts may change'
  )
  await card().getByRole('button', { name: 'Allow', exact: true }).click()
  await idle()
  reqs = imageRequests()
  const e = reqs.at(-1)
  check(
    reqs.length === 2 &&
      e.path === '/v1/images/edits' &&
      e.multipart &&
      e.files?.some((f) => f.name === 'kettle.png' && f.type === 'image/png'),
    'the edit sent the attached image'
  )
  outs = artifacts(chat)
  const v2 = outs[0]?.versions[1]
  check(
    v2?.relation === 'revision' && v2.parent === v1.id && v2.status === 'succeeded',
    'the edit is a new version of the same output; the first is unchanged'
  )

  step('Variation: unsupported')
  check((await turn('b variation test')) === null, 'no approval card')
  check(
    /isn't available \(unsupported\)/.test(lastResult()),
    `refused: ${lastResult().slice(0, 70)}`
  )
  check(imageRequests().length === 2, 'nothing was sent')

  step('Server error: unknown, never resent')
  await turn('b fail test')
  reqs = imageRequests()
  check(reqs.length === 3 && reqs.at(-1).retry === '0', 'one request, no automatic retry')
  check(
    /Don't send it again without asking the user/.test(lastResult()),
    'the model is told not to send it again'
  )
  check(
    jobs().some((j) => j.state === 'unknown'),
    'the job is recorded as outcome unknown'
  )

  step('Declined: nothing sent')
  await turn('b gen test', "Don't allow")
  check(imageRequests().length === 3, 'nothing was sent')
  check(/declined/.test(lastResult()), 'the model is told it was declined')

  step('Refused: failed with the reason')
  await turn('b refuse test')
  check(imageRequests().length === 4, 'one request')
  check(/rejected by the safety system/.test(lastResult()), 'the reason is passed on')
  check(
    jobs().some((j) => j.state === 'failed'),
    'the job is failed'
  )
  check(artifacts(chat)[0].versions[1].status === 'succeeded', 'the last good image stays')
  await shot('b-04-refused')
  // A refusal is about that prompt, not the provider: the next request still
  // goes to the card. (Request B3: design_media records every failed job as a
  // session-wide failure of the operation.)
  const next = await turn('b gen test', "Don't allow")
  check(
    next !== null,
    `after a refused prompt, a new one still asks instead of being blocked (${lastResult().slice(0, 80)})`
  )

  step('The key stays out of Design files')
  const files = []
  const walk = (d) => {
    for (const n of fs.readdirSync(d, { withFileTypes: true }))
      n.isDirectory() ? walk(`${d}/${n.name}`) : files.push(`${d}/${n.name}`)
  }
  walk(`${DATA}/design`)
  check(
    files.length > 0 &&
      files.every((f) => !fs.readFileSync(f, 'latin1').includes('sk-openai-test')),
    `no Design file contains the OpenAI key (${files.length} files)`
  )
} catch (err) {
  console.error(err)
  process.exitCode = 1
  await shot('b-error').catch(() => {})
} finally {
  await app.close()
}
