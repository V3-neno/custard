// One chat through every provider and back (provider adapters, Phase 7):
// Claude Opus 5.5 → DeepSeek Flash → GPT-6 Astra → Claude Opus 5.5, each turn
// with tool calls and their results, against stand-ins for the three APIs
// that this script runs itself (no request reaches a provider). It checks:
//   - every turn ends without an error, and the chat keeps every message
//   - each provider gets the whole chat, with the earlier tool calls and
//     results as its own API's calls and results
//   - nothing only one provider can read reaches another: Claude's thinking,
//     fallback markers and compaction blocks, OpenAI's encrypted reasoning,
//     DeepSeek's reasoning text
//   - a call to a tool the new model doesn't have (Opus's web_search, for
//     DeepSeek) goes to it as text
// Usage, from the repo root after `npx electron-vite build`:
//   node test/e2e/round-trip.mjs <out> <screenshot dir>
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
const CFG = OUT + '/cfg-round-trip'
const VAULT = OUT + '/vault'
fs.rmSync(CFG, { recursive: true, force: true })

const seen = []
const claudeUsage = { input_tokens: 60, output_tokens: 10 }

function claudeStream(res, blocks, stop) {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const send = (e) => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
  send({
    type: 'message_start',
    message: {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5-5',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: claudeUsage
    }
  })
  blocks.forEach((b, index) => {
    if (b.type === 'text') {
      send({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
      send({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: b.text } })
    } else if (b.type === 'thinking') {
      send({
        type: 'content_block_start',
        index,
        content_block: { type: 'thinking', thinking: '', signature: '' }
      })
      send({
        type: 'content_block_delta',
        index,
        delta: { type: 'thinking_delta', thinking: b.text }
      })
      send({
        type: 'content_block_delta',
        index,
        delta: { type: 'signature_delta', signature: 'sig' }
      })
    } else if (b.type === 'tool_use') {
      send({ type: 'content_block_start', index, content_block: { ...b, input: {} } })
      send({
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) }
      })
    } else send({ type: 'content_block_start', index, content_block: b })
    send({ type: 'content_block_stop', index })
  })
  send({
    type: 'message_delta',
    delta: { stop_reason: stop, stop_sequence: null },
    usage: claudeUsage
  })
  send({ type: 'message_stop' })
  res.end()
}

function responsesStream(res, deltas, output) {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  let n = 0
  const send = (e) =>
    res.write(`event: ${e.type}\ndata: ${JSON.stringify({ ...e, sequence_number: n++ })}\n\n`)
  for (const d of deltas) send(d)
  send({
    type: 'response.completed',
    response: {
      id: 'resp_1',
      object: 'response',
      status: 'completed',
      output,
      usage: { input_tokens: 60, output_tokens: 10, total_tokens: 70 }
    }
  })
  res.end()
}
const msg = (text) => ({
  type: 'message',
  id: 'm1',
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text, annotations: [] }]
})
const fcall = (id) => ({
  type: 'function_call',
  id: `fc_${id}`,
  call_id: id,
  name: 'vault_list',
  arguments: '{}',
  status: 'completed'
})

// Which round of a turn this is: the number of tool results since the
// user's last message.
const claudeRound = (messages) => {
  let n = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    const results = Array.isArray(m.content) && m.content.some((c) => c.type === 'tool_result')
    if (m.role === 'user' && !results) break
    if (results) n++
  }
  return n
}
const responsesRound = (input) => {
  let n = 0
  for (let i = input.length - 1; i >= 0; i--) {
    if (input[i].role === 'user') break
    if (input[i].type === 'function_call_output') n++
  }
  return n
}

