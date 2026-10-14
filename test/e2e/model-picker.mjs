// The model picker and a model per chat (provider adapters, Phase 6), in the
// built app against stand-ins for Claude, OpenAI and DeepSeek that this
// script runs itself (no request reaches a provider):
//   - the picker under the message box has a tab per provider with its
//     models; DeepSeek's tab has Fast, Balanced and Thorough
//   - picking a model or an effort sends nothing anywhere
//   - a DeepSeek Thorough message goes out with reasoning.effort "max"
//   - the default model (Settings → General) is what new chats start on
//   - one chat moves Opus 5.5 → DeepSeek Flash → GPT-6 Astra, each model
//     getting the whole conversation so far
//   - a chat whose provider key is removed says so, with Pick a different
//     model; with no keys at all it points to Settings
// Usage, from the repo root after `npx electron-vite build`:
//   node test/e2e/model-picker.mjs <out> <screenshot dir>
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
const CFG = OUT + '/cfg-model-picker'
const VAULT = OUT + '/vault'
fs.rmSync(CFG, { recursive: true, force: true })

// Every request, with its body. Chat turns (streamed) get a one-line answer
// naming who answered; anything else (titles, chat notes) gets a 400.
const seen = []
const answer = {
  anthropic: 'Claude answered.',
  openai: 'OpenAI answered.',
  deepseek: 'DeepSeek answered.'
}
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
    const text = answer[who]
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
const openPicker = async () => {
  if (!(await w.locator(panel).count())) await chip().click()
  await w.waitForSelector(panel)
}
const tab = (name) => w.click(`${panel} [role=tab]:text-is("${name}")`)
const pick = async (provider, id) => {
  await openPicker()
  await tab(provider)
  await w.click(`[data-pick="${id}"]`)
}
const labels = () =>
  w
    .locator('[data-picker-models] [data-pick]')
    .evaluateAll((bs) => bs.map((b) => b.childNodes[0].textContent))
const chats = () => {
  const dir = `${CFG}/custard/conversations`
  return fs.existsSync(dir)
    ? fs.readdirSync(dir).map((f) => JSON.parse(fs.readFileSync(`${dir}/${f}`, 'utf8')))
    : []
}
const chatStarting = (t) =>
  chats().find((c) => c.messages[0]?.content?.[0]?.text?.startsWith?.(t) || c.title.startsWith(t))
const turns = () => seen.filter((s) => s.body.stream)
const sendText = async (text) => {
  const n = turns().length
  await w.fill('textarea', text)
  await w.keyboard.press('Enter')
  await w.waitForFunction((k) => document.querySelectorAll('button[title=Send]').length > 0, null, {
    timeout: 30000
  })
  for (let i = 0; i < 300 && turns().length === n; i++) await new Promise((r) => setTimeout(r, 100))
  await w.waitForSelector('button[title=Send]', { timeout: 30000 })
  return turns().at(-1)
}
// The text of a Responses input, item by item ("user: …", "assistant: …").
const inputLines = (body) =>
  body.input.map(
    (i) =>
      `${i.role}: ${typeof i.content === 'string' ? i.content : i.content.map((c) => c.text).join('')}`
  )
const keys = {
  claude: 'sk-ant-PICK-1111111111',
  openai: 'sk-PICK-2222222222',
  deepseek: 'sk-PICK-3333333333'
}

