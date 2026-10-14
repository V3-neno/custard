// DeepSeek in the built app, against a stand-in for DeepSeek's Responses API
// that this script runs itself (no request reaches DeepSeek):
//   - Settings takes a DeepSeek key; picking a DeepSeek model turns the app
//     deep blue
//   - a turn with a tool call goes to DeepSeek's own address with the
//     DeepSeek key, asks for nothing DeepSeek ignores, offers no web search,
//     and passes the reasoning back with the tool result
//   - the chat is charged at DeepSeek's prices
// Usage, from the repo root after `npx electron-vite build`:
//   node test/e2e/deepseek.mjs <out> <screenshot dir>
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
const CFG = OUT + '/cfg-deepseek'
const VAULT = OUT + '/vault'
fs.rmSync(CFG, { recursive: true, force: true })

// The stand-in: the first turn request gets reasoning and a vault_list call,
// the second the answer. Anything else (background summaries) gets a 400.
const seen = []
const usage = {
  input_tokens: 1200,
  input_tokens_details: { cached_tokens: 200 },
  output_tokens: 80,
  output_tokens_details: { reasoning_tokens: 30 },
  total_tokens: 1280
}
const reasoning = {
  type: 'reasoning',
  id: 'rs_1',
  summary: [],
  content: [{ type: 'reasoning_text', text: 'The user wants the vault listed.' }]
}
let turns = 0
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const json = JSON.parse(body || '{}')
    seen.push({ path: req.url, auth: req.headers.authorization, body: json })
    if (!json.stream) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'not in this test' } }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const send = (e) => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
    let n = 0
    if (turns++ === 0) {
      send({ type: 'response.reasoning_text.delta', sequence_number: n++, delta: 'The user wants' })
      send({
        type: 'response.reasoning_text.delta',
        sequence_number: n++,
        delta: ' the vault listed.'
      })
      send({
        type: 'response.completed',
        sequence_number: n++,
        response: {
          status: 'completed',
          output: [
            reasoning,
            { type: 'function_call', call_id: 'call_1', name: 'vault_list', arguments: '{}' }
          ],
          usage
        }
      })
    } else {
      const text = 'Your vault has a Custard folder.'
      send({ type: 'response.output_text.delta', sequence_number: n++, delta: text })
      send({
        type: 'response.completed',
        sequence_number: n++,
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
          usage
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
    // Anything sent to OpenAI's or Claude's stand-in addresses would show up
    // in `seen` under these paths.
    ANTHROPIC_BASE_URL: `${base}/anthropic`,
    OPENAI_BASE_URL: `${base}/openai`,
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
const until = async (f, ms = 15000) => {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (await f()) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}
const chatFile = (start) => {
  const dir = `${CFG}/custard/conversations`
  return fs
    .readdirSync(dir)
    .map((f) => JSON.parse(fs.readFileSync(`${dir}/${f}`, 'utf8')))
    .find((c) => c.title.startsWith(start))
}

try {
  step('Settings takes a DeepSeek key')
  await w.click('button[title=Settings]')
  const keyField = 'input[aria-label="DeepSeek API key"]'
  check(await w.isVisible(keyField), 'there is a DeepSeek key field after Claude and OpenAI')
  check(
    await w.isVisible('text=Get one at platform.deepseek.com.'),
    'it says where to get a DeepSeek key'
  )
  await w.fill(keyField, 'sk-ds-test')
  await w.press(keyField, 'Enter')
  await w.waitForSelector('text=Get one at platform.deepseek.com.')
  await w.locator(keyField).scrollIntoViewIfNeeded()
  await w.screenshot({ path: `${SHOTS}/deepseek-01-settings.png` })
  await w.click('button:has-text("Use an existing vault")')
  await w.waitForSelector('text=· connected')
  await w.click('button:text-is("Done")')

  step('Picking a DeepSeek model turns the app deep blue')
  await w.click('button[title=Model]')
  await w.click('[aria-label="Pick a model"] [role=tab]:text-is("DeepSeek")')
  const options = await w
    .locator('[data-picker-models=deepseek] [data-pick]')
    .evaluateAll((bs) => bs.map((b) => b.childNodes[0].textContent))
  check(
    JSON.stringify(options) === JSON.stringify(['DeepSeek V4 Pro', 'DeepSeek Flash']),
    `the model picker lists DeepSeek's models (${options.join(', ')})`
  )
  await w.click('[data-pick=deepseek-flash]')
  // The tint follows on the next render, so wait for it rather than read once.
  await w
    .waitForFunction(() => document.documentElement.dataset.provider === 'deepseek', null, {
      timeout: 5000
    })
    .catch(() => {})
  check(
    (await w.evaluate(() => document.documentElement.dataset.provider)) === 'deepseek',
    'the app follows the DeepSeek tint'
  )
  const forge = await w.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--color-forge-950').trim()
  )
  check(forge === '#05070f', `the background is deep blue (${forge})`)

  step('A turn with a tool call')
  await w.fill('textarea', 'deepseek test: what is in my vault?')
  await w.keyboard.press('Enter')
  await w.waitForSelector('text=Your vault has a Custard folder.', { timeout: 30000 })
  await w.waitForSelector('button[title=Send]', { timeout: 30000 })
  await w.screenshot({ path: `${SHOTS}/deepseek-02-answer.png` })
  const turnCalls = seen.filter((s) => s.body.stream)
  check(turnCalls.length === 2, `two model calls (${turnCalls.length})`)
  check(
    seen.every((s) => s.path.startsWith('/deepseek/')),
    `everything went to DeepSeek's address (${[...new Set(seen.map((s) => s.path))].join(', ')})`
  )
  check(
    turnCalls.every((s) => s.auth === 'Bearer sk-ds-test'),
    'with the DeepSeek key'
  )
  const first = turnCalls[0]?.body ?? {}
  check(first.model === 'deepseek-flash', 'for DeepSeek Flash')
  check(
    !('include' in first) && first.reasoning && !('summary' in first.reasoning),
    'asking for no encrypted reasoning or summaries'
  )
  check(
    /^You are DeepSeek Flash, a DeepSeek model/.test(first.instructions ?? ''),
    'introducing the model as DeepSeek'
  )
  const tools = (first.tools ?? []).map((t) => t.name)
  check(
    tools.includes('vault_list') && tools.includes('web_read') && !tools.includes('web_search'),
    'offering vault and page reading, but no web search'
  )
  check(
    (first.instructions ?? '').includes("Web search isn't available with deepseek-flash"),
    'and telling the model search is not available'
  )
  const second = turnCalls[1]?.body ?? {}
  check(
    JSON.stringify(second.input ?? []).includes('The user wants the vault listed.'),
    'the reasoning goes back with the tool result'
  )
  check(
    (second.input ?? []).some((i) => i.type === 'function_call_output' && i.call_id === 'call_1'),
    'with the vault_list result'
  )

  step('The chat is charged at DeepSeek prices')
  const c = await until(() => chatFile('deepseek test')?.usage?.calls >= 2).then(() =>
    chatFile('deepseek test')
  )
  // Per call: 1,000 fresh input at $0.30/M, 200 cached at $0.006/M, 80
  // output at $1.20/M.
  const expected = 2 * ((1000 * 0.3 + 200 * 0.006 + 80 * 1.2) / 1e6)
  check(
    Math.abs((c?.usage?.cost ?? -1) - expected) < 1e-9,
    `the chat's cost is DeepSeek's peak price (${c?.usage?.cost} vs ${expected})`
  )
} finally {
  await app.close()
  server.close()
}
console.log('\ne2e done, exit', process.exitCode ?? 0)
