// A model with no profile (Workstream A, Phase A3), in the built app against
// a stand-in for Claude that this script runs itself (no request reaches a
// provider). A profile can go missing once profiles come from a file; here
// the chat's model and the default model are set to an id Custard has no
// profile for by editing the saved files, as an older or edited file would:
//   - the chat keeps that model and says it can't be used: "Its profile is
//     missing", with Pick a different model and Open Settings; nothing can
//     be sent; picking another model carries the chat on
//   - Settings → Default model says the same, and new chats start on it
//     with the notice rather than on Opus 5.5
//   - a send that names it anyway is refused in main, and nothing goes out
//   - the model list main hands the renderer is the 8 built-in profiles
// Usage, from the repo root after `npx electron-vite build`:
//   node test/e2e/model-profile.mjs <out> <screenshot dir>
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
const CFG = OUT + '/cfg-model-profile'
const VAULT = OUT + '/vault'
const DATA = `${CFG}/custard`
const GONE = 'claude-opus-4-1'
fs.rmSync(CFG, { recursive: true, force: true })

// Chat turns (streamed) get a one-line answer; anything else a 400.
const seen = []
const server = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    const body = JSON.parse(raw || '{}')
    seen.push({ path: req.url, body })
    if (!body.stream) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({ error: { type: 'invalid_request_error', message: 'not in this test' } })
      )
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
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
    send('content_block_delta', {
      index: 0,
      delta: { type: 'text_delta', text: 'Claude answered.' }
    })
    send('content_block_stop', { index: 0 })
    send('message_delta', {
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 5 }
    })
    send('message_stop', {})
    res.end()
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`

const app = await electron.launch({
  executablePath: createRequire(import.meta.url)('electron'),
  args: [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), '--password-store=basic', '.'],
  env: { ...process.env, ANTHROPIC_BASE_URL: `${base}/anthropic`, XDG_CONFIG_HOME: CFG }
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
const turns = () => seen.filter((s) => s.body.stream)
const chats = () =>
  fs.existsSync(`${DATA}/conversations`)
    ? fs
        .readdirSync(`${DATA}/conversations`)
        .map((f) => [f, JSON.parse(fs.readFileSync(`${DATA}/conversations/${f}`, 'utf8'))])
    : []
const sendText = async (text) => {
  const n = turns().length
  await w.fill('textarea', text)
  await w.keyboard.press('Enter')
  for (let i = 0; i < 300 && turns().length === n; i++) await new Promise((r) => setTimeout(r, 100))
  await w.waitForSelector('button[title=Send]', { timeout: 30000 })
  return turns().at(-1)
}
const toChat = async (title) => {
  await w.locator('button[title]:text-is("Chat")').click()
  await w.click('button[title="Chat history"]')
  await w.click(`text=${title}`)
}

try {
  step('Setup: a vault, a Claude key, and a chat on Sonnet 5.5')
  await w.click('button[title=Settings]')
  await w.click('button:text-is("Use an existing vault")')
  await w.waitForSelector('text=· connected')
  await w.evaluate(() => window.custard.apiKey.set('claude', 'sk-ant-PROFILE-1111111111'))
  await w.click('button:text-is("Done")')
  await w.waitForSelector('button[title=Model]')
  const profiles = await w.evaluate(() => window.custard.models.profiles())
  check(
    JSON.stringify(profiles.map((p) => p.id)) ===
      '["claude-opus-5-5","claude-sonnet-5-5","claude-haiku-4-5","gpt-6-astra","gpt-6.1-sol","gpt-6-luna","deepseek-v4-pro","deepseek-flash"]',
    `main hands the renderer the 8 built-in profiles (${profiles.length})`
  )
  await w.click('button[title=Model]')
  await w.click(`${panel} [role=tab]:text-is("Claude")`)
  await w.click('[data-pick="claude-sonnet-5-5"]')
  const first = await sendText('profile test one')
  check(first?.body.model === 'claude-sonnet-5-5', `sent to Sonnet 5.5 (${first?.body.model})`)

  step("The chat's model loses its profile: the chat says so")
  const [file, saved] = chats().find(([, c]) => c.title.startsWith('profile test one'))
  saved.model = GONE
  fs.writeFileSync(`${DATA}/conversations/${file}`, JSON.stringify(saved))
  await w.click('button[title="New chat"]').catch(() => {})
  await toChat('profile test one')
  await w.waitForSelector('[data-model-notice=no-profile]')
  const notice = await w.locator('[data-model-notice]').innerText()
  check(
    notice.startsWith(`${GONE} can't be used right now. Its profile is missing.`),
    `notice: ${notice.split('\n')[0]}`
  )
  check(!/key|None of/.test(notice), 'it says nothing about keys or the provider (it has none)')
  check(
    (await chip().innerText()) === GONE,
    `the chat keeps that model (${await chip().innerText()})`
  )
  await w.fill('textarea', 'should not send')
  check(await w.locator('button[title=Send]').isDisabled(), 'nothing can be sent to it')
  await w.screenshot({ path: `${SHOTS}/profile-01-chat-notice.png` })

  step('Open Settings and Pick a different model')
  await w.click('[data-model-notice] button:text-is("Open Settings")')
  check(
    await w.locator('input[aria-label="Claude API key"]').isVisible(),
    'Open Settings opens Settings'
  )
  await w.click('button:text-is("Done")')
  await w.waitForSelector('[data-model-notice=no-profile]')
  await w.click('[data-model-notice] button:text-is("Pick a different model")')
  await w.waitForSelector(panel)
  check(true, 'Pick a different model opens the picker')
  await w.click(`${panel} [role=tab]:text-is("Claude")`)
  await w.click('[data-pick="claude-haiku-4-5"]')
  check(!(await w.locator('[data-model-notice]').count()), 'the notice is gone')
  await w.fill('textarea', '')
  const carried = await sendText('profile test two')
  check(
    carried?.body.model === 'claude-haiku-4-5' && carried.body.messages.length === 3,
    `the chat carries on with Haiku 4.5, all of it (${carried?.body.model}, ${carried?.body.messages.length} messages)`
  )

  step('The default model loses its profile')
  const settingsPath = `${DATA}/settings.json`
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
  settings.chat = { ...(settings.chat ?? {}), model: GONE, effort: 'medium' }
  fs.writeFileSync(settingsPath, JSON.stringify(settings))
  await w.click('button[title=Settings]')
  await w.waitForSelector('[data-default-model-notice=no-profile]')
  const settingsNotice = await w.locator('[data-default-model-notice]').innerText()
  check(
    settingsNotice.startsWith(`${GONE} can't be used right now. Its profile is missing`),
    `Settings says so: ${settingsNotice.split('\n')[0]}`
  )
  check(
    (await w.inputValue('select[title="Default model"]')) === GONE,
    'the default is shown as it is, not as another model'
  )
  check(
    JSON.parse(fs.readFileSync(settingsPath, 'utf8')).chat.model === GONE,
    'and is not replaced in the file'
  )
  await w.locator('[data-default-model]').screenshot({ path: `${SHOTS}/profile-02-settings.png` })
  await w.click('[data-default-model-notice] button:text-is("Pick a different model")')
  check(
    await w.evaluate(() => document.activeElement?.getAttribute('title') === 'Default model'),
    'Pick a different model goes to the model list'
  )
  await w.click('button:text-is("Done")')
  await w.locator('button[title]:text-is("Chat")').click()
  await w.waitForSelector('[data-model-notice=no-profile]')
  check(
    (await chip().innerText()) === GONE,
    `a new chat starts on it, with the notice, not on Opus 5.5`
  )
  await w.screenshot({ path: `${SHOTS}/profile-03-new-chat.png` })

  step('A send that names it anyway is refused in main')
  const before = seen.length
  const refused = await w.evaluate(
    (model) =>
      new Promise((resolve) => {
        const off = window.custard.chat.onEvent((e) => {
          if (e.requestId !== 'forced') return
          if (e.type === 'error' || e.type === 'done') {
            off()
            resolve(e)
          }
        })
        window.custard.chat.send({
          requestId: 'forced',
          conversationId: null,
          mode: 'chat',
          text: 'forced',
          settings: { model, effort: 'medium' }
        })
      }),
    GONE
  )
  check(
    refused.type === 'error' &&
      refused.message ===
        `${GONE} can't be used right now: its profile is missing. Pick a different model.`,
    `refused: ${refused.message}`
  )
  await new Promise((r) => setTimeout(r, 500))
  check(seen.length === before, 'nothing reached the provider')
  check(!chats().some(([, c]) => c.title === 'forced'), 'and no chat was made')

  step('Picking a default with a profile ends it')
  await w.click('button[title=Settings]')
  await w.selectOption('select[title="Default model"]', 'claude-sonnet-5-5')
  check(!(await w.locator('[data-default-model-notice]').count()), 'the Settings notice is gone')
  await w.click('button:text-is("Done")')
  await w.locator('button[title]:text-is("Chat")').click()
  await w.waitForFunction(() => !document.querySelector('[data-model-notice]'))
  check(
    (await chip().innerText()) === 'Sonnet 5.5 · Medium',
    `new chats start on it (${await chip().innerText()})`
  )

  check(turns().length === 2, `2 messages sent, 2 turn requests (${turns().length})`)
  check(!errors.length, `no page errors (${errors.join('; ')})`)
} finally {
  await app.close()
  server.close()
}
console.log('\ne2e done, exit', process.exitCode ?? 0)
