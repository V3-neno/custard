// A characterization test of the Claude chat turn, in the built app, against
// a stand-in for Anthropic's Messages API that this script runs itself (no
// request reaches Anthropic). It records, for each scenario, the requests the
// turn sends, every chat event it emits and what the chat keeps (messages,
// notices, actions), and compares the record with
// test/e2e/claude-turn.golden.json. Written before the Claude turn moved out
// of chat.ts (provider adapters, Phase 2) so the move can be shown to change
// nothing.
//   plain      thinking and text, then end_turn
//   tool       a vault_list round, then the answer
//   cutoff     the answer stops at max_tokens
//   cuttool    max_tokens while calling a tool, so nothing runs
//   steps      a tool call every time, until the step limit
//   stop       the user stops it mid-answer
//   refusal    Claude declines
//   full       the reply fills the context window
//   error      the key is rejected (401)
//   fulltool   the reply fills the context window while calling a tool
//   fallback   a fallback model takes over mid-answer
//   compact    Claude compacts the chat, then answers
// The same scenarios run on Sonnet 5.5 and Haiku 4.5 (claude-turn-sonnet.mjs
// and claude-turn-haiku.mjs set CLAUDE_TURN_MODEL), each against its own
// golden file, picked as the default model before the first message.
// Usage, from the repo root after `npx electron-vite build`:
//   node test/e2e/claude-turn.mjs <out> <screenshot dir> [--update]
// with <out>/vault a copy of vault-template/. --update rewrites the golden
// file. Linux only as written, with a display or xvfb-run. Needs the
// playwright package.
import { _electron as electron } from 'playwright'
import { createRequire } from 'module'
import fs from 'fs'
import http from 'http'
import { createHash } from 'crypto'

const [, , OUT, SHOTS, FLAG] = process.argv
const MODEL = process.env.CLAUDE_TURN_MODEL
const GOLDEN = new URL(
  MODEL ? `./claude-turn-${MODEL}.golden.json` : './claude-turn.golden.json',
  import.meta.url
)
const check = (cond, what) => {
  console.log((cond ? '✓ ' : '✕ ') + what)
  if (!cond) process.exitCode = 1
}
const step = (s) => console.log('\n## ' + s)
const CFG = OUT + (MODEL ? `/cfg-claude-turn-${MODEL}` : '/cfg-claude-turn')
const VAULT = OUT + '/vault'
fs.rmSync(CFG, { recursive: true, force: true })

const usage = { input_tokens: 900, output_tokens: 40 }
// One streamed Messages API reply: blocks, then the stop reason.
function stream(res, blocks, stop, { hang = false, details } = {}) {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const send = (e) => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
  send({
    type: 'message_start',
    message: {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      // The model the request asked for, as the API answers.
      model: replyModel,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { ...usage, output_tokens: 1 }
    }
  })
  blocks.forEach((b, index) => {
    if (b.type === 'text') {
      send({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
      for (const part of b.parts)
        send({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: part } })
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
    } else if (b.type === 'raw') {
      send({ type: 'content_block_start', index, content_block: b.block })
    } else {
      send({
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} }
      })
      send({
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) }
      })
    }
    send({ type: 'content_block_stop', index })
  })
  if (hang) return
  send({
    type: 'message_delta',
    delta: {
      stop_reason: stop,
      stop_sequence: null,
      ...(details ? { stop_details: details } : {})
    },
    usage
  })
  send({ type: 'message_stop' })
  res.end()
}

let replyModel = 'claude-opus-5-5'
const text = (...parts) => ({ type: 'text', parts })
let calls = 0
const call = () => ({ type: 'tool_use', id: `toolu_${++calls}`, name: 'vault_list', input: {} })
let hanging = null

// Every request, by scenario; background calls (titles, notes, memory) are
// answered with a 400 and not recorded.
const seen = []
const scenarioOf = (body) => {
  const first = body.messages?.find((m) => m.role === 'user')
  const lastUser = [...(body.messages ?? [])]
    .reverse()
    .find(
      (m) =>
        m.role === 'user' &&
        (typeof m.content === 'string' || m.content.some((c) => c.type === 'text'))
    )
  const t = (m) =>
    typeof m?.content === 'string'
      ? m.content
      : (m?.content ?? []).map((c) => c.text ?? '').join('')
  return (/ct (\w+)/.exec(t(lastUser)) ?? /ct (\w+)/.exec(t(first)) ?? [])[1]
}
const isResults = (m) => Array.isArray(m.content) && m.content.some((c) => c.type === 'tool_result')

