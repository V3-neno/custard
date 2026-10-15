// Skills, vault tools, plugin tools and approvals with each provider
// (provider adapters, Phase 7). The same scripted turn runs in a new Chat
// chat on Claude Opus 5.5, GPT-6 Astra and DeepSeek Flash, against stand-ins
// for the three APIs that this script runs itself (no request reaches a
// provider), with the Tally test plugin (test/fixtures/widget-plugins/tally)
// turned on and the folder Notes allowed for creating notes:
//   1. vault_list, and vault_read of every starter skill's SKILL.md
//   2. vault_create_note in Notes: allowed folder, nothing outside yet, so no card
//   3. tally__count: a plugin's read tool (its result is outside text)
//   4. vault_create_note in Notes again: the chat now holds plugin text, so the
//      chat guard asks first (card), and the user allows it
//   5. tally__add: a plugin's write tool, always asked; the user declines
//   6. the answer
// For each provider it records the tools offered, the system prompt (with the
// model's own name taken out), every tool result, what each call ended as and
// which cards were shown, and compares the three. The table it prints is the
// one in the Phase 7 review.
// Usage, from the repo root after `npx electron-vite build`:
//   node test/e2e/provider-matrix.mjs <out> <screenshot dir>
// with <out>/vault a copy of vault-template/ and <out>/plugin a copy of
// plugin/. Linux only as written, with a display or xvfb-run. Needs the
// playwright package.
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
const CFG = OUT + '/cfg-provider-matrix'
const VAULT = OUT + '/vault'
const PLUGINS = OUT + '/plugin-matrix'
fs.rmSync(CFG, { recursive: true, force: true })
fs.rmSync(PLUGINS, { recursive: true, force: true })
fs.mkdirSync(PLUGINS, { recursive: true })
fs.cpSync('test/fixtures/widget-plugins/tally', `${PLUGINS}/tally`, { recursive: true })
// Made up front, so the first provider's notes don't change what vault_list
// shows the next.
fs.mkdirSync(`${VAULT}/Notes`, { recursive: true })
const SKILLS = fs
  .readdirSync('vault-template/Custard/Skills')
  .filter((s) => fs.existsSync(`vault-template/Custard/Skills/${s}/SKILL.md`))
  .sort()

// The script, by round: the calls the model makes, then the answer.
const ROUNDS = (p) => [
  [
    { name: 'vault_list', input: {} },
    ...SKILLS.map((s) => ({ name: 'vault_read', input: { path: `Custard/Skills/${s}/SKILL.md` } }))
  ],
  [{ name: 'vault_create_note', input: { path: `Notes/Before ${p}.md`, content: 'Before.' } }],
  [{ name: 'tally__count', input: {} }],
  [{ name: 'vault_create_note', input: { path: `Notes/After ${p}.md`, content: 'After.' } }],
  [{ name: 'tally__add', input: { amount: 1 } }],
  'Matrix done.'
]

