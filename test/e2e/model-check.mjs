// Key checks and model discovery in the built app (provider adapters,
// Phase 3), against a stand-in for each provider's model list that this
// script runs itself (no request reaches a real provider):
//   - opening the app makes no provider request, with or without saved keys
//   - Save checks the key with its own provider only: a wrong key says so and
//     stays saved; a good key lists which models it can use
//   - a model DeepSeek lists that Custard doesn't know is shown in Settings as
//     "not yet supported" and never appears in the model picker
//   - a failed check (the connection drops) says it couldn't check and leaves
//     the saved key alone; "last checked" survives a restart
//   - Claude's and OpenAI's checks go to their own addresses with their own keys
//   - no key appears in the window's text or the app's output
// Usage, from the repo root after `npx electron-vite build`:
//   node test/e2e/model-check.mjs <out> <screenshot dir>
// Linux only as written, with a display or xvfb-run. Needs the playwright package.
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
const CFG = OUT + '/cfg-model-check'
fs.rmSync(CFG, { recursive: true, force: true })

const KEYS = {
  deepseekWrong: 'sk-ds-WRONG-0000000000',
  deepseek: 'sk-ds-GOOD-1111111111',
  claude: 'sk-ant-GOOD-2222222222',
  openai: 'sk-oa-GOOD-3333333333'
}
let drop = false
const seen = []
const server = http.createServer((req, res) => {
  const auth = req.headers.authorization ?? null
  const xkey = req.headers['x-api-key'] ?? null
  seen.push({ path: req.url, auth, xkey })
  if (drop) return req.socket.destroy()
  const json = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (req.url === '/deepseek/models') {
    if (auth !== `Bearer ${KEYS.deepseek}`)
      return json(401, {
        error: {
          message: 'Authentication Fails, Your api key is invalid',
          type: 'authentication_error'
        }
      })
    return json(200, {
      object: 'list',
      data: [
        { id: 'deepseek-flash', object: 'model', owned_by: 'deepseek', name: 'DeepSeek Flash' },
        { id: 'deepseek-v4-pro', object: 'model', owned_by: 'deepseek', name: 'DeepSeek V4 Pro' },
        {
          id: 'deepseek-v5-preview',
          object: 'model',
          owned_by: 'deepseek',
          name: 'DeepSeek V5 Preview',
          context_window: 2000000
        }
      ]
    })
  }
  if (req.url.startsWith('/anthropic/v1/models') && xkey === KEYS.claude)
    return json(200, {
      data: [{ type: 'model', id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5' }],
      has_more: false
    })
  if (req.url === '/openai/v1/models' && auth === `Bearer ${KEYS.openai}`)
    return json(200, { object: 'list', data: [{ id: 'gpt-6-luna' }, { id: 'gpt-6-astra' }] })
  json(401, { error: { message: 'no' } })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`

let output = ''
async function launch() {
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
  app.process().stdout?.on('data', (d) => (output += d))
  app.process().stderr?.on('data', (d) => (output += d))
  await app.evaluate(({ safeStorage }) => safeStorage.setUsePlainTextEncryption?.(true))
  let w = null
  for (let i = 0; !w && i < 300; i++) {
    w = app.windows().find((x) => x.url().endsWith('/renderer/index.html')) ?? null
    if (!w) await new Promise((r) => setTimeout(r, 100))
  }
  await w.setViewportSize({ width: 1280, height: 900 })
  w.on('pageerror', (e) => console.log('pageerror:', e.message))
  w.on('console', (m) => (output += m.text() + '\n'))
  await w.waitForSelector('text=Custard')
  return { app, w }
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
const section = (w, p) => w.locator(`[data-provider-key=${p}]`)
const status = (w, p) => section(w, p).locator('[data-check-status]').innerText()
const saveKey = async (w, p, label, key) => {
  await w.fill(`input[aria-label="${label} API key"]`, key)
  await w.press(`input[aria-label="${label} API key"]`, 'Enter')
  await w.waitForFunction(
    (p) => {
      const s = document.querySelector(`[data-provider-key=${p}] [data-check-status]`)
      return s && !s.textContent.startsWith('Checking')
    },
    p,
    { timeout: 30000 }
  )
}
const noKeysIn = (text, where) =>
  check(!Object.values(KEYS).some((k) => text.includes(k)), `no key appears in ${where}`)

let { app, w } = await launch()
try {
  step('Opening the app asks no provider anything')
  await pause(3000)
  check(seen.length === 0, `no request at startup (${seen.length})`)

  step('A wrong DeepSeek key says so and stays saved')
  await w.click('button[title=Settings]')
  await saveKey(w, 'deepseek', 'DeepSeek', KEYS.deepseekWrong)
  const wrong = await status(w, 'deepseek')
  check(/DeepSeek rejected this key/.test(wrong), `the check says the key was rejected (${wrong})`)
  check(await section(w, 'deepseek').locator('text=· saved').isVisible(), 'the key is still saved')
  check(
    seen.length === 1 && seen[0].path === '/deepseek/models',
    `one request, to DeepSeek's model list (${seen.map((s) => s.path).join(', ')})`
  )
  await section(w, 'deepseek').screenshot({ path: `${SHOTS}/check-01-rejected.png` })

  step('A good DeepSeek key lists its models, with the unsupported one apart')
  await saveKey(w, 'deepseek', 'DeepSeek', KEYS.deepseek)
  const good = await status(w, 'deepseek')
  check(/^Checked .*: the key works\.$/.test(good), `the check says the key works (${good})`)
  const models = await section(w, 'deepseek').locator('[data-check-models]').innerText()
  check(
    models.includes('DeepSeek V4 Pro') && models.includes('DeepSeek Flash'),
    'Settings lists the known DeepSeek models'
  )
  check(
    /Not yet supported: DeepSeek V5 Preview/.test(models),
    'and DeepSeek V5 Preview as not yet supported'
  )
  check(/can.t be picked/.test(models), 'saying why it can’t be picked')
  check(
    seen.at(-1).auth === `Bearer ${KEYS.deepseek}`,
    'the check sent the DeepSeek key as a Bearer token'
  )
  await section(w, 'deepseek').screenshot({ path: `${SHOTS}/check-02-works.png` })
  await w.screenshot({ path: `${SHOTS}/check-02b-settings.png` })

  step('Claude and OpenAI check against their own addresses')
  const before = seen.length
  await saveKey(w, 'claude', 'Claude', KEYS.claude)
  await saveKey(w, 'openai', 'OpenAI', KEYS.openai)
  const mine = seen.slice(before)
  check(
    mine.length === 2 &&
      mine[0].path.startsWith('/anthropic/v1/models') &&
      mine[0].xkey === KEYS.claude &&
      mine[0].auth === null &&
      mine[1].path === '/openai/v1/models' &&
      mine[1].auth === `Bearer ${KEYS.openai}`,
    `each key went only to its own provider (${JSON.stringify(mine.map((m) => m.path))})`
  )
  const claudeModels = await section(w, 'claude').locator('[data-check-models]').innerText()
  check(
    /Sonnet 5\.5 \(not available to this key\)/.test(claudeModels) &&
      !/Not yet supported/.test(claudeModels),
    'Claude marks a model its key can’t use, and lists nothing extra'
  )
  check(
    !(await section(w, 'openai').locator('[data-unsupported]').count()),
    'OpenAI lists nothing extra either'
  )
  check(
    seen.every(
      (s) =>
        (s.path.startsWith('/deepseek/') &&
          [`Bearer ${KEYS.deepseek}`, `Bearer ${KEYS.deepseekWrong}`].includes(s.auth)) ||
        (s.path.startsWith('/anthropic/') && s.xkey === KEYS.claude) ||
        (s.path.startsWith('/openai/') && s.auth === `Bearer ${KEYS.openai}`)
    ),
    'no key was ever sent to another provider'
  )

  step('A dropped connection: couldn’t check, key kept')
  drop = true
  await section(w, 'deepseek').locator('button:text-is("Refresh")').click()
  await w.waitForFunction(
    () =>
      !document
        .querySelector('[data-provider-key=deepseek] [data-check-status]')
        .textContent.startsWith('Checking'),
    null,
    { timeout: 30000 }
  )
  const failed = await status(w, 'deepseek')
  check(
    /^Couldn't check at .*Your saved key wasn't changed\.$/.test(failed),
    `it says it couldn't check and the key is unchanged (${failed})`
  )
  check(await section(w, 'deepseek').locator('text=· saved').isVisible(), 'the key is still saved')
  drop = false
  await section(w, 'deepseek').screenshot({ path: `${SHOTS}/check-03-unreachable.png` })
  noKeysIn(await w.locator('body').innerText(), 'the Settings text')
  await w.click('button:text-is("Done")')

  step('The picker shows only known models')
  const ds = await w.locator('select[title=Model] optgroup[label=DeepSeek] option').allInnerTexts()
  check(
    JSON.stringify(ds) === JSON.stringify(['DeepSeek V4 Pro', 'DeepSeek Flash']),
    `DeepSeek's picker group is the known models (${ds.join(', ')})`
  )
  const all = await w.locator('select[title=Model] option').allInnerTexts()
  check(!all.some((o) => /V5/.test(o)), 'the unsupported model is not in the picker')
  const groups = await w
    .locator('select[title=Model] optgroup')
    .evaluateAll((gs) => gs.map((g) => g.label))
  check(
    JSON.stringify(groups) === JSON.stringify(['Claude', 'OpenAI', 'DeepSeek']) && all.length === 8,
    `the picker has the same 8 models from all three providers (${groups.join(', ')})`
  )

  step('After a restart: no requests, and the last check is kept')
  await app.close()
  const n = seen.length
  ;({ app, w } = await launch())
  await pause(3000)
  check(seen.length === n, `no request at startup with three saved keys (${seen.length - n})`)
  await w.click('button[title=Settings]')
  const kept = await status(w, 'deepseek')
  check(/^Couldn't check at /.test(kept), `"last checked" survived the restart (${kept})`)
  check(/^Checked .*: the key works\.$/.test(await status(w, 'claude')), 'and Claude’s too')
  noKeysIn(await w.locator('body').innerText(), 'the Settings text after restart')
  await w.click('button:text-is("Done")')
} finally {
  await app.close()
  server.close()
}
noKeysIn(output, "the app's output and console")
console.log('\ne2e done, exit', process.exitCode ?? 0)
