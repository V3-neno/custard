// The requests automation steps and web searches send, per provider, in the
// built app, against stand-ins for Claude, OpenAI and DeepSeek that this
// script runs itself (no request reaches a provider). Written before both
// moved onto the provider adapters (provider adapters, Phase 7) and compared
// with test/e2e/provider-requests.golden.json after, so the move can be shown
// to change nothing a provider sees:
//   automation:<provider>  a run of a skill: a vault_list step, then the end
//   search:<provider>      a chat asks for web_search; the search's own call
//                          (Claude and OpenAI; DeepSeek has no web search)
// Each request is kept with its method, path, the headers that say how it was
// sent, and its body (dates and ids normalised).
// Usage, from the repo root after `npx electron-vite build`:
//   node test/e2e/provider-requests.mjs <out> <screenshot dir> [--update]
// with <out>/vault a copy of vault-template/. Linux only as written, with a
// display or xvfb-run. Needs the playwright package.
import { _electron as electron } from 'playwright'
import { createRequire } from 'module'
import fs from 'fs'
import http from 'http'

const [, , OUT, SHOTS, FLAG] = process.argv
const GOLDEN = new URL('./provider-requests.golden.json', import.meta.url)
const check = (cond, what) => {
  console.log((cond ? '✓ ' : '✕ ') + what)
  if (!cond) process.exitCode = 1
}
const step = (s) => console.log('\n## ' + s)
const CFG = OUT + '/cfg-provider-requests'
const VAULT = OUT + '/vault'
fs.rmSync(CFG, { recursive: true, force: true })
fs.mkdirSync(`${VAULT}/Custard/Skills/req-log`, { recursive: true })
fs.writeFileSync(
  `${VAULT}/Custard/Skills/req-log/SKILL.md`,
  '---\nname: req-log\ndescription: Lists the vault.\n---\nList the vault, then say what is in it.\n'
)

const HEADERS = [
  'anthropic-beta',
  'anthropic-version',
  'content-type',
  'accept',
  'x-stainless-retry-count',
  'x-stainless-timeout'
]
const seen = []
const said = (body) => JSON.stringify(body)
const claudeUsage = { input_tokens: 50, output_tokens: 10 }
const openaiUsage = { input_tokens: 50, output_tokens: 10, total_tokens: 60 }

// Anthropic: a whole message, streamed or not.
function claudeReply(res, stream, content, stop) {
  const message = {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: claudeUsage
  }
  if (!stream) {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify(message))
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const send = (e) => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
  send({ type: 'message_start', message: { ...message, content: [], stop_reason: null } })
  content.forEach((b, index) => {
    if (b.type === 'text') {
      send({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
      send({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: b.text } })
    } else {
      send({ type: 'content_block_start', index, content_block: { ...b, input: {} } })
      send({
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) }
      })
    }
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

// Responses: a whole response, streamed or not.
function responsesReply(res, stream, output) {
  const response = {
    id: 'resp_1',
    object: 'response',
    status: 'completed',
    output,
    usage: openaiUsage
  }
  if (!stream) {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify(response))
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  let n = 0
  const send = (e) =>
    res.write(`event: ${e.type}\ndata: ${JSON.stringify({ ...e, sequence_number: n++ })}\n\n`)
  for (const o of output)
    if (o.type === 'message') send({ type: 'response.output_text.delta', delta: o.content[0].text })
  send({ type: 'response.completed', response })
  res.end()
}
const message = (text, annotations = []) => ({
  type: 'message',
  id: 'm1',
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text, annotations }]
})