const server = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    const body = JSON.parse(raw || '{}')
    const who = req.url.split('/')[1]
    const text = JSON.stringify(body)
    if (!/round trip/.test(text) && !/Query: /.test(text)) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({ error: { type: 'invalid_request_error', message: 'not in this test' } })
      )
      return
    }
    seen.push({ who, search: /Query: /.test(text), body })
    if (who === 'anthropic' && /Query: /.test(text)) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          id: 'msg_s',
          type: 'message',
          role: 'assistant',
          model: body.model,
          content: [
            {
              type: 'server_tool_use',
              id: 'srv_1',
              name: 'web_search',
              input: { query: 'custard' }
            },
            {
              type: 'web_search_tool_result',
              tool_use_id: 'srv_1',
              content: [
                {
                  type: 'web_search_result',
                  url: 'https://example.com/custard',
                  title: 'Custard',
                  page_age: null,
                  encrypted_content: 'E'
                }
              ]
            },
            { type: 'text', text: 'Custard is a set dessert.', citations: null }
          ],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: claudeUsage
        })
      )
      return
    }
    if (who === 'anthropic') {
      const round = claudeRound(body.messages)
      const last = /round trip four/.test(text)
      const tag = last ? 'back' : 'one'
      if (round === 0)
        return claudeStream(
          res,
          [
            { type: 'thinking', text: `Claude thinks (${tag}).` },
            last
              ? { type: 'tool_use', id: 'toolu_back', name: 'vault_list', input: {} }
              : {
                  type: 'tool_use',
                  id: 'toolu_search',
                  name: 'web_search',
                  input: { query: 'custard' }
                }
          ],
          'tool_use'
        )
      if (round === 1 && !last)
        return claudeStream(
          res,
          [
            { type: 'thinking', text: 'Claude thinks again.' },
            { type: 'tool_use', id: 'toolu_list', name: 'vault_list', input: {} }
          ],
          'tool_use'
        )
      return claudeStream(
        res,
        [
          ...(last
            ? []
            : [
                { type: 'compaction', content: 'Claude summary so far.', encrypted_content: null },
                {
                  type: 'fallback',
                  from: { model: 'claude-opus-5-5' },
                  to: { model: 'claude-sonnet-5-5' },
                  trigger: { type: 'refusal' }
                }
              ]),
          { type: 'text', text: last ? 'Claude is back.' : 'Claude found it.' }
        ],
        'end_turn'
      )
    }
    const round = responsesRound(body.input)
    if (who === 'deepseek') {
      if (round === 0)
        return responsesStream(
          res,
          [
            {
              type: 'response.reasoning_text.delta',
              item_id: 'rs_d',
              output_index: 0,
              content_index: 0,
              delta: 'DeepSeek reasons.'
            }
          ],
          [
            {
              type: 'reasoning',
              id: 'rs_d',
              summary: [],
              content: [{ type: 'reasoning_text', text: 'DeepSeek reasons.' }]
            },
            fcall('call_ds')
          ]
        )
      return responsesStream(
        res,
        [{ type: 'response.output_text.delta', delta: 'DeepSeek found it.' }],
        [msg('DeepSeek found it.')]
      )
    }
    if (round === 0)
      return responsesStream(
        res,
        [
          {
            type: 'response.reasoning_summary_text.delta',
            item_id: 'rs_o',
            output_index: 0,
            summary_index: 0,
            delta: 'OpenAI reasons.'
          }
        ],
        [
          {
            type: 'reasoning',
            id: 'rs_o',
            summary: [{ type: 'summary_text', text: 'OpenAI reasons.' }],
            encrypted_content: 'OPENAI-ENCRYPTED'
          },
          fcall('call_oa')
        ]
      )
    return responsesStream(
      res,
      [{ type: 'response.output_text.delta', delta: 'OpenAI found it.' }],
      [msg('OpenAI found it.')]
    )
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
await w.setViewportSize({ width: 1280, height: 1000 })
const errors = []
w.on('pageerror', (e) => errors.push(e.message))
await w.waitForSelector('text=Custard')
await app.evaluate(({ webContents }) => {
  globalThis.__events = []
  for (const wc of webContents.getAllWebContents()) {
    const send = wc.send.bind(wc)
    wc.send = (channel, ...args) => {
      if (channel === 'chat:event') globalThis.__events.push(args[0])
      return send(channel, ...args)
    }
  }
})
const events = () => app.evaluate(() => globalThis.__events)
const until = async (f, ms = 30000) => {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (await f()) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}
const chat = () => {
  const dir = `${CFG}/custard/conversations`
  return fs
    .readdirSync(dir)
    .map((f) => JSON.parse(fs.readFileSync(`${dir}/${f}`, 'utf8')))
    .find((c) => JSON.stringify(c.messages).includes('round trip one'))
}
const pick = async (tab, id) => {
  await w.click('button[title=Model]')
  await w.click(`[aria-label="Pick a model"] [role=tab]:text-is("${tab}")`)
  await w.click(`[data-pick="${id}"]`)
}
// Sends a message and answers any approval card; returns the turn's events.
const turn = async (text) => {
  const before = (await events()).length
  await w.fill('textarea', text)
  await w.keyboard.press('Enter')
  const card = '[role=alertdialog]'
  const ended = async () =>
    (await events()).slice(before).some((e) => e.type === 'done' || e.type === 'error')
  while (!(await ended())) {
    if (await w.locator(card).count()) await w.click(`${card} button:text-is("Allow")`)
    await new Promise((r) => setTimeout(r, 150))
  }
  await w.waitForSelector('button[title=Send]', { timeout: 30000 })
  return (await events()).slice(before)
}
const kinds = (body) =>
  JSON.stringify(body)
    .match(/"type":"(\w+)"/g)
    ?.map((t) => t.slice(8, -1)) ?? []

