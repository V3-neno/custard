// Start building in Settings → Capabilities (provider adapters, Phase 5b):
//   - the button is next to every gap no installed plugin fills, and nowhere
//     else (not next to a filled gap, nor a capability a provider has)
//   - it makes a new plugin, as New plugin does, and opens its workspace in
//     Plugins mode with a starter prompt from the plugin-discovery skill in
//     the message box, not sent
//   - web search for DeepSeek and effort for Haiku 4.5 get different prompts
//   - once the plugin declares `fills`, Refresh shows it filling the gap and
//     it is in the Plugins hub like any other plugin
//   - nothing reaches a provider or a model
// A stand-in this script runs answers every provider address and counts
// every request. Usage, from the repo root after `npx electron-vite build`:
//   node test/e2e/plugin-discovery.mjs <out> <screenshot dir>
// (<out>/plugin a copy of plugin/, <out>/vault a copy of vault-template/.)
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
const CFG = OUT + '/cfg-plugin-discovery'
const VAULT = OUT + '/vault'
const PLUGINS = OUT + '/plugin-discovery'
fs.rmSync(CFG, { recursive: true, force: true })
fs.rmSync(PLUGINS, { recursive: true, force: true })
fs.mkdirSync(PLUGINS, { recursive: true })
fs.cpSync(OUT + '/plugin/spotify', PLUGINS + '/spotify', { recursive: true })

