// A characterization test of the Responses chat turn (OpenAI and DeepSeek),
// in the built app, against a stand-in for the Responses API that this
// script runs itself (no request reaches a provider). As claude-turn.mjs does
// for Claude, it records for each scenario the requests the turn sends, every
// chat event it emits and what the chat keeps, and compares the record with
// test/e2e/responses-turn.golden.json. Written before automations and web
// search moved onto the adapters (provider adapters, Phase 7) so the move can
// be shown to change nothing. Each provider runs every scenario in one chat:
//   plain      reasoning (a summary from OpenAI, reasoning text from
//              DeepSeek) and text
//   tool       a vault_list round, then the answer
//   cutoff     the answer stops at the output limit (incomplete)
//   cuttool    the output limit while calling a tool, so nothing runs
//   steps      a tool call every time, until the step limit
//   stop       the user stops it mid-answer
//   refusal    the model declines (a refusal part)
//   error      the key is rejected (401)
// Usage, from the repo root after `npx electron-vite build`:
//   node test/e2e/responses-turn.mjs <out> <screenshot dir> [--update]
// with <out>/vault a copy of vault-template/. --update rewrites the golden
// file. Linux only as written, with a display or xvfb-run. Needs the
// playwright package.
import { _electron as electron } from 'playwright'
import { createRequire } from 'module'
import fs from 'fs'
import http from 'http'
import { createHash } from 'crypto'

const [, , OUT, SHOTS, FLAG] = process.argv
const GOLDEN = new URL('./responses-turn.golden.json', import.meta.url)
const check = (cond, what) => {
  console.log((cond ? '✓ ' : '✕ ') + what)
  if (!cond) process.exitCode = 1
}
const step = (s) => console.log('\n## ' + s)
const CFG = OUT + '/cfg-responses-turn'
const VAULT = OUT + '/vault'
fs.rmSync(CFG, { recursive: true, force: true })

const usage = {
  input_tokens: 900,
  input_tokens_details: { cached_tokens: 100 },
  output_tokens: 40,
  output_tokens_details: { reasoning_tokens: 10 },
  total_tokens: 940
}
let calls = 0
const call = () => ({
  type: 'function_call',
  id: `fc_${calls}`,
  call_id: `call_${++calls}`,
  name: 'vault_list',
  arguments: '{}',
  status: 'completed'
})
const message = (text, part = 'output_text') => ({
  type: 'message',
  id: 'msg_1',
  role: 'assistant',
  status: 'completed',
  content: [
    part === 'refusal' ? { type: 'refusal', refusal: text } : { type: part, text, annotations: [] }
  ]
})
const reasoning = (provider, text) =>
  provider === 'openai'
    ? {
        type: 'reasoning',
        id: 'rs_1',
        summary: [{ type: 'summary_text', text }],
        encrypted_content: 'ENCRYPTED'
      }
    : { type: 'reasoning', id: 'rs_1', summary: [], content: [{ type: 'reasoning_text', text }] }

