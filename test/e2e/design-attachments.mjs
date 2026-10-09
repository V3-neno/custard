// Workstream D: attachments in Design, in the built app, against
// test/e2e/interrupt-mock.mjs (with test/e2e/mocks/d-security.mjs and B's
// fake OpenAI Image API in mocks/b-images.mjs). Mock only.
//   - Design accepts attachments; an edit sends only the file it names, after
//     the approval card lists it
//   - no file name or text reaches the memory summarizer or a vault note,
//     through Design's tools or their labels
//   - a temporary Design chat with attachments is never summarized
//   - deleting the chat deletes its attachments, outputs and job records
//   - Code and Skills still refuse attachments
// Usage, from the repo root after `npx electron-vite build`:
//   node test/e2e/interrupt-mock.mjs <out> &   (with <out>/vault and <out>/plugin as for memory.mjs)
//   xvfb-run -a node test/e2e/design-attachments.mjs <out> <screenshot dir>
// Linux only as written. Needs the playwright package.
import { _electron as electron } from 'playwright'
import { createRequire } from 'module'
import fs from 'fs'
import path from 'path'
import { png } from './mocks/b-images.mjs'

const [, , OUT, SHOTS] = process.argv
const check = (cond, what) => {
  console.log((cond ? '✓ ' : '✕ ') + what)
  if (!cond) process.exitCode = 1
}
const step = (s) => console.log('\n## ' + s)
const CFG = OUT + '/cfg-design-d-att'
const DATA = `${CFG}/custard`
const VAULT = OUT + '/vault'
const FILES = OUT + '/d-files'
fs.rmSync(CFG, { recursive: true, force: true })
fs.mkdirSync(FILES, { recursive: true })
fs.mkdirSync(SHOTS, { recursive: true })
const SENT = 'Osprey-8890.png'
const KEPT = 'Velvet-5521.png'
const NOTE = 'Anchor-7713.md'
const FORBIDDEN = /osprey|8890|velvet|5521|anchor|7713|LEAK-/i
fs.writeFileSync(`${FILES}/${SENT}`, png(2, 2))
fs.writeFileSync(`${FILES}/${KEPT}`, png(3, 3))
fs.writeFileSync(`${FILES}/${NOTE}`, 'LEAK-ANCHOR-7713 heron quartz\n')

const read = (f, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'))
  } catch {
    return fallback
  }
}
const summariesAll = () => read(OUT + '/memory.json', [])
const summariesFrom = summariesAll().length
// The mock keeps its log across runs: only this run's calls.
const summaries = () => summariesAll().slice(summariesFrom)
const openaiCalls = () => read(OUT + '/b-images.json', [])
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
const byId = (id) => conversations().find((c) => c.id === id)
const vaultFiles = (dir = VAULT) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    return e.isDirectory() ? vaultFiles(p) : [{ p, text: fs.readFileSync(p, 'utf8') }]
  })
const vaultBefore = new Set(vaultFiles().map((f) => f.p))
const until = async (f, ms = 15000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await f()) return true
    await new Promise((r) => setTimeout(r, 150))
  }
  return false
}

const app = await electron.launch({
  executablePath: createRequire(import.meta.url)('electron'),
  args: [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), '--password-store=basic', '.'],
  env: {
    ...process.env,
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:8899',
    OPENAI_BASE_URL: 'http://127.0.0.1:8899/v1',
    XDG_CONFIG_HOME: CFG,
    CUSTARD_PLUGIN_DIR: OUT + '/plugin'
  }
})
await app.evaluate(({ safeStorage, dialog }, vault) => {
  safeStorage.setUsePlainTextEncryption?.(true)
  globalThis.__pick = null
  dialog.showOpenDialog = async () => ({
    canceled: false,
    filePaths: globalThis.__pick ?? [vault]
  })
  dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
}, VAULT)
let w = null
for (let i = 0; !w && i < 300; i++) {
  w = app.windows().find((x) => x.url().endsWith('/renderer/index.html')) ?? null
  if (!w) await new Promise((r) => setTimeout(r, 100))
}
await w.setViewportSize({ width: 1400, height: 900 })
w.on('pageerror', (e) => console.log('pageerror:', e.message))
await w.waitForSelector('text=Custard')