const seen = []
const server = http.createServer((req, res) => {
  seen.push(req.url)
  res.writeHead(500, { 'content-type': 'application/json' })
  res.end('{}')
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

const rec = (id) => w.locator(`[data-recommendation="${id}"]`)
const startButton = (id) => rec(id).locator('button:text-is("Start building")')
const openCapabilities = async () => {
  await w.click('button[title=Settings]')
  await w.click('button[role=tab]:text-is("Capabilities")')
  await w.waitForSelector('[data-recommendation]')
}
const box = () => w.inputValue('textarea')
const manifest = (id) => JSON.parse(fs.readFileSync(`${PLUGINS}/${id}/plugin.json`, 'utf8'))

try {
  step('Setup: a vault and a Claude key')
  await w.click('button[title=Settings]')
  await w.click('button:text-is("Use an existing vault")')
  await w.waitForSelector('text=· connected')
  await w.evaluate(() => window.custard.apiKey.set('claude', 'sk-ant-DISC-1111111111'))
  await w.click('button:text-is("Done")')
  check(
    fs.existsSync(`${VAULT}/Custard/Skills/plugin-discovery/SKILL.md`),
    'the starter vault has the plugin-discovery skill'
  )

  step('Start building is next to every gap with no plugin, and only there')
  await openCapabilities()
  const recs = await w
    .locator('[data-recommendation]')
    .evaluateAll((li) =>
      li.map((l) => [
        l.dataset.recommendation,
        !!l.querySelector('button')?.textContent?.includes('Start building')
      ])
    )
  check(recs.length >= 10, `there are gaps listed (${recs.length})`)
  check(
    recs.every(([, has]) => has),
    `every gap has Start building, fillable or not (${recs.filter(([, h]) => !h).map(([id]) => id)})`
  )
  check(
    recs.some(([id]) => id === 'claude:effort') &&
      recs.some(([id]) => id === 'deepseek:reasoning_summary'),
    'model features (Haiku effort, DeepSeek visible thinking) are buildable too'
  )
  check(!(await rec('claude:web_search').count()), 'nothing for a capability a provider has')
  await w
    .locator('[data-capabilities] section')
    .screenshot({ path: `${SHOTS}/discovery-01-buttons.png` })

  step('Web search for DeepSeek: a new plugin, its workspace, the prompt in the box')
  const before = seen.length
  await startButton('deepseek:web_search').click()
  await w.waitForSelector('text=Workspace · plugin/web-search')
  check(!(await w.locator('[data-capabilities]').count()), 'Settings closed')
  check(true, 'Plugins mode opened the new plugin’s workspace')
  check(fs.existsSync(`${PLUGINS}/web-search/plugin.json`), 'plugin/web-search was made')
  check(manifest('web-search').name === 'Web Search', 'named Web Search, from the skill')
  check(
    JSON.stringify(manifest('web-search').tools.map((t) => t.name)) === '["hello"]',
    'with the usual New plugin sample, nothing special'
  )
  const web = await box()
  check(
    web.startsWith("DeepSeek can't search the web in Custard. Let's build a plugin"),
    `the message box has the web search prompt (${web.slice(0, 70)}…)`
  )
  check(
    /docs\/MANIFEST\.md/.test(web) && /"capability": "web_search"/.test(web),
    'it points at the docs and fills'
  )
  check(seen.length === before, 'nothing was sent')
  await w.screenshot({ path: `${SHOTS}/discovery-02-web-search-workspace.png` })

  step('Effort for Haiku 4.5: a different prompt')
  await openCapabilities()
  await startButton('claude:effort').click()
  await w.waitForSelector('text=Workspace · plugin/effort-helper')
  const effort = await box()
  check(
    effort.startsWith(
      "Haiku 4.5 doesn't take effort levels in Custard (Opus 5.5 and Sonnet 5.5 can)"
    ),
    `the box has the Haiku effort prompt (${effort.slice(0, 70)}…)`
  )
  check(
    /no plugin can add them to the model itself/.test(effort),
    'it says no plugin can add effort to the model'
  )
  check(effort !== web, 'a different prompt from web search')
  check(manifest('effort-helper').name === 'Effort Helper', 'plugin/effort-helper was made')
  await w.screenshot({ path: `${SHOTS}/discovery-03-effort-workspace.png` })

  step('The skill in the vault decides the wording')
  const skill = `${VAULT}/Custard/Skills/plugin-discovery/SKILL.md`
  fs.writeFileSync(
    skill,
    fs
      .readFileSync(skill, 'utf8')
      .replace(
        /## pdf\nPlugin name: PDF Reader\n\n[^\n]+/,
        '## pdf\nPlugin name: My PDF Tool\n\nMy own words: {who} needs PDFs.'
      )
  )
  await openCapabilities()
  await startButton('deepseek:pdf').click()
  await w.waitForSelector('text=Workspace · plugin/my-pdf-tool')
  check(
    (await box()).startsWith('My own words: DeepSeek needs PDFs.'),
    'the edited skill’s prompt is used'
  )

  step('Once it declares fills, Refresh shows it filling the gap')
  // What the workspace chat would write: a search tool and its fills claim.
  const m = manifest('web-search')
  m.tools = [
    {
      name: 'search',
      description: 'Search the web.',
      effect: 'read',
      label: 'Searched the web for {query}',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', maxLength: 200 } },
        required: ['query']
      }
    }
  ]
  m.fills = [{ capability: 'web_search', tool: 'search' }]
  fs.writeFileSync(`${PLUGINS}/web-search/plugin.json`, JSON.stringify(m, null, 2))
  await openCapabilities()
  await w.click('[data-capabilities] button:text-is("Refresh")')
  await w.waitForFunction(() =>
    document
      .querySelector('[data-recommendation="deepseek:web_search"]')
      ?.textContent?.includes('Web Search plugin can fill this gap')
  )
  const filled = await rec('deepseek:web_search').innerText()
  check(
    /The Web Search plugin can fill this gap with its search tool\. Turn it on in Plugins to use it\./.test(
      filled
    ),
    `DeepSeek web search names the new plugin (${filled.split('\n')[0]})`
  )
  check(!(await startButton('deepseek:web_search').count()), 'and no longer offers Start building')
  check(
    (await startButton('deepseek:pdf').count()) === 1,
    'a gap a plugin was started for but that declares nothing still offers it'
  )
  await w
    .locator('[data-capabilities] section')
    .screenshot({ path: `${SHOTS}/discovery-04-filled.png` })
  await w.click('button:text-is("Done")')

  step('In the Plugins hub like any other plugin')
  await w.locator('button[title]:text-is("Plugins")').click()
  await w.locator('article[aria-label="Plugin Spotify"]').waitFor()
  for (const name of ['Web Search', 'Effort Helper', 'My PDF Tool'])
    check(
      (await w.locator(`article[aria-label="Plugin ${name}"]`).count()) === 1,
      `${name} has a card in the hub`
    )

  step('Nothing reached a provider or a model')
  check(seen.length === before && seen.length === 0, `no request (${seen.join(', ')})`)
  check(!errors.length, `no page errors (${errors.join('; ')})`)
} finally {
  await app.close()
  server.close()
}
console.log('\ne2e done, exit', process.exitCode ?? 0)