try {
  step('Setup: a vault and a key for each provider')
  await w.click('button[title=Settings]')
  await w.click('button:text-is("Use an existing vault")')
  await w.waitForSelector('text=· connected')
  await w.evaluate(async (k) => {
    for (const [p, key] of Object.entries(k)) await window.custard.apiKey.set(p, key)
  }, keys)
  await w.click('button:text-is("Done")')
  await w.waitForSelector('button[title=Model]')

  step('The picker: a tab per provider, its models in each')
  check(
    (await chip().innerText()) === 'Opus 5.5',
    `a new chat starts on Opus 5.5 (${await chip().innerText()})`
  )
  check(!(await w.locator('select[title=Model]').count()), 'the old 8-model list is gone')
  await openPicker()
  const tabs = await w.locator(`${panel} [role=tab]`).allInnerTexts()
  check(JSON.stringify(tabs) === '["Claude","OpenAI","DeepSeek"]', `tabs: ${tabs.join(', ')}`)
  const claude = await labels()
  await w.screenshot({ path: `${SHOTS}/picker-01-claude-tab.png` })
  await tab('OpenAI')
  const openai = await labels()
  await tab('DeepSeek')
  const deepseek = await labels()
  check(
    JSON.stringify(claude) === '["Opus 5.5","Sonnet 5.5","Haiku 4.5"]',
    `Claude: ${claude.join(', ')}`
  )
  check(
    JSON.stringify(openai) === '["GPT-6 Astra","GPT-6.1 Sol","GPT-6 Luna"]',
    `OpenAI: ${openai.join(', ')}`
  )
  check(
    JSON.stringify(deepseek) === '["DeepSeek V4 Pro","DeepSeek Flash"]',
    `DeepSeek: ${deepseek.join(', ')}`
  )
  const efforts = w.locator('[data-deepseek-effort] button')
  check(
    JSON.stringify(await efforts.allInnerTexts()) === '["Fast","Balanced","Thorough"]',
    'DeepSeek has Fast, Balanced and Thorough'
  )
  check(
    (await efforts.evaluateAll((bs) => bs.every((b) => b.disabled))) === true,
    'they wait until a DeepSeek model is picked'
  )

  step('Picking DeepSeek Flash and Thorough sends nothing')
  const before = seen.length
  await w.click('[data-pick="deepseek-flash"]')
  check(
    (await chip().innerText()) === 'DeepSeek Flash · Balanced',
    `Balanced is the default (${await chip().innerText()})`
  )
  check(
    (await w.evaluate(() => document.documentElement.dataset.provider)) === 'deepseek',
    'the app follows the DeepSeek tint'
  )
  check(
    !(await w.locator('select[title^="Effort"]').count()),
    'no separate effort list for DeepSeek: it is in the picker'
  )
  await openPicker()
  await tab('DeepSeek')
  await w.click('[data-deepseek-effort] button:text-is("Thorough")')
  check(
    (await chip().innerText()) === 'DeepSeek Flash · Thorough',
    `the chip says Thorough (${await chip().innerText()})`
  )
  await w.screenshot({ path: `${SHOTS}/picker-02-deepseek-tab.png` })
  await w.keyboard.press('Escape')
  check(seen.length === before, `no request while picking (${seen.length - before})`)

  step('A Thorough message: DeepSeek gets reasoning.effort "max"')
  const thorough = await sendText('thorough test')
  check(
    thorough?.who === 'deepseek' && thorough.path === '/deepseek/responses',
    `sent to DeepSeek (${thorough?.path})`
  )
  check(thorough?.body.model === 'deepseek-flash', `model deepseek-flash (${thorough?.body.model})`)
  check(
    JSON.stringify(thorough?.body.reasoning) === '{"effort":"max"}',
    `reasoning: ${JSON.stringify(thorough?.body.reasoning)}`
  )
  fs.writeFileSync(
    `${SHOTS}/effort-request.json`,
    JSON.stringify(
      {
        path: thorough.path,
        model: thorough.body.model,
        reasoning: thorough.body.reasoning,
        input: thorough.body.input
      },
      null,
      2
    )
  )
  const tc = chatStarting('thorough test')
  check(
    tc?.model === 'deepseek-flash' && tc?.effort === 'max',
    `the chat keeps DeepSeek Flash, Thorough (${tc?.model}, ${tc?.effort})`
  )

  step('Each Balanced and Fast send high and low')
  await pick('DeepSeek', 'deepseek-flash')
  await openPicker()
  await w.click('[data-deepseek-effort] button:text-is("Balanced")')
  await w.keyboard.press('Escape')
  const balanced = await sendText('balanced test')
  await openPicker()
  await tab('DeepSeek')
  await w.click('[data-deepseek-effort] button:text-is("Fast")')
  await w.keyboard.press('Escape')
  const fast = await sendText('fast test')
  check(
    balanced?.body.reasoning?.effort === 'high' && fast?.body.reasoning?.effort === 'low',
    `Balanced sent ${balanced?.body.reasoning?.effort}, Fast sent ${fast?.body.reasoning?.effort}`
  )

  step('Switching mid-chat: Opus 5.5 → DeepSeek Flash → GPT-6 Astra')
  // The mode already shown: a new chat.
  await w.locator('button[title]:text-is("Chat")').click()
  await w.waitForFunction(() => !document.querySelector('[data-model-notice]'))
  await pick('Claude', 'claude-opus-5-5')
  const first = await sendText('switch test one')
  check(
    first?.who === 'anthropic' && first.body.model === 'claude-opus-5-5',
    `1st message to Opus 5.5 (${first?.who} ${first?.body.model})`
  )
  await w.waitForSelector('text=Claude answered.')
  const s1 = seen.length
  await pick('DeepSeek', 'deepseek-flash')
  check(seen.length === s1, 'switching sent nothing')
  check(
    chatStarting('switch test one')?.model === 'deepseek-flash',
    'the switch is saved on the chat'
  )
  const second = await sendText('switch test two')
  check(second?.who === 'deepseek', `2nd message to DeepSeek (${second?.who})`)
  const dsLines = inputLines(second.body)
  check(
    JSON.stringify(dsLines) ===
      JSON.stringify([
        'user: switch test one',
        'assistant: Claude answered.',
        'user: switch test two'
      ]),
    `DeepSeek got the whole chat (${dsLines.join(' | ')})`
  )
  await pick('OpenAI', 'gpt-6-astra')
  const third = await sendText('switch test three')
  check(
    third?.who === 'openai' && third.body.model === 'gpt-6-astra',
    `3rd message to GPT-6 Astra (${third?.who})`
  )
  const oaLines = inputLines(third.body)
  check(
    JSON.stringify(oaLines) ===
      JSON.stringify([
        'user: switch test one',
        'assistant: Claude answered.',
        'user: switch test two',
        'assistant: DeepSeek answered.',
        'user: switch test three'
      ]),
    `OpenAI got the whole chat (${oaLines.join(' | ')})`
  )
  await w.waitForSelector('text=OpenAI answered.')
  for (const t of [
    'switch test one',
    'Claude answered.',
    'switch test two',
    'DeepSeek answered.',
    'switch test three',
    'OpenAI answered.'
  ])
    check(await w.locator(`text=${t}`).first().isVisible(), `on screen: ${t}`)
  const sw = chatStarting('switch test one')
  check(
    sw?.model === 'gpt-6-astra' && sw.messages.length === 6,
    `the saved chat has 6 messages and ends on GPT-6 Astra (${sw?.messages.length}, ${sw?.model})`
  )
  fs.writeFileSync(
    `${SHOTS}/switching-example.json`,
    JSON.stringify(
      {
        'Opus 5.5 got': first.body.messages.map(
          (m) =>
            `${m.role}: ${typeof m.content === 'string' ? m.content : m.content.map((c) => c.text ?? `[${c.type}]`).join('')}`
        ),
        'DeepSeek Flash got': dsLines,
        'GPT-6 Astra got': oaLines
      },
      null,
      2
    )
  )
  await w.screenshot({ path: `${SHOTS}/picker-03-switched-chat.png` })

  step('Default model: DeepSeek Flash, from Settings → General')
  const s2 = seen.length
  await w.click('button[title=Settings]')
  await w.selectOption('select[title="Default model"]', 'deepseek-flash')
  check(
    JSON.stringify(await w.locator('select[title="Default effort"] option').allInnerTexts()) ===
      '["Fast","Balanced","Thorough"]',
    'its effort list is Fast, Balanced, Thorough'
  )
  await w
    .locator('[data-default-model]')
    .screenshot({ path: `${SHOTS}/picker-04-default-model.png` })
  await w.click('button:text-is("Done")')
  check(seen.length === s2, 'changing the default sent nothing')
  await w.locator('button[title]:text-is("Chat")').click()
  await w.waitForFunction(() =>
    document.querySelector('button[title=Model]')?.textContent?.startsWith('DeepSeek Flash')
  )
  check(
    (await chip().innerText()) === 'DeepSeek Flash · Balanced',
    `a new chat starts on it (${await chip().innerText()})`
  )
  const viaDefault = await sendText('default test')
  check(
    viaDefault?.who === 'deepseek' && viaDefault.body.model === 'deepseek-flash',
    `and is sent to it (${viaDefault?.who})`
  )
  // The switched chat keeps its own model.
  await w.click('button[title="Chat history"]')
  await w.click('text=switch test one')
  await w.waitForSelector('text=OpenAI answered.')
  check(
    (await chip().innerText()) === 'GPT-6 Astra',
    `an older chat keeps its own model (${await chip().innerText()})`
  )

  step('Removing the OpenAI key: the chat says so, Pick a different model works')
  await w.evaluate(() => window.custard.apiKey.clear('openai'))
  await w.click('button[title=Settings]')
  await w.click('button:text-is("Done")')
  // Away from it and back, as opening an old chat from History.
  await w.locator('button[title]:text-is("Chat")').click()
  await w.waitForFunction(() => !document.querySelector('[data-model-notice]'))
  await w.click('button[title="Chat history"]')
  await w.click('text=switch test one')
  await w.waitForSelector('[data-model-notice=no-key]')
  const notice = await w.locator('[data-model-notice]').innerText()
  check(
    /GPT-6 Astra can't be used right now\. No OpenAI key\. Add one in Settings\./.test(notice),
    `notice: ${notice.split('\n')[0]}`
  )
  check(
    /None of OpenAI's models can be used; add a key or pick another provider\./.test(notice),
    'with every OpenAI model out, it suggests a key or another provider'
  )
  await w.fill('textarea', 'should not send')
  check(await w.locator('button[title=Send]').isDisabled(), 'nothing can be sent to it')
  await w.screenshot({ path: `${SHOTS}/picker-05-unavailable.png` })
  await w.click('[data-model-notice] button:text-is("Pick a different model")')
  await w.waitForSelector(panel)
  await tab('OpenAI')
  const off = await w
    .locator('[data-picker-models] [data-pick]')
    .evaluateAll((bs) => bs.map((b) => [b.disabled, b.textContent]))
  check(
    off.every(([d, t]) => d && /No OpenAI key/.test(t)),
    'the picker opened; OpenAI models are greyed out with the reason'
  )
  await w.screenshot({ path: `${SHOTS}/picker-06-pick-different.png` })
  await tab('Claude')
  await w.click('[data-pick="claude-sonnet-5-5"]')
  check(!(await w.locator('[data-model-notice]').count()), 'the notice is gone')
  await w.fill('textarea', '')
  const after = await sendText('switch test four')
  check(
    after?.who === 'anthropic' && after.body.model === 'claude-sonnet-5-5',
    `the chat carries on with Sonnet 5.5 (${after?.who})`
  )
  check(
    after.body.messages.length === 7 &&
      JSON.stringify(after.body.messages).includes('OpenAI answered.'),
    `with all of it (${after.body.messages.length} messages)`
  )

  step('The Automations model list follows the same rules')
  await w.click('button[title=Settings]')
  await w.click('button:text-is("New automation")')
  const autoModels = await w
    .locator('select[aria-label="Model for the automation"] optgroup')
    .evaluateAll((gs) =>
      gs.map((g) => [
        g.label,
        [...g.querySelectorAll('option')].map((o) => [o.value, o.disabled, o.textContent])
      ])
    )
  check(
    JSON.stringify(autoModels.map(([g]) => g)) === '["Claude","OpenAI","DeepSeek"]',
    `grouped by provider (${autoModels.map(([g]) => g)})`
  )
  const openaiAuto = autoModels.find(([g]) => g === 'OpenAI')[1]
  check(
    openaiAuto.length === 3 && openaiAuto.every(([, d, t]) => d && /No OpenAI key/.test(t)),
    `OpenAI's models can't be picked, with the reason (${openaiAuto.map(([, , t]) => t)})`
  )
  check(
    autoModels.filter(([g]) => g !== 'OpenAI').every(([, os]) => os.every(([, d]) => !d)),
    "Claude's and DeepSeek's can"
  )
  check(
    (await w.inputValue('select[aria-label="Model for the automation"]')) === 'claude-opus-5-5',
    'a new automation starts on the first usable model'
  )
  await w.locator('[data-default-model]').scrollIntoViewIfNeeded()
  await w.locator('select[aria-label="Model for the automation"]').screenshot({
    path: `${SHOTS}/picker-07-automation-models.png`
  })
  await w.click('button:text-is("Cancel")')
  await w.click('button:text-is("Done")')

  step('No keys at all: it points to Settings')
  await w.evaluate(async () => {
    for (const p of ['claude', 'deepseek']) await window.custard.apiKey.clear(p)
  })
  await w.click('button[title=Settings]')
  await w.click('button:text-is("Done")')
  await w.waitForSelector('[data-model-notice]')
  const none = await w.locator('[data-model-notice]').innerText()
  check(
    /No provider has a key yet/.test(none) && /Add a key in Settings/.test(none),
    `notice: ${none}`
  )
  await w.click('[data-model-notice] button:text-is("Add a key in Settings")')
  check(await w.locator('input[aria-label="Claude API key"]').isVisible(), 'it opens Settings')
  await w.click('button:text-is("Done")')

  step('Nothing went to a provider but the messages sent')
  const stray = seen.filter(
    (s) =>
      s.body.stream === undefined && !s.path.includes('/messages') && !s.path.includes('/responses')
  )
  check(!stray.length, `no model lists or checks (${stray.map((s) => s.path)})`)
  check(turns().length === 8, `8 messages, 8 turn requests (${turns().length})`)
  check(!errors.length, `no page errors (${errors.join('; ')})`)
} finally {
  await app.close()
  server.close()
}
console.log('\ne2e done, exit', process.exitCode ?? 0)