const server = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    const body = JSON.parse(raw || '{}')
    if (!body.stream || new URL(req.url, 'http://x').pathname !== '/v1/messages') {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          type: 'error',
          error: { type: 'invalid_request_error', message: 'not in this test' }
        })
      )
      return
    }
    const s = scenarioOf(body)
    seen.push({ scenario: s, body })
    replyModel = body.model
    const afterTool = isResults(body.messages.at(-1))
    if (s === 'plain')
      return stream(
        res,
        [{ type: 'thinking', text: 'Thinking it over.' }, text('Hello', ' there.')],
        'end_turn'
      )
    if (s === 'tool')
      return afterTool
        ? stream(res, [text('Your vault has a Custard folder.')], 'end_turn')
        : stream(res, [text('Looking.'), call()], 'tool_use')
    if (s === 'cutoff') return stream(res, [text('This answer is cut')], 'max_tokens')
    if (s === 'cuttool') return stream(res, [text('Checking.'), call()], 'max_tokens')
    if (s === 'steps') return stream(res, [call()], 'tool_use')
    if (s === 'stop') {
      hanging = res
      return stream(res, [text('Starting a long answer')], null, { hang: true })
    }
    if (s === 'refusal') return stream(res, [], 'refusal', { details: { category: 'cyber' } })
    if (s === 'full')
      return stream(res, [text('Filling the window')], 'model_context_window_exceeded')
    if (s === 'fulltool')
      return stream(res, [text('Calling.'), call()], 'model_context_window_exceeded')
    if (s === 'fallback')
      return stream(
        res,
        [
          { type: 'thinking', text: 'The first model thinks.' },
          {
            type: 'raw',
            block: {
              type: 'fallback',
              from: { model: 'claude-opus-5-5' },
              to: { model: 'claude-sonnet-5-5' },
              trigger: { type: 'refusal' }
            }
          },
          text('From the fallback model.')
        ],
        'end_turn'
      )
    if (s === 'compact')
      return stream(
        res,
        [
          {
            type: 'raw',
            block: { type: 'compaction', content: 'Summary so far.', encrypted_content: null }
          },
          text('After compacting.')
        ],
        'end_turn'
      )
    if (s === 'error') {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          type: 'error',
          error: { type: 'authentication_error', message: 'invalid x-api-key' }
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
    ANTHROPIC_BASE_URL: base,
    OPENAI_BASE_URL: `${base}/openai`,
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
try {
  step('Set up: a Claude key and the vault')
  await w.click('button[title=Settings]')
  await w.fill('input[aria-label="Claude API key"]', 'sk-ant-test')
  await w.press('input[aria-label="Claude API key"]', 'Enter')
  await w.click('button:has-text("Use an existing vault")')
  await w.waitForSelector('text=· connected')
  if (MODEL) await w.selectOption('select[title="Default model"]', MODEL)
  await w.click('button:text-is("Done")')

  for (const s of [
    'plain',
    'tool',
    'cutoff',
    'cuttool',
    'steps',
    'stop',
    'refusal',
    'full',
    'error',
    'fulltool',
    'fallback',
    'compact'
  ]) {
    step(s)
    const before = (await events()).length
    const requests = seen.length
    const prompt = `ct ${s}: go`
    await w.fill('textarea', prompt)
    await w.keyboard.press('Enter')
    if (s === 'stop') {
      // The answer shows only once the turn ends, so wait for its text event.
      check(
        await until(async () => (await events()).slice(before).some((e) => e.type === 'text')),
        'the answer started'
      )
      await w.click('button[title=Stop]')
    }
    const ended = await until(async () =>
      (await events()).slice(before).some((e) => e.type === 'done' || e.type === 'error')
    )
    check(ended, `the turn ended`)
    await w.waitForSelector('button[title=Send]', { timeout: 30000 })
    if (hanging) {
      hanging.end()
      hanging = null
    }
    await new Promise((r) => setTimeout(r, 500))
    const chat = chats()
      .filter((c) => JSON.stringify(c.messages).includes('ct '))
      .sort((a, b) => b.updatedAt - a.updatedAt)[0]
    record[s] = norm({
      // Each request in full as a hash, plus the parts worth reading.
      requests: seen.slice(requests).map(({ body }) => {
        const b = norm(body)
        return {
          hash: createHash('sha256').update(JSON.stringify(b)).digest('hex'),
          model: b.model,
          max_tokens: b.max_tokens,
          betas: b.betas,
          thinking: b.thinking,
          output_config: b.output_config,
          fallbacks: b.fallbacks,
          cache_control: b.cache_control,
          context_management: b.context_management,
          tools: (b.tools ?? []).map((t) => t.name),
          messages: b.messages.length,
          last: b.messages.at(-1)
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
    await w.screenshot({ path: `${SHOTS}/claude-turn-${MODEL ? MODEL + '-' : ''}${s}.png` })
    // A fresh box for the next one.
    await w.fill('textarea', '')
  }

  step('Compare with the golden record')
  const got = JSON.stringify(record, null, 1)
  fs.writeFileSync(`${OUT}/claude-turn.json`, got)
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