const seen = []
const claudeUsage = { input_tokens: 60, output_tokens: 10 }
function claudeStream(res, model, blocks, stop) {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const send = (e) => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
  send({
    type: 'message_start',
    message: {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model,
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
function responsesStream(res, output) {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  let n = 0
  const send = (e) =>
    res.write(`event: ${e.type}\ndata: ${JSON.stringify({ ...e, sequence_number: n++ })}\n\n`)
  for (const o of output)
    if (o.type === 'message') send({ type: 'response.output_text.delta', delta: o.content[0].text })
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

const server = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    const body = JSON.parse(raw || '{}')
    const who = req.url.split('/')[1]
    const text = JSON.stringify(body)
    const m = /matrix test \((\w+)\)/.exec(text)
    if (!body.stream || !m) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({ error: { type: 'invalid_request_error', message: 'not in this test' } })
      )
      return
    }
    seen.push({ who, body })
    const p = m[1]
    if (who === 'anthropic') {
      // Rounds so far: assistant messages since the user's message.
      let round = 0
      for (let i = body.messages.length - 1; i >= 0; i--) {
        const x = body.messages[i]
        if (
          x.role === 'user' &&
          (typeof x.content === 'string' || !x.content.some((c) => c.type === 'tool_result'))
        )
          break
        if (x.role === 'assistant') round++
      }
      const r = ROUNDS(p)[round]
      if (typeof r === 'string')
        return claudeStream(res, body.model, [{ type: 'text', text: r }], 'end_turn')
      return claudeStream(
        res,
        body.model,
        r.map((c, i) => ({ type: 'tool_use', id: `toolu_${round}_${i}`, ...c })),
        'tool_use'
      )
    }
    let round = 0
    for (let i = body.input.length - 1; i >= 0; i--) {
      if (body.input[i].role === 'user') break
      if (
        body.input[i].type === 'function_call_output' &&
        body.input[i - 1]?.type !== 'function_call_output'
      )
        round++
    }
    const r = ROUNDS(p)[round]
    if (typeof r === 'string')
      return responsesStream(res, [
        {
          type: 'message',
          id: 'm1',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: r, annotations: [] }]
        }
      ])
    return responsesStream(
      res,
      r.map((c, i) => ({
        type: 'function_call',
        id: `fc_${round}_${i}`,
        call_id: `call_${round}_${i}`,
        name: c.name,
        arguments: JSON.stringify(c.input),
        status: 'completed'
      }))
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
    CUSTARD_PLUGIN_DIR: PLUGINS,
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
const chatOf = (p) => {
  const dir = `${CFG}/custard/conversations`
  return fs
    .readdirSync(dir)
    .map((f) => JSON.parse(fs.readFileSync(`${dir}/${f}`, 'utf8')))
    .find((c) => JSON.stringify(c.messages).includes(`matrix test (${p})`))
}

const PROVIDERS = [
  { id: 'claude', who: 'anthropic', tab: 'Claude', model: 'claude-opus-5-5', name: 'Opus 5.5' },
  { id: 'openai', who: 'openai', tab: 'OpenAI', model: 'gpt-6-astra', name: 'GPT-6 Astra' },
  {
    id: 'deepseek',
    who: 'deepseek',
    tab: 'DeepSeek',
    model: 'deepseek-flash',
    name: 'DeepSeek Flash'
  }
]
const trace = {}
try {
  step('Set up: keys, vault, Notes allowed for new notes, Tally on')
  await w.click('button[title=Settings]')
  await w.click('button:has-text("Use an existing vault")')
  await w.waitForSelector('text=· connected')
  await w.evaluate(async () => {
    await window.custard.apiKey.set('claude', 'sk-ant-MX-0000000000')
    await window.custard.apiKey.set('openai', 'sk-MX-openai-1111111111')
    await window.custard.apiKey.set('deepseek', 'sk-MX-deepseek-2222222222')
    await window.custard.vault.setGrants([{ folder: 'Notes', mode: 'create' }])
  })
  await w.click('button:text-is("Done")')
  await w.locator('button[title]:text-is("Plugins")').click()
  await w.click('article[aria-label="Plugin Tally"] button:text-is("Manage")')
  await w.click('button:has-text("Review and activate")')
  await w.waitForSelector('text=New permissions to approve', { timeout: 30000 })
  const boxes = w.locator('section:has-text("New permissions to approve") input[type=checkbox]')
  for (let i = 0; i < (await boxes.count()); i++) await boxes.nth(i).check()
  await w.click('button:text-matches("^Activate [0-9]")')
  await w.waitForSelector('button:text-is("Disable")', { timeout: 30000 })
  await w.click('label:has-text("in Chat, Design and Skills") input[type=checkbox]')
  await w.waitForSelector('label:has-text("in Chat, Design and Skills") input:checked')
  await w.click('[role=dialog] button:text-is("Done")')
  await w.locator('button[title]:text-is("Chat")').click()

  for (const p of PROVIDERS) {
    step(`${p.name}`)
    const n = seen.length
    const before = (await events()).length
    await w.locator('button[title]:text-is("Chat")').click()
    await w.click('button[title=Model]')
    await w.click(`[aria-label="Pick a model"] [role=tab]:text-is("${p.tab}")`)
    await w.click(`[data-pick="${p.model}"]`)
    await w.fill('textarea', `matrix test (${p.id})`)
    await w.keyboard.press('Enter')
    const cards = []
    const card = '[role=alertdialog]'
    const ended = async () =>
      (await events()).slice(before).some((e) => e.type === 'done' || e.type === 'error')
    while (!(await ended())) {
      if (await w.locator(card).count()) {
        const t = (await w.locator(card).first().innerText()).replace(/\s+/g, ' ')
        cards.push(t.replace(new RegExp(p.id, 'g'), '<p>').slice(0, 120))
        const open = await w.locator(card).count()
        if (/Add 1 to the tally/.test(t)) await w.click(`${card} button:has-text("Don't allow")`)
        else await w.click(`${card} button:text-is("Allow")`)
        // Gone, or the next card in its place.
        await w.waitForFunction(
          ([len, was]) => {
            const cs = document.querySelectorAll('[role=alertdialog]')
            return cs.length < len || cs[0]?.innerText.replace(/\s+/g, ' ') !== was
          },
          [open, t]
        )
      }
      await new Promise((r) => setTimeout(r, 100))
    }
    await w.waitForSelector('button[title=Send]', { timeout: 30000 })
    const mine = seen.slice(n)
    const first = mine[0].body
    const c = chatOf(p.id)
    const results = c.messages
      .flatMap((m) => m.parts)
      .filter((b) => b.type === 'tool_result')
      .map((b) => b.text)
    const calls = c.messages.flatMap((m) => m.parts).filter((b) => b.type === 'tool_call')
    const sys =
      p.who === 'anthropic' ? first.system.map((s) => s.text).join('\n\n') : first.instructions
    trace[p.id] = {
      requests: mine.length,
      every: mine.every((r) => r.who === p.who),
      tools: (first.tools ?? []).map((t) => t.name).sort(),
      system: sys
        .replace(
          /You are Claude|You are GPT-6 Astra, an OpenAI model|You are DeepSeek Flash, a DeepSeek model/,
          'You are <model>'
        )
        .replace(/\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?/g, '<date>')
        .replace(/\b\d{1,2}:\d{2}\b/g, '<time>'),
      calls: calls.map((b) => [b.name, c.actions?.[b.id]?.status ?? 'none']),
      results: results.map((r) => r.replace(new RegExp(p.id, 'g'), '<p>')),
      cards,
      files: ['Before', 'After'].map((x) => fs.existsSync(`${VAULT}/Notes/${x} ${p.id}.md`)),
      answer: JSON.stringify(c.messages.at(-1))
    }
    check(trace[p.id].every, `every request went to ${p.who} (${mine.length})`)
    check(trace[p.id].answer.includes('Matrix done.'), 'the turn ended with the answer')
    await w.screenshot({ path: `${SHOTS}/provider-matrix-${p.id}.png` })
  }

  step('The same for every provider')
  const [cl, oa, ds] = PROVIDERS.map((p) => trace[p.id])
  const same = (f, what) => {
    const v = PROVIDERS.map((p) => JSON.stringify(f(trace[p.id])))
    check(
      v.every((x) => x === v[0]),
      what
    )
  }
  same(
    (t) => t.calls,
    `every call ended the same (${cl.calls.map(([n, s]) => `${n}:${s}`).slice(-5)})`
  )
  same((t) => t.results, `every tool result is the same text (${cl.results.length} results)`)
  same(
    (t) => t.cards,
    `the same approval cards (${cl.cards.length}: ${cl.cards.map((x) => x.slice(0, 40))})`
  )
  same((t) => t.files, `the same notes were made (${cl.files})`)
  same((t) => t.requests, `the same number of model requests (${cl.requests})`)
  const skillReads = cl.calls.filter(([n]) => n === 'vault_read')
  check(
    skillReads.length === SKILLS.length && skillReads.every(([, s]) => s === 'completed'),
    `all ${SKILLS.length} starter skills were read`
  )
  check(JSON.stringify(cl.files) === '[true,true]', 'both notes were made')
  check(cl.cards.length === 2, 'two cards: the chat-guarded note, and the plugin write')
  check(
    cl.calls.find(([n]) => n === 'tally__add')?.[1] === 'declined' ||
      cl.calls.find(([n]) => n === 'tally__add')?.[1] === 'not-run',
    `the declined plugin write didn't run (${cl.calls.find(([n]) => n === 'tally__add')?.[1]})`
  )
  // Tools: the same, except web search where the provider has none.
  const diff = (a, b) => a.filter((x) => !b.includes(x))
  check(
    JSON.stringify(cl.tools) === JSON.stringify(oa.tools),
    'Claude and OpenAI are offered the same tools'
  )
  check(
    JSON.stringify(diff(cl.tools, ds.tools)) === '["web_search"]' &&
      !diff(ds.tools, cl.tools).length,
    `DeepSeek is offered the same tools but web_search (${diff(cl.tools, ds.tools)})`
  )
  // System prompt: the same, except the model's name and what DeepSeek is
  // told about web search.
  const lines = (t) => t.system.split('\n')
  const sysDiff = (a, b) => lines(a).filter((l) => !lines(b).includes(l))
  check(cl.system === oa.system, 'Claude and OpenAI get the same instructions')
  const dsOnly = sysDiff(ds, cl)
  const clOnly = sysDiff(cl, ds)
  check(
    dsOnly.length === 1 &&
      /Web search isn't available with deepseek-flash/.test(dsOnly[0]) &&
      clOnly.length === 1 &&
      /web_search finds current information/.test(clOnly[0]),
    `DeepSeek's instructions differ only in the web search line (${dsOnly.map((l) => l.slice(0, 60))} | ${clOnly.map((l) => l.slice(0, 60))})`
  )
  check(!errors.length, `no page errors (${errors.join('; ')})`)

  // The review's table.
  const rows = [
    [
      'Starter skills read (vault_read)',
      (t) =>
        `${t.calls.filter(([n, s]) => n === 'vault_read' && s === 'completed').length}/${SKILLS.length}`
    ],
    ['vault_list', (t) => t.calls.find(([n]) => n === 'vault_list')?.[1]],
    [
      'Create in allowed folder, nothing outside',
      (t) =>
        `${t.calls.filter(([n]) => n === 'vault_create_note')[0]?.[1]}, ${t.files[0] ? 'made' : 'not made'}, no card`
    ],
    ['Plugin read (tally__count)', (t) => t.calls.find(([n]) => n === 'tally__count')?.[1]],
    [
      'Create after plugin text (chat guard)',
      (t) => `card, allowed, ${t.calls.filter(([n]) => n === 'vault_create_note')[1]?.[1]}`
    ],
    [
      'Plugin write (tally__add), declined',
      (t) => `card, ${t.calls.find(([n]) => n === 'tally__add')?.[1]}`
    ],
    ['Approval cards shown', (t) => String(t.cards.length)],
    ['Model requests in the turn', (t) => String(t.requests)],
    [
      'Tools offered',
      (t) => `${t.tools.length}${t.tools.includes('web_search') ? '' : ' (no web_search)'}`
    ]
  ]
  const table = [
    '| Check | Claude Opus 5.5 | GPT-6 Astra | DeepSeek Flash |',
    '| --- | --- | --- | --- |',
    ...rows.map(
      ([label, f]) => `| ${label} | ${PROVIDERS.map((p) => f(trace[p.id])).join(' | ')} |`
    )
  ].join('\n')
  console.log('\n' + table)
  fs.writeFileSync(`${SHOTS}/provider-matrix.md`, table + '\n')
  fs.writeFileSync(`${SHOTS}/provider-matrix.json`, JSON.stringify(trace, null, 1))
} finally {
  await app.close()
  server.close()
}
console.log('\ne2e done, exit', process.exitCode ?? 0)