const server = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    const body = JSON.parse(raw || '{}')
    const who = req.url.split('/')[1]
    const text = said(body)
    // A chat lists the vault's skills (req-log among them), so it is told
    // apart first.
    const kind = /Query: /.test(text)
      ? 'search'
      : /search test/.test(text)
        ? 'chat'
        : /req-log/.test(text)
          ? 'automation'
          : 'other'
    if (kind === 'other') {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({ error: { type: 'invalid_request_error', message: 'not in this test' } })
      )
      return
    }
    seen.push({
      kind,
      who,
      method: req.method,
      path: req.url,
      headers: Object.fromEntries(
        HEADERS.filter((h) => req.headers[h]).map((h) => [h, req.headers[h]])
      ),
      body
    })
    const stream = !!body.stream || req.headers.accept === 'text/event-stream'
    if (who === 'anthropic') {
      const msgs = body.messages ?? []
      const afterTool = JSON.stringify(msgs.at(-1)).includes('tool_result')
      if (kind === 'search')
        return claudeReply(
          res,
          stream,
          [
            {
              type: 'server_tool_use',
              id: 'srv_1',
              name: 'web_search',
              input: { query: 'custard recipes' }
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
          'end_turn'
        )
      if (afterTool)
        return claudeReply(res, stream, [{ type: 'text', text: 'Done here.' }], 'end_turn')
      const call =
        kind === 'chat'
          ? {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'web_search',
              input: { query: 'custard recipes' }
            }
          : { type: 'tool_use', id: 'toolu_1', name: 'vault_list', input: {} }
      return claudeReply(res, stream, [call], 'tool_use')
    }
    const input = body.input ?? []
    const afterTool = Array.isArray(input) && input.at(-1)?.type === 'function_call_output'
    if (kind === 'search')
      return responsesReply(res, stream, [
        {
          type: 'web_search_call',
          id: 'ws_1',
          status: 'completed',
          action: {
            type: 'search',
            query: 'custard recipes',
            sources: [{ type: 'url', url: 'https://example.com/custard' }]
          }
        },
        message('Custard is a set dessert.', [
          {
            type: 'url_citation',
            url: 'https://example.com/custard',
            title: 'Custard',
            start_index: 0,
            end_index: 7
          }
        ])
      ])
    if (afterTool) return responsesReply(res, stream, [message('Done here.')])
    return responsesReply(res, stream, [
      {
        type: 'function_call',
        id: 'fc_1',
        call_id: 'call_1',
        name: kind === 'chat' ? 'web_search' : 'vault_list',
        arguments: kind === 'chat' ? '{"query":"custard recipes"}' : '{}',
        status: 'completed'
      }
    ])
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
const until = async (f, ms = 30000) => {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (await f()) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}

// Dates, times, ids and the vault's path differ between runs.
const norm = (v) =>
  JSON.parse(
    JSON.stringify(v, (k, x) => {
      if (['id', 'call_id', 'tool_use_id'].includes(k) && typeof x === 'string') return '<id>'
      if (k === 'x-stainless-timeout') return '<timeout>'
      if (typeof x === 'string')
        return x
          .replace(/\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?/g, '<date>')
          .replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, '<time>')
          .replace(/\b(Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day\b/g, '<day>')
          .replace(
            /\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/g,
            '<month>'
          )
          .replace(new RegExp(VAULT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '<vault>')
          .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>')
      return x
    })
  )

const record = {}
const PROVIDERS = [
  { id: 'claude', who: 'anthropic', tab: 'Claude', model: 'claude-opus-5-5' },
  { id: 'openai', who: 'openai', tab: 'OpenAI', model: 'gpt-6-astra' },
  { id: 'deepseek', who: 'deepseek', tab: 'DeepSeek', model: 'deepseek-flash' }
]
try {
  step('Set up: three keys and the vault')
  await w.click('button[title=Settings]')
  await w.click('button:has-text("Use an existing vault")')
  await w.waitForSelector('text=· connected')
  await w.evaluate(async () => {
    await window.custard.apiKey.set('claude', 'sk-ant-REQ-0000000000')
    await window.custard.apiKey.set('openai', 'sk-REQ-openai-1111111111')
    await window.custard.apiKey.set('deepseek', 'sk-REQ-deepseek-2222222222')
  })
  await w.click('button:text-is("Done")')

  for (const p of PROVIDERS) {
    step(`automation: ${p.id}`)
    const n = seen.length
    const saved = await w.evaluate(
      (model) =>
        window.custard.automations.save({
          name: `req ${model}`,
          skill: 'req-log',
          model,
          times: ['07:30'],
          days: [],
          folders: [],
          plugins: [],
          enabled: false,
          limits: { runsPerDay: 24, toolCalls: 30, catchUpRuns: 3 }
        }),
      p.model
    )
    check(saved.ok, `saved (${saved.problem ?? ''})`)
    await w.evaluate((id) => window.custard.automations.runNow(id), saved.id)
    check(
      await until(() => seen.slice(n).filter((s) => s.kind === 'automation').length >= 2),
      'two steps were sent'
    )
    await new Promise((r) => setTimeout(r, 1000))
    const runs = await w.evaluate(async (id) => {
      const v = (await window.custard.automations.list()).find((x) => x.automation.id === id)
      return v?.runs?.map((r) => [r.status, r.reason ?? '', r.summary ?? '', r.calls]) ?? []
    }, saved.id)
    const mine = seen.slice(n).filter((s) => s.kind === 'automation')
    check(
      mine.every((s) => s.who === p.who),
      `all to ${p.who}`
    )
    record[`automation:${p.id}`] = norm({
      requests: mine.map(({ method, path, headers, body }) => ({ method, path, headers, body })),
      runs
    })
  }

  for (const p of PROVIDERS.filter((x) => x.id !== 'deepseek')) {
    step(`search: ${p.id}`)
    const n = seen.length
    await w.locator('button[title]:text-is("Chat")').click()
    await w.click('button[title=Model]')
    await w.click(`[aria-label="Pick a model"] [role=tab]:text-is("${p.tab}")`)
    await w.click(`[data-pick="${p.model}"]`)
    await w.fill('textarea', `search test (${p.id})`)
    await w.keyboard.press('Enter')
    // The assistant can see the vault's memory, so the query is approved.
    const card = '[role=alertdialog]'
    if (
      await until(
        async () =>
          (await w.locator(card).count()) > 0 || seen.slice(n).some((s) => s.kind === 'search'),
        15000
      )
    )
      if (await w.locator(card).count()) await w.click(`${card} button:text-is("Allow")`)
    check(await until(() => seen.slice(n).some((s) => s.kind === 'search')), 'the search ran')
    await w.waitForSelector('text=Done here.', { timeout: 30000 })
    const mine = seen.slice(n).filter((s) => s.kind === 'search')
    check(mine.length === 1 && mine[0].who === p.who, `one search call, to ${p.who}`)
    const result = seen
      .slice(n)
      .filter((s) => s.kind === 'chat')
      .at(-1)
    record[`search:${p.id}`] = norm({
      requests: mine.map(({ method, path, headers, body }) => ({ method, path, headers, body })),
      // What the chat model got back from the search.
      result: JSON.stringify(result?.body.messages?.at(-1) ?? result?.body.input?.at(-1))
    })
    await w.screenshot({ path: `${SHOTS}/provider-requests-search-${p.id}.png` })
  }

  step('DeepSeek: no web search offered')
  const dsTurn = seen.find((s) => s.kind === 'automation' && s.who === 'deepseek')
  check(
    !(dsTurn?.body.tools ?? []).some((t) => t.name === 'web_search'),
    'a DeepSeek automation is not offered web_search'
  )
  const scan = await w.evaluate(() => window.custard.capabilities.scan())
  const cell = scan.providers.find((c) => c.id === 'deepseek')?.cells.web_search
  check(
    cell?.state === 'unsupported',
    `the capability matrix says DeepSeek has no web search (${cell?.state})`
  )

  step('Compare with the golden record')
  const got = JSON.stringify(record, null, 1)
  fs.writeFileSync(`${OUT}/provider-requests.json`, got)
  if (FLAG === '--update' || !fs.existsSync(GOLDEN)) {
    fs.writeFileSync(GOLDEN, got + '\n')
    console.log('golden record written')
  } else {
    const want = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'))
    for (const k of Object.keys(want))
      check(JSON.stringify(want[k]) === JSON.stringify(record[k]), `${k}: identical`)
  }
  check(!errors.length, `no page errors (${errors.join('; ')})`)
} finally {
  await app.close()
  server.close()
}
console.log('\ne2e done, exit', process.exitCode ?? 0)