// One streamed Responses reply: deltas, then the final event (completed,
// or incomplete at the output limit).
function stream(res, { deltas = [], output = [], incomplete = false, hang = false }) {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  let n = 0
  const send = (e) =>
    res.write(`event: ${e.type}\ndata: ${JSON.stringify({ ...e, sequence_number: n++ })}\n\n`)
  for (const d of deltas) send(d)
  if (hang) return
  send({
    type: incomplete ? 'response.incomplete' : 'response.completed',
    response: {
      id: 'resp_1',
      object: 'response',
      status: incomplete ? 'incomplete' : 'completed',
      ...(incomplete ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
      output,
      usage
    }
  })
  res.end()
}
const textDelta = (t) => ({ type: 'response.output_text.delta', delta: t })
let hanging = null

// Every turn request, by scenario; background calls (titles, notes, memory)
// are answered with a 400 and not recorded.
const seen = []
const said = (i) =>
  typeof i.content === 'string'
    ? i.content
    : Array.isArray(i.content)
      ? i.content.map((c) => c.text ?? '').join('')
      : ''
const scenarioOf = (body) => {
  const users = (body.input ?? []).filter((i) => i.role === 'user')
  return (/rt (\w+)/.exec(said(users.at(-1) ?? {})) ?? [])[1]
}

const server = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    const body = JSON.parse(raw || '{}')
    const provider = req.url.startsWith('/openai/') ? 'openai' : 'deepseek'
    if (!body.stream || !req.url.endsWith('/responses')) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({ error: { type: 'invalid_request_error', message: 'not in this test' } })
      )
      return
    }
    const s = scenarioOf(body)
    seen.push({ provider, scenario: s, body })
    const afterTool = body.input.at(-1)?.type === 'function_call_output'
    if (s === 'plain') {
      const r = 'Thinking it over.'
      return stream(res, {
        deltas: [
          provider === 'openai'
            ? {
                type: 'response.reasoning_summary_text.delta',
                item_id: 'rs_1',
                output_index: 0,
                summary_index: 0,
                delta: r
              }
            : {
                type: 'response.reasoning_text.delta',
                item_id: 'rs_1',
                output_index: 0,
                content_index: 0,
                delta: r
              },
          textDelta('Hello'),
          textDelta(' there.')
        ],
        output: [reasoning(provider, r), message('Hello there.')]
      })
    }
    if (s === 'tool')
      return afterTool
        ? stream(res, {
            deltas: [textDelta('Your vault has a Custard folder.')],
            output: [message('Your vault has a Custard folder.')]
          })
        : stream(res, { deltas: [textDelta('Looking.')], output: [message('Looking.'), call()] })
    if (s === 'cutoff')
      return stream(res, {
        deltas: [textDelta('This answer is cut')],
        output: [message('This answer is cut')],
        incomplete: true
      })
    if (s === 'cuttool')
      return stream(res, {
        deltas: [textDelta('Checking.')],
        output: [message('Checking.'), call()],
        incomplete: true
      })
    if (s === 'steps') return stream(res, { output: [call()] })
    if (s === 'stop') {
      hanging = res
      return stream(res, { deltas: [textDelta('Starting a long answer')], hang: true })
    }
    if (s === 'refusal')
      return stream(res, { output: [message("I can't help with that.", 'refusal')] })
    if (s === 'error') {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          error: {
            message: 'Incorrect API key provided.',
            type: 'invalid_request_error',
            code: 'invalid_api_key'
          }
        })
      )
      return
    }
    res.writeHead(500)
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
w.on('pageerror', (e) => console.log('pageerror:', e.message))
await w.waitForSelector('text=Custard')
// Every chat event the main process sends, in order.
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
const chats = () => {
  const dir = `${CFG}/custard/conversations`
  return fs.existsSync(dir)
    ? fs.readdirSync(dir).map((f) => JSON.parse(fs.readFileSync(`${dir}/${f}`, 'utf8')))
    : []
}

