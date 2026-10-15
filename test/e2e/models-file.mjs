// The user's models file (Workstream A, Phase A4), in the built app against
// a stand-in for Claude and DeepSeek that this script runs itself (no
// request reaches a provider). models.json is in Custard's data folder:
//   - Settings → Models file shows its path, the loaded entries (added or
//     customised) and the rejected ones with the reason
//   - an added DeepSeek model is in the picker, is sent with its own id and
//     effort, and the chat gets its limits and price
//   - a customised built-in shows its new label
//   - Reload waits while a chat is answering
//   - Reload after the model is taken out of the file: its chat says the
//     profile is missing
//   - a file that isn't JSON, or no file: nothing from it loads, the built-in
//     models stay
// Usage, from the repo root after `npx electron-vite build`:
//   node test/e2e/models-file.mjs <out> <screenshot dir>
// with <out>/vault a copy of vault-template/. Linux only as written, with a
// display or xvfb-run. Needs the playwright package.
import { _electron as electron } from 'playwright'
import { createRequire } from 'module'
import fs from 'fs'
import http from 'http'

const [, , OUT, SHOTS] = process.argv
const check = (cond, what) => {
  console.log((cond ? '✓ ' : '✕ ') + what)
  if (!cond) process.exitCode = 1
}
const step = (s) => console.log('\n## ' + s)
const CFG = OUT + '/cfg-models-file'
const VAULT = OUT + '/vault'
const DATA = `${CFG}/custard`
const FILE = `${DATA}/models.json`
fs.rmSync(CFG, { recursive: true, force: true })
fs.mkdirSync(DATA, { recursive: true })

const V5 = {
  id: 'deepseek-v5-preview',
  provider: 'deepseek',
  label: 'DeepSeek V5 Preview',
  limits: { window: 500_000, maxOutput: 100_000 },
  prices: { input: 2, cacheWrite: 2, cacheRead: 0.1, output: 8 },
  effort: true,
  files: { images: true }
}
const HAIKU = {
  id: 'claude-haiku-4-5',
  provider: 'claude',
  label: 'Haiku 4.5 (mine)'
}
const write = (models) => fs.writeFileSync(FILE, JSON.stringify({ version: 1, models }, null, 2))
write([
  V5,
  HAIKU,
  { ...V5, id: 'deepseek-typo', label: 'Typo', contextWindo: 5 },
  { ...V5, id: 'gpt-6-astra', label: 'Not OpenAI' }
])