const send = async (t) => {
  await w.fill('textarea', t)
  await w.keyboard.press('Enter')
}
const idle = () => w.waitForSelector('button[title=Send]', { timeout: 40000 })
const card = () => w.locator('[role=alertdialog]').first()
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
  if (text !== null) await card().getByRole('button', { name: answer, exact: true }).click()
  await idle()
  return text
}
const attach = async (names) => {
  await app.evaluate(
    (_, p) => (globalThis.__pick = p),
    names.map((n) => `${FILES}/${n}`)
  )
  await w.click('button[aria-label="Attach files"]')
  await w.waitForFunction(
    (n) => document.querySelectorAll('[aria-label="Files to send"] li').length >= n,
    names.length
  )
  await app.evaluate(() => (globalThis.__pick = null))
}
const newChat = async () => {
  await w.click('button[title="Design history"]')
  await w.click('button:has-text("New design")')
}
const tempSwitch = '[aria-label="Temporary chat"]'

try {
  step('Setup: keys, vault, OpenAI images')
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
  await w.click('button:text-is("Done")')
  await w.click('button:text-is("Design")')

  step('An edit sends only the file it names')
  await attach([SENT, KEPT, NOTE])
  // The mock keeps its log across runs: count from here.
  const openaiBefore = openaiCalls().length
  const cardText = await turn('d ref test')
  const chatId = newest()?.id
  check(
    new RegExp(`Files sent to OpenAI Images: ${SENT.replace('.', '\\.')}`).test(cardText ?? ''),
    `the approval card lists the file it sends (${(cardText ?? '').slice(0, 120)})`
  )
  check(!(cardText ?? '').includes(KEPT), 'and not the other image')
  const calls = openaiCalls().slice(openaiBefore)
  const files = calls.at(-1)?.files ?? []
  check(
    calls.length === 1 && files.length === 1 && files[0].name === SENT,
    `one OpenAI request carrying only ${SENT} (${JSON.stringify(files)})`
  )
  await turn('d page test')
  await w.screenshot({ path: `${SHOTS}/d-att-01.png` })

  step('Memory: no file name or text reaches the summarizer or the vault')
  check(
    await until(() => byId(chatId)?.memory?.job?.status === 'saved', 20000),
    `the Design chat was remembered (${byId(chatId)?.memory?.job?.status})`
  )
  const evidence = summaries()
    .map((s) => s.evidence)
    .join('\n')
  console.log(
    '  evidence:',
    evidence
      .split('\n')
      .filter((l) => /^- A/.test(l))
      .join(' | ')
      .slice(0, 300)
  )
  check(
    summaries().length > 0 && !FORBIDDEN.test(evidence),
    'the summarizer saw no file name or text'
  )
  const added = vaultFiles().filter((f) => !vaultBefore.has(f.p))
  check(
    vaultFiles().every((f) => !FORBIDDEN.test(f.text) && !FORBIDDEN.test(f.p)),
    `no vault note or name holds a file name or text (${added.length} new notes)`
  )

  step('A temporary Design chat with attachments is never summarized')
  const before = summaries().length
  await newChat()
  await w.click(tempSwitch)
  check((await w.getAttribute(tempSwitch, 'aria-checked')) === 'true', 'the chat is temporary')
  await attach([SENT])
  await turn('d ref test')
  const tempId = newest()?.id
  await new Promise((r) => setTimeout(r, 2500))
  check(byId(tempId)?.memory?.temporary === true, 'it is saved as temporary')
  check(summaries().length === before, 'it was not summarized')

  step('Deleting the chat deletes its files, outputs and jobs')
  const attDir = `${DATA}/attachments/${chatId}`
  const outDir = `${DATA}/design/${chatId}`
  const jobsHad = () => JSON.stringify(read(`${DATA}/design/jobs.json`, {})).includes(chatId)
  check(
    fs.existsSync(attDir) && fs.readdirSync(attDir).length > 0,
    'the chat has stored attachments'
  )
  check(fs.existsSync(outDir), 'and stored outputs')
  check(jobsHad(), 'and job records')
  await w.evaluate((id) => window.custard.conversations.delete(id), chatId)
  check(await until(() => !fs.existsSync(attDir)), 'its attachments are gone')
  check(await until(() => !fs.existsSync(outDir)), 'its outputs are gone')
  check(await until(() => !jobsHad()), 'its job records are gone')

  step('Other modes still refuse attachments')
  for (const mode of ['Code', 'Skills']) {
    await w.click(`button:text-is("${mode}")`)
    await w.waitForTimeout(300)
    const button = w.locator('button[aria-label="Attach files"]')
    const shown = (await button.count()) > 0 && (await button.isVisible())
    const enabled = shown && (await button.isEnabled())
    check(!enabled, `${mode}: no way to attach (${shown ? 'button disabled' : 'no button'})`)
  }
} catch (err) {
  console.log('✕ crashed:', err)
  await w.screenshot({ path: `${SHOTS}/d-att-error.png` }).catch(() => {})
  process.exitCode = 1
} finally {
  await app.close()
}