// Ids, dates and timings differ between runs; everything else must match.
const ids = new Map()
const norm = (v) =>
  JSON.parse(
    JSON.stringify(v, function (k, x) {
      if (k === 'requestId' || k === 'id' || k === 'tool_use_id') {
        if (typeof x !== 'string') return x
        if (!ids.has(x)) ids.set(x, `#${ids.size + 1}`)
        return ids.get(x)
      }
      if (['createdAt', 'updatedAt', 'at', 'ms', 'elapsedMs'].includes(k)) return 0
      // Background work (memory capture, the chat note) runs on its own
      // clock, apart from the turn.
      if (k === 'memory' || k === 'chatNote') return undefined
      // The prompt-cache snapshot's memory epoch starts at the app's start
      // time, and its hash covers the dated system prompt.
      if ((k === 'epoch' || k === 'fixed') && 'deferred' in this) return `<${k}>`
      // The model and effort a chat keeps (Phase 6), on the saved chat
      // only; the request's own model is still compared.
      if ((k === 'model' || k === 'effort') && 'title' in this && 'mode' in this) return undefined
      if (typeof x === 'string')
        return x
          .replace(/\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?/g, '<date>')
          .replace(/\b\d{1,2}:\d{2}\b/g, '<time>')
          .replace(/\b(Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day\b/g, '<day>')
          .replace(new RegExp(VAULT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '<vault>')
          .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>')
      return x
    })
  )

const record = {}
const PROVIDERS = [
  { id: 'openai', tab: 'OpenAI', model: 'gpt-6-astra' },
  { id: 'deepseek', tab: 'DeepSeek', model: 'deepseek-flash' }
]
const SCENARIOS = ['plain', 'tool', 'cutoff', 'cuttool', 'steps', 'stop', 'refusal', 'error']
try {
  step('Set up: OpenAI and DeepSeek keys and the vault')
  await w.click('button[title=Settings]')
  await w.click('button:has-text("Use an existing vault")')
  await w.waitForSelector('text=· connected')
  await w.evaluate(async () => {
    await window.custard.apiKey.set('openai', 'sk-RT-openai-1111111111')
    await window.custard.apiKey.set('deepseek', 'sk-RT-deepseek-2222222222')
  })
  await w.click('button:text-is("Done")')

  for (const p of PROVIDERS) {
    // A new chat on this provider's model.
    await w.locator('button[title]:text-is("Chat")').click()
    await w.click('button[title=Model]')
    await w.click(`[aria-label="Pick a model"] [role=tab]:text-is("${p.tab}")`)
    await w.click(`[data-pick="${p.model}"]`)
    for (const s of SCENARIOS) {
      const key = `${p.id}:${s}`
      step(key)
      const before = (await events()).length
      const requests = seen.length
      await w.fill('textarea', `rt ${s}: go (${p.id})`)
      await w.keyboard.press('Enter')
      if (s === 'stop') {
        check(
          await until(async () => (await events()).slice(before).some((e) => e.type === 'text')),
          'the answer started'
        )
        await w.click('button[title=Stop]')
      }
      const ended = await until(async () =>
        (await events()).slice(before).some((e) => e.type === 'done' || e.type === 'error')
      )
      check(ended, 'the turn ended')
      await w.waitForSelector('button[title=Send]', { timeout: 30000 })
      if (hanging) {
        hanging.end()
        hanging = null
      }
      await new Promise((r) => setTimeout(r, 500))
      const chat = chats()
        .filter((c) => JSON.stringify(c.messages).includes(`(${p.id})`))
        .sort((a, b) => b.updatedAt - a.updatedAt)[0]
      const mine = seen.slice(requests)
      check(
        mine.every((r) => r.provider === p.id),
        `every request went to ${p.id} (${mine.map((r) => r.provider)})`
      )
      record[key] = norm({
        requests: mine.map(({ body }) => {
          const b = norm(body)
          return {
            hash: createHash('sha256').update(JSON.stringify(b)).digest('hex'),
            model: b.model,
            max_output_tokens: b.max_output_tokens,
            reasoning: b.reasoning,
            include: b.include,
            store: b.store,
            context_management: b.context_management,
            tools: (b.tools ?? []).map((t) => t.name),
            input: b.input.length,
            last: b.input.at(-1)
          }
        }),
        events: (await events()).slice(before),
        draft: await w.inputValue('textarea'),
        chat: chat && {
          messages: chat.messages,
          notices: chat.notices ?? [],
          actions: chat.actions ?? {}
        }
      })
      await w.screenshot({ path: `${SHOTS}/responses-turn-${p.id}-${s}.png` })
      await w.fill('textarea', '')
    }
  }

  step('Compare with the golden record')
  const got = JSON.stringify(record, null, 1)
  fs.writeFileSync(`${OUT}/responses-turn.json`, got)
  if (FLAG === '--update' || !fs.existsSync(GOLDEN)) {
    fs.writeFileSync(GOLDEN, got + '\n')
    console.log('golden record written')
  } else {
    // The context estimate counts the system prompt's characters, and the
    // date in it (Tuesday, Wednesday) changes its length from day to day.
    const same = (x) =>
      JSON.stringify(x, (k, v) =>
        k === 'context' && v && typeof v === 'object' ? { ...v, tokens: '<estimate>' } : v
      )
    const want = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'))
    for (const s of Object.keys(want))
      for (const part of ['requests', 'events', 'draft', 'chat'])
        check(same(want[s][part]) === same(record[s]?.[part]), `${s}: ${part} identical`)
  }
} finally {
  await app.close()
  server.close()
}
console.log('\ne2e done, exit', process.exitCode ?? 0)