// Chat turns (streamed) are answered; a message with "hang" waits until it
// is let go. Anything else (titles, notes) gets a 400.
const seen = []
let hanging = null
const server = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    const body = JSON.parse(raw || '{}')
    const who = req.url.split('/')[1]
    seen.push({ who, path: req.url, body })
    if (!body.stream) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({ error: { type: 'invalid_request_error', message: 'not in this test' } })
      )
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const text = who === 'anthropic' ? 'Claude answered.' : 'DeepSeek answered.'
    const finish = () => {
      if (who === 'anthropic') {
        const send = (type, data) =>
          res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
        send('message_start', {
          message: {
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            model: body.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 0 }
          }
        })
        send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
        send('content_block_delta', { index: 0, delta: { type: 'text_delta', text } })
        send('content_block_stop', { index: 0 })
        send('message_delta', {
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 5 }
        })
        send('message_stop', {})
      } else {
        const send = (e) => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
        send({ type: 'response.output_text.delta', sequence_number: 0, delta: text })
        send({
          type: 'response.completed',
          sequence_number: 1,
          response: {
            status: 'completed',
            output: [
              {
                type: 'message',
                id: 'm1',
                role: 'assistant',
                status: 'completed',
                content: [{ type: 'output_text', text, annotations: [] }]
              }
            ],
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
          }
        })
      }
      res.end()
    }
    if (JSON.stringify(body).includes('hang please')) hanging = finish
    else finish()
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`

const app = await electron.launch({
  executablePath: createRequire(import.meta.url)('electron'),
  args: [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), '--password-store=basic', '.'],
  env: {
    ...process.env,
    ANTHROPIC_BASE_URL: `${base}/anthropic`,
    OPENAI_BASE_URL: `${base}/openai/v1`,
    DEEPSEEK_BASE_URL: `${base}/deepseek`,
    XDG_CONFIG_HOME: CFG
  }
})
await app.evaluate(({ safeStorage, dialog }, vault) => {
  safeStorage.setUsePlainTextEncryption?.(true)
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [vault] })
}, VAULT)
let w = null
for (let i = 0; !w && i < 300; i++) {
  w = app.windows().find((x) => x.url().endsWith('/renderer/index.html')) ?? null
  if (!w) await new Promise((r) => setTimeout(r, 100))
}
await w.setViewportSize({ width: 1280, height: 900 })
const errors = []
w.on('pageerror', (e) => errors.push(e.message))
await w.waitForSelector('text=Custard')

const chip = () => w.locator('button[title=Model]')
const panel = '[aria-label="Pick a model"]'
const section = '[data-models-file]'
const turns = () => seen.filter((s) => s.body.stream)
const chats = () =>
  fs.existsSync(`${DATA}/conversations`)
    ? fs
        .readdirSync(`${DATA}/conversations`)
        .map((f) => JSON.parse(fs.readFileSync(`${DATA}/conversations/${f}`, 'utf8')))
    : []
const sendText = async (text) => {
  const n = turns().length
  await w.fill('textarea', text)
  await w.keyboard.press('Enter')
  for (let i = 0; i < 300 && turns().length === n; i++) await new Promise((r) => setTimeout(r, 100))
  await w.waitForSelector('button[title=Send]', { timeout: 30000 })
  return turns().at(-1)
}
const pickerIds = async (tab) => {
  if (!(await w.locator(panel).count())) await chip().click()
  await w.click(`${panel} [role=tab]:text-is("${tab}")`)
  const ids = await w
    .locator('[data-picker-models] [data-pick]')
    .evaluateAll((bs) => bs.map((b) => [b.dataset.pick, b.childNodes[0].textContent]))
  return ids
}
const closePicker = () => w.keyboard.press('Escape')
const reload = async () => {
  await w.click(`${section} button:text-is("Reload")`)
  await w.waitForTimeout(300)
}
const statusText = () => w.locator('[data-models-file-status]').innerText()

try {
  step('Setup: a vault and keys for Claude and DeepSeek')
  await w.click('button[title=Settings]')
  await w.click('button:text-is("Use an existing vault")')
  await w.waitForSelector('text=· connected')
  await w.evaluate(async () => {
    await window.custard.apiKey.set('claude', 'sk-ant-FILE-1111111111')
    await window.custard.apiKey.set('deepseek', 'sk-FILE-3333333333')
  })

  step('Settings → Models file: path, loaded and rejected entries')
  await w.waitForSelector(`${section}[data-models-file=ok]`)
  const shownPath = await w.locator('[data-models-file-path]').innerText()
  check(shownPath === FILE, `the path of the file (${shownPath})`)
  check((await statusText()) === '2 loaded, 2 not loaded.', `status: ${await statusText()}`)
  const loaded = await w
    .locator('[data-model-entry]')
    .evaluateAll((ls) => ls.map((l) => [l.dataset.modelEntry, l.dataset.origin, l.textContent]))
  check(
    JSON.stringify(loaded.map(([id, o]) => [id, o])) ===
      '[["deepseek-v5-preview","file"],["claude-haiku-4-5","customised"]]',
    `loaded: ${loaded.map(([, , t]) => t).join(' | ')}`
  )
  check(/customised/.test(loaded[1][2]), 'the changed built-in is marked customised')
  const rejected = await w
    .locator('[data-rejected-entry]')
    .evaluateAll((ls) => ls.map((l) => [l.dataset.rejectedEntry, l.textContent]))
  check(
    rejected.length === 2 &&
      rejected[0][0] === 'deepseek-typo' &&
      /Unknown field "contextWindo"\./.test(rejected[0][1]) &&
      rejected[1][0] === 'gpt-6-astra' &&
      /gpt-6-astra is OpenAI's built-in model, so it can't be a DeepSeek model\./.test(
        rejected[1][1]
      ),
    `rejected: ${rejected.map(([, t]) => t).join(' | ')}`
  )
  check(
    /Effort levels use only Custard's own names \(low, medium, high, xhigh, max\)/.test(
      await w.locator(section).innerText()
    ),
    'it says effort levels use only the five names'
  )
  await w.locator(section).screenshot({ path: `${SHOTS}/models-file-01-settings.png` })
  await w.click('button:text-is("Done")')

  step('The picker: the added model and the customised one')
  const ds = await pickerIds('DeepSeek')
  check(
    JSON.stringify(ds.map(([id]) => id)) ===
      '["deepseek-v4-pro","deepseek-flash","deepseek-v5-preview"]',
    `DeepSeek: ${ds.map(([, l]) => l).join(', ')}`
  )
  const cl = await pickerIds('Claude')
  check(cl[2]?.[1] === 'Haiku 4.5 (mine)', `Claude: ${cl.map(([, l]) => l).join(', ')}`)
  await w.click(`${panel} [role=tab]:text-is("DeepSeek")`)
  await w.click('[data-pick="deepseek-v5-preview"]')
  check(
    (await chip().innerText()) === 'DeepSeek V5 Preview · Balanced',
    `picked, with DeepSeek's effort levels (${await chip().innerText()})`
  )

  step('A message to it: its own id, effort, limits and price')
  const sent = await sendText('file model one')
  check(sent?.who === 'deepseek', `sent to DeepSeek's address (${sent?.path})`)
  check(sent?.body.model === 'deepseek-v5-preview', `with its id (${sent?.body.model})`)
  check(
    sent?.body.reasoning?.effort === 'high',
    `Balanced sent as "high" (${JSON.stringify(sent?.body.reasoning)})`
  )
  await w.waitForSelector('text=DeepSeek answered.')
  const chat = chats().find((c) => c.title.startsWith('file model one'))
  check(
    chat?.context?.budget === Math.floor((500_000 - 64_000) * 0.95),
    `its context budget comes from the file's window (${chat?.context?.budget})`
  )
  const cost = chat?.usage?.cost
  check(
    Math.abs(cost - (10 * 2 + 5 * 8) / 1_000_000) < 1e-12 && chat.usage.unpriced === 0,
    `priced at the file's rates ($${cost})`
  )

  step('Reload waits while a chat is answering')
  const n = turns().length
  await w.fill('textarea', 'hang please')
  await w.keyboard.press('Enter')
  for (let i = 0; i < 100 && turns().length === n; i++) await new Promise((r) => setTimeout(r, 100))
  const busy = await w.evaluate(() => window.custard.models.reload())
  check(
    busy.ok === false &&
      busy.error === 'A chat or an automation is running. Reload when it has finished.',
    `refused: ${busy.error}`
  )
  hanging?.()
  hanging = null
  await w.waitForSelector('button[title=Send]', { timeout: 30000 })
  check(true, 'and the running chat finished')

  step('The model is taken out of the file: Reload, and its chat says so')
  write([HAIKU])
  await w.click('button[title=Settings]')
  await reload()
  check(
    (await statusText()) === '1 loaded, 0 not loaded. Reloaded.',
    `status: ${await statusText()}`
  )
  await w.click('button:text-is("Done")')
  await w.waitForSelector('[data-model-notice=no-profile]')
  const notice = await w.locator('[data-model-notice]').innerText()
  check(
    notice.startsWith("deepseek-v5-preview can't be used right now. Its profile is missing."),
    `notice: ${notice.split('\n')[0]}`
  )
  check(
    !(await pickerIds('DeepSeek')).some(([id]) => id === 'deepseek-v5-preview'),
    'and the picker no longer has it'
  )
  await closePicker()
  await w.screenshot({ path: `${SHOTS}/models-file-02-removed.png` })
  const before = seen.length
  const refused = await w.evaluate(
    () =>
      new Promise((resolve) => {
        const off = window.custard.chat.onEvent((e) => {
          if (e.requestId !== 'forced' || (e.type !== 'error' && e.type !== 'done')) return
          off()
          resolve(e)
        })
        window.custard.chat.send({
          requestId: 'forced',
          conversationId: null,
          mode: 'chat',
          text: 'forced',
          settings: { model: 'deepseek-v5-preview', effort: 'high' }
        })
      })
  )
  check(
    refused.type === 'error' && /its profile is missing/.test(refused.message),
    `main refuses a send to it (${refused.message})`
  )
  await new Promise((r) => setTimeout(r, 300))
  check(seen.length === before, 'nothing reached a provider')

  step('A file that is not JSON: nothing from it loads, the built-ins stay')
  fs.writeFileSync(FILE, '{ "version": 1, "models": [')
  await w.click('button[title=Settings]')
  await reload()
  check(
    (await w.locator(section).getAttribute('data-models-file')) === 'error' &&
      /^The file can't be used, so none of its models are loaded: It isn't valid JSON/.test(
        await statusText()
      ),
    `status: ${(await statusText()).slice(0, 90)}…`
  )
  check(
    (await w.locator('select[title="Default model"] option').allInnerTexts()).includes('Haiku 4.5'),
    'Haiku is back to its built-in name'
  )
  await w.locator(section).screenshot({ path: `${SHOTS}/models-file-03-error.png` })

  step('No file: the built-in models')
  fs.rmSync(FILE)
  await reload()
  check(
    (await statusText()) === 'No models file yet. Custard offers its built-in models. Reloaded.',
    `status: ${await statusText()}`
  )
  await w.click('button:text-is("Done")')
  check(
    JSON.stringify((await pickerIds('Claude')).map(([, l]) => l)) ===
      '["Opus 5.5","Sonnet 5.5","Haiku 4.5"]',
    'the picker has the built-in models only'
  )
  await closePicker()

  check(turns().length === 2, `2 messages sent, 2 turn requests (${turns().length})`)
  check(!errors.length, `no page errors (${errors.join('; ')})`)
} finally {
  await app.close()
  server.close()
}
console.log('\ne2e done, exit', process.exitCode ?? 0)