try {
  step('Set up: three keys and the vault')
  await w.click('button[title=Settings]')
  await w.click('button:has-text("Use an existing vault")')
  await w.waitForSelector('text=· connected')
  await w.evaluate(async () => {
    await window.custard.apiKey.set('claude', 'sk-ant-RT-0000000000')
    await window.custard.apiKey.set('openai', 'sk-RT-openai-1111111111')
    await window.custard.apiKey.set('deepseek', 'sk-RT-deepseek-2222222222')
  })
  await w.click('button:text-is("Done")')

  step('1. Claude Opus 5.5: thinking, a web search, a vault_list, compaction, a fallback')
  await pick('Claude', 'claude-opus-5-5')
  const e1 = await turn('round trip one')
  check(e1.at(-1).type === 'done', `ended without an error (${e1.at(-1).type})`)
  await w.waitForSelector('text=Claude found it.')
  const stored = chat().messages.flatMap((m) =>
    Array.isArray(m.content) ? m.content.map((c) => c.type) : ['text']
  )
  for (const t of ['thinking', 'tool_use', 'tool_result', 'compaction', 'fallback'])
    check(stored.includes(t), `the chat keeps Claude's ${t} block`)

  step('2. DeepSeek Flash')
  let n = seen.length
  await pick('DeepSeek', 'deepseek-flash')
  const e2 = await turn('round trip two')
  check(e2.at(-1).type === 'done', `ended without an error (${e2.at(-1).type})`)
  const ds = seen.slice(n).filter((s) => s.who === 'deepseek')
  check(ds.length === 2, `two DeepSeek requests (a tool round) (${ds.length})`)
  const dsFirst = ds[0].body.input
  const dsKinds = kinds(dsFirst)
  check(
    !dsKinds.some((k) => ['thinking', 'compaction', 'fallback', 'reasoning'].includes(k)),
    `no thinking, compaction, fallback or reasoning sent (${[...new Set(dsKinds)]})`
  )
  check(
    !JSON.stringify(dsFirst).includes('Claude thinks') &&
      !JSON.stringify(dsFirst).includes('Claude summary so far'),
    "neither Claude's thinking nor its compaction summary is in the text"
  )
  const searchText = dsFirst.find(
    (i) => i.role === 'assistant' && /Earlier call to web_search/.test(JSON.stringify(i))
  )
  check(!!searchText, 'Opus’s web_search call went to DeepSeek as text')
  check(
    !dsFirst.some((i) => i.type === 'function_call' && i.name === 'web_search'),
    'not as a call to a tool DeepSeek has no definition for'
  )
  check(
    dsFirst.some((i) => i.type === 'function_call' && i.name === 'vault_list') &&
      dsFirst.some((i) => i.type === 'function_call_output'),
    "Opus's vault_list call and result went as DeepSeek function calls"
  )
  check(
    ds[1].body.input.some((i) => i.type === 'reasoning'),
    'DeepSeek gets its own reasoning back within its turn'
  )
  await w.waitForSelector('text=DeepSeek found it.')

  step('3. GPT-6 Astra')
  n = seen.length
  await pick('OpenAI', 'gpt-6-astra')
  const e3 = await turn('round trip three')
  check(e3.at(-1).type === 'done', `ended without an error (${e3.at(-1).type})`)
  const oa = seen.slice(n).filter((s) => s.who === 'openai')
  check(oa.length === 2, `two OpenAI requests (${oa.length})`)
  const oaFirst = oa[0].body.input
  const oaKinds = kinds(oaFirst)
  check(
    !oaKinds.some((k) => ['thinking', 'compaction', 'fallback', 'reasoning'].includes(k)),
    `no thinking, compaction, fallback or reasoning sent (${[...new Set(oaKinds)]})`
  )
  check(!JSON.stringify(oaFirst).includes('DeepSeek reasons'), "DeepSeek's reasoning isn't sent")
  check(
    oaFirst.some((i) => i.type === 'function_call' && i.name === 'web_search'),
    'OpenAI has web_search, so Opus’s search stays a call'
  )
  check(
    oaFirst.filter((i) => i.type === 'function_call' && i.name === 'vault_list').length === 2,
    "Opus's and DeepSeek's vault_list calls both went as calls"
  )
  check(
    JSON.stringify(oa[1].body.input).includes('OPENAI-ENCRYPTED'),
    'OpenAI gets its own encrypted reasoning back within its turn'
  )
  await w.waitForSelector('text=OpenAI found it.')

  step('4. Back to Claude Opus 5.5')
  n = seen.length
  await pick('Claude', 'claude-opus-5-5')
  const e4 = await turn('round trip four')
  check(e4.at(-1).type === 'done', `ended without an error (${e4.at(-1).type})`)
  const cl = seen.slice(n).filter((s) => s.who === 'anthropic' && !s.search)
  const back = cl[0]?.body.messages ?? []
  const backText = JSON.stringify(back)
  check(cl.length === 2, `two Claude requests (${cl.length})`)
  check(
    !backText.includes('OPENAI-ENCRYPTED') &&
      !backText.includes('DeepSeek reasons') &&
      !backText.includes('OpenAI reasons'),
    'no OpenAI or DeepSeek reasoning reaches Claude'
  )
  const backBlocks = back.flatMap((m) => (Array.isArray(m.content) ? m.content : []))
  check(
    ['thinking', 'compaction', 'fallback'].every((t) => backBlocks.some((b) => b.type === t)),
    'Claude gets its own thinking, compaction and fallback blocks back, as without switching'
  )
  check(
    backBlocks
      .filter((b) => b.type === 'tool_use')
      .map((b) => b.name)
      .join() === 'web_search,vault_list,vault_list,vault_list' &&
      backBlocks.filter((b) => b.type === 'tool_result').length === 4 &&
      backText.includes('DeepSeek found it.') &&
      backText.includes('OpenAI found it.'),
    "every call and result, DeepSeek's and OpenAI's included, goes as Claude's own"
  )
  await w.waitForSelector('text=Claude is back.')

  step('The chat as it stands')
  const c = chat()
  const users = c.messages.filter(
    (m) =>
      typeof m.content === 'string' ||
      m.content.some((x) => x.type === 'text' && /round trip/.test(x.text))
  )
  check(users.length === 4, `4 user messages (${users.length})`)
  for (const t of ['Claude found it.', 'DeepSeek found it.', 'OpenAI found it.', 'Claude is back.'])
    check(
      JSON.stringify(c.messages).includes(t) && (await w.locator(`text=${t}`).first().isVisible()),
      `kept and shown: ${t}`
    )
  check(c.model === 'claude-opus-5-5', `the chat ends on Opus 5.5 (${c.model})`)
  check(!errors.length, `no page errors (${errors.join('; ')})`)
  fs.writeFileSync(
    `${SHOTS}/round-trip-requests.json`,
    JSON.stringify(
      {
        deepseek: dsFirst.map(
          (i) => i.type ?? `${i.role}: ${JSON.stringify(i.content).slice(0, 90)}`
        ),
        openai: oaFirst.map(
          (i) => i.type ?? `${i.role}: ${JSON.stringify(i.content).slice(0, 90)}`
        ),
        claude: back.map(
          (m) =>
            `${m.role}: ${(Array.isArray(m.content) ? m.content.map((x) => x.type) : ['text']).join(', ')}`
        )
      },
      null,
      2
    )
  )
  await w.screenshot({ path: `${SHOTS}/round-trip.png`, fullPage: true })

  // Every request body, for the neutral-format check (test/neutral/README.md).
  fs.writeFileSync(`${OUT}/requests.json`, JSON.stringify(seen))
} finally {
  await app.close()
  server.close()
}
console.log('\ne2e done, exit', process.exitCode ?? 0)
