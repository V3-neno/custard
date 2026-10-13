// Settings → Capabilities in the built app (provider adapters, Phase 4):
//   - the matrix shows each provider's capabilities from Custard's own rules,
//     with supported, not supported and unknown in their own colours and a
//     docs or live tag on every cell
//   - By model shows which DeepSeek model was tested live, and a model the
//     provider lists that Custard doesn't support yet as unknown
//   - recommendations name an installed plugin only when it declares the gap
//     (and never turn it on), and otherwise say no plugin is available yet
//   - the inventory lists the vault tools, plugin tools, skills and features
//   - opening the tab and Refresh ask no provider and no model, with three
//     keys saved; Refresh picks up a skill added since
// A stand-in this script runs answers every provider address, and counts
// every request. Usage, from the repo root after `npx electron-vite build`:
//   node test/e2e/capabilities.mjs <out> <screenshot dir>
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
const CFG = OUT + '/cfg-capabilities'
const VAULT = OUT + '/vault'
const PLUGINS = OUT + '/plugin-cap'
fs.rmSync(CFG, { recursive: true, force: true })
fs.rmSync(PLUGINS, { recursive: true, force: true })
fs.mkdirSync(PLUGINS, { recursive: true })
fs.cpSync(OUT + '/plugin/spotify', PLUGINS + '/spotify', { recursive: true })

// A plugin that says its `find` tool fills web search. Installed, not
// activated: the scan may recommend it and must leave it off.
fs.mkdirSync(PLUGINS + '/web-finder/src', { recursive: true })
fs.writeFileSync(
  PLUGINS + '/web-finder/plugin.json',
  JSON.stringify(
    {
      manifestVersion: 1,
      id: 'web-finder',
      name: 'Web Finder',
      description: 'Searches the web for a query.',
      version: '0.1.0',
      apiVersion: 1,
      entry: 'src/index.ts',
      permissions: { network: ['google.serper.dev'], openExternal: [], storage: false },
      config: {},
      tools: [
        {
          name: 'find',
          description: 'Search the web.',
          effect: 'read',
          label: 'Searched the web for {query}',
          inputSchema: {
            type: 'object',
            properties: { query: { type: 'string', maxLength: 200 } },
            required: ['query']
          }
        }
      ],
      fills: [{ capability: 'web_search', tool: 'find' }]
    },
    null,
    2
  )
)
fs.writeFileSync(
  PLUGINS + '/web-finder/src/index.ts',
  "import { definePlugin } from 'custard-plugin-sdk'\nexport default definePlugin({ tools: { find: () => 'none' } })\n"
)

const KEYS = {
  claude: 'sk-ant-CAP-1111111111',
  openai: 'sk-oa-CAP-2222222222',
  deepseek: 'sk-ds-CAP-3333333333'
}
const seen = []
const server = http.createServer((req, res) => {
  seen.push(req.url)
  res.writeHead(200, { 'content-type': 'application/json' })
  if (req.url === '/deepseek/models')
    return res.end(
      JSON.stringify({
        object: 'list',
        data: [
          { id: 'deepseek-flash', object: 'model', name: 'DeepSeek Flash' },
          { id: 'deepseek-v4-pro', object: 'model', name: 'DeepSeek V4 Pro' },
          { id: 'deepseek-v5-preview', object: 'model', name: 'DeepSeek V5 Preview' }
        ]
      })
    )
  res.end('{}')
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`

let output = ''
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
app.process().stdout?.on('data', (d) => (output += d))
app.process().stderr?.on('data', (d) => (output += d))
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

const cell = (id) => w.locator(`[data-cell="${id}"]`)
const stateOf = (id) => cell(id).getAttribute('data-state')
const evidenceOf = (id) => cell(id).getAttribute('data-evidence')
const openTab = async () => {
  await w.click('button[role=tab]:text-is("Capabilities")')
  await w.waitForSelector('[data-matrix]')
}
// The whole dialog in one picture: a window tall enough that it doesn't scroll.
const shot = async (name) => {
  await w.setViewportSize({ width: 1280, height: 2400 })
  await w
    .locator('[data-capabilities]')
    .locator('xpath=..')
    .screenshot({ path: `${SHOTS}/${name}.png` })
  await w.setViewportSize({ width: 1280, height: 1000 })
}

// What Custard's rules say today (capabilities.ts), per provider. A provider
// is supported when any of its models is.
const S = 'supported'
const N = 'unsupported'
const EXPECTED = {
  claude: {
    text: S,
    streaming: S,
    tool_use: S,
    json_schema: S,
    vision: S,
    pdf: S,
    reasoning: S,
    reasoning_summary: S,
    effort: S,
    web_search: S,
    prompt_caching: S,
    compaction: S,
    token_counting: S,
    fallbacks: S
  },
  openai: {
    text: S,
    streaming: S,
    tool_use: S,
    json_schema: S,
    vision: S,
    pdf: S,
    reasoning: S,
    reasoning_summary: S,
    effort: S,
    web_search: S,
    prompt_caching: S,
    compaction: S,
    token_counting: S,
    fallbacks: N
  },
  deepseek: {
    text: S,
    streaming: S,
    tool_use: S,
    json_schema: S,
    vision: S,
    pdf: N,
    reasoning: S,
    reasoning_summary: N,
    effort: S,
    web_search: N,
    prompt_caching: S,
    compaction: N,
    token_counting: N,
    fallbacks: N
  }
}

try {
  step('Setup: vault, three keys, one DeepSeek key check')
  await w.click('button[title=Settings]')
  await w.click('button:text-is("Use an existing vault")')
  await w.waitForSelector('text=· connected')
  await w.evaluate(async (keys) => {
    for (const [p, k] of Object.entries(keys)) await window.custard.apiKey.set(p, k)
  }, KEYS)
  // The one request in this run: Refresh in DeepSeek's key section, so the
  // last check lists a model Custard doesn't support yet.
  await w.click('button:text-is("Done")')
  await w.click('button[title=Settings]')
  await w.locator('[data-provider-key=deepseek] button:text-is("Refresh")').click()
  await w.waitForSelector('[data-provider-key=deepseek] [data-unsupported]')
  check(
    seen.length === 1 && seen[0] === '/deepseek/models',
    `the key check was the only request (${seen.join(', ')})`
  )
  seen.length = 0

  step('The matrix, by provider, from Custard’s rules')
  await openTab()
  const providers = await w
    .locator('[data-matrix=provider] thead th')
    .evaluateAll((ths) => ths.slice(1).map((t) => t.textContent))
  check(
    JSON.stringify(providers) === JSON.stringify(['Claude', 'OpenAI', 'DeepSeek']),
    `columns are the three providers (${providers.join(', ')})`
  )
  for (const [p, row] of Object.entries(EXPECTED)) {
    const wrong = []
    for (const [c, want] of Object.entries(row)) {
      const got = await stateOf(`${p}:${c}`)
      if (got !== want) wrong.push(`${c}: ${got}`)
    }
    check(!wrong.length, `${p}: every cell matches the rules${wrong.length ? ` (${wrong})` : ''}`)
  }
  const rows = await w.locator('[data-matrix] tbody tr').count()
  check(rows === 14, `one row per capability (${rows})`)

  step('Colours and tags')
  const bg = async (id) =>
    cell(id)
      .locator('span')
      .first()
      .evaluate((e) => getComputedStyle(e).backgroundColor)
  const green = await bg('claude:vision')
  const red = await bg('deepseek:pdf')
  check(green !== red, `supported and not supported have different colours (${green} / ${red})`)
  const [r, g] = green.match(/\d+/g).map(Number)
  check(g > r, `supported is green (${green})`)
  const tags = await w
    .locator('[data-matrix] [data-cell]')
    .evaluateAll((cs) =>
      cs.every(
        (c) => ['docs', 'live'].includes(c.dataset.evidence) && /docs|live/i.test(c.innerText)
      )
    )
  check(tags, 'every cell shows a docs or live tag')
  check(
    (await evidenceOf('deepseek:vision')) === 'live' &&
      (await evidenceOf('claude:vision')) === 'docs' &&
      (await evidenceOf('openai:vision')) === 'docs',
    'images in: live for DeepSeek, docs for Claude and OpenAI'
  )
  const ds = await cell('deepseek:vision').innerText()
  check(
    /DeepSeek Flash only/.test(ds),
    `DeepSeek images in says Flash only (${ds.replace(/\n/g, ' ')})`
  )
  const js = await cell('deepseek:json_schema').innerText()
  check(
    (await evidenceOf('deepseek:json_schema')) === 'docs' && /live on DeepSeek Flash/.test(js),
    'structured output: docs for DeepSeek as a whole, naming Flash as tested live'
  )
  await shot('cap-01-by-provider')

  step('By model: the tested model, and the one Custard doesn’t support yet')
  await w.click('button:text-is("By model")')
  await w.waitForSelector('[data-matrix=model]')
  check(
    (await evidenceOf('deepseek-flash:vision')) === 'live' &&
      (await stateOf('deepseek-v4-pro:vision')) === 'unsupported',
    'Flash images in is live; V4 Pro has none'
  )
  check(
    (await evidenceOf('deepseek-flash:text')) === 'docs',
    'Flash text stays docs (the tool-call chat’s model was not recorded)'
  )
  const v5 = await w
    .locator('[data-cell^="deepseek-v5-preview:"]')
    .evaluateAll((cs) => cs.map((c) => c.dataset.state))
  check(
    v5.length === 14 && v5.every((s) => s === 'unknown'),
    `DeepSeek V5 Preview is unknown in every row (${v5.length})`
  )
  const grey = await cell('deepseek-v5-preview:text')
    .locator('span')
    .first()
    .evaluate((e) => getComputedStyle(e).backgroundColor)
  check(grey !== green && grey !== red, `unknown has its own colour (${grey})`)
  await shot('cap-02-by-model')
  await w.click('button:text-is("By provider")')

  step('Recommendations')
  const rec = (id) => w.locator(`[data-recommendation="${id}"]`).innerText()
  const web = await rec('deepseek:web_search')
  check(
    /DeepSeek lacks web search\. The Web Finder plugin can fill this gap with its find tool\. Turn it on in Plugins/.test(
      web
    ),
    `web search names the installed plugin that fills it (${web.split('\n')[0]})`
  )
  const pdf = await rec('deepseek:pdf')
  check(
    /DeepSeek lacks PDF input\. No plugin available yet/.test(pdf),
    `PDFs: no plugin yet (${pdf.split('\n')[0]})`
  )
  const vis = await rec('deepseek:vision')
  check(
    /DeepSeek V4 Pro lacks image input \(DeepSeek Flash has it\)\. No plugin available yet/.test(
      vis
    ),
    `images: V4 Pro only, no plugin yet (${vis.split('\n')[0]})`
  )
  check(
    /No plugin can add this/.test(await rec('openai:fallbacks')),
    'a model feature (fallbacks) says no plugin can add it'
  )
  check(
    !(await w.locator('[data-recommendation="claude:web_search"]').count()),
    'nothing is recommended for what a provider already has'
  )
  const plugin = await w.evaluate(() => window.custard.plugins.status('web-finder'))
  check(
    plugin.state === 'not-activated',
    `the recommended plugin was not turned on (${plugin.state})`
  )
  await shot('cap-03-recommendations')

  step('Inventory')
  await w.click('[data-inventory] summary')
  const ids = await w.locator('[data-item]').evaluateAll((li) => li.map((l) => l.dataset.item))
  for (const t of ['vault_read', 'vault_search', 'vault_create_note', 'vault_list'])
    check(ids.includes(`vault:${t}`), `lists ${t}`)
  check(ids.includes('chats:chats_search'), 'lists the earlier-chat tools')
  check(ids.includes('web:web_search') && ids.includes('web:web_read'), 'lists the web tools')
  check(
    ids.includes('plugin:spotify__search') && ids.includes('plugin:web-finder__find'),
    'lists installed plugins’ tools (Spotify and Web Finder)'
  )
  const skills = fs.readdirSync(VAULT + '/Custard/Skills')
  check(
    skills.every((s) => ids.includes(`skill:${s}`)),
    `lists every skill in the vault (${skills.length})`
  )
  const recall = await w.locator('[data-item="skill:chat-recall"]').innerText()
  check(/uses .*chats_search/.test(recall), `a skill shows the tools it uses (${recall})`)
  check(
    ids.includes('feature:continue') && ids.includes('feature:chat-notes'),
    'lists features such as Continue (handoff) and chat notes'
  )
  await shot('cap-04-inventory')

  step('Refresh re-scans, locally')
  const before = await w.locator('[data-scanned]').innerText()
  fs.mkdirSync(VAULT + '/Custard/Skills/web-digest')
  fs.writeFileSync(
    VAULT + '/Custard/Skills/web-digest/SKILL.md',
    '---\nname: web-digest\ndescription: Sum up the news with web_search.\n---\nUse web_search, then vault_create_note.\n'
  )
  await new Promise((r) => setTimeout(r, 1100))
  await w.click('[data-capabilities] button:text-is("Refresh")')
  await w.waitForFunction(
    (b) => document.querySelector('[data-scanned]')?.textContent !== b,
    before,
    { timeout: 10000 }
  )
  check(true, 'Refresh finished and updated the scan time')
  const digest = await w.locator('[data-item="skill:web-digest"]').innerText()
  check(/uses .*web_search/.test(digest), `a skill added since shows up after Refresh (${digest})`)
  check(
    !(await w.locator('[data-capabilities] .text-ember-600').filter({ hasText: 'Error' }).count()),
    'no error shown'
  )
  await w.click('[data-capabilities] button:text-is("Refresh")')
  await w.waitForSelector('[data-capabilities] button:text-is("Refresh"):not([disabled])')

  step('Without the plugin that declares it, every fillable gap says no plugin yet')
  fs.rmSync(PLUGINS + '/web-finder', { recursive: true, force: true })
  const scanned = await w.locator('[data-scanned]').innerText()
  await new Promise((r) => setTimeout(r, 1100))
  await w.click('[data-capabilities] button:text-is("Refresh")')
  await w.waitForFunction(
    (b) => document.querySelector('[data-scanned]')?.textContent !== b,
    scanned,
    { timeout: 10000 }
  )
  const gaps = await w
    .locator('[data-recommendation]')
    .evaluateAll((li) => li.map((l) => [l.dataset.recommendation, l.innerText.split('\n')[0]]))
  const fillable = gaps.filter(([id]) => /:(web_search|pdf|vision)$/.test(id))
  check(
    fillable.length === 3 &&
      fillable.every(([, t]) => /No plugin available yet\. One could be built with /.test(t)),
    `web search, PDFs and images each say no plugin available yet (${fillable.map(([id]) => id).join(', ')})`
  )
  check(
    /DeepSeek lacks web search\. No plugin available yet\. One could be built with a web search tool \(a Serper or Brave Search plugin, say\)\./.test(
      await rec('deepseek:web_search')
    ),
    'DeepSeek web search no longer names Web Finder'
  )
  check(
    gaps
      .filter(([id]) => !/:(web_search|pdf|vision)$/.test(id))
      .every(([, t]) => /No plugin can add this: it is part of the model\.$/.test(t)),
    'every other gap says no plugin can add it'
  )
  check(
    !(await w.locator('[data-item^="plugin:web-finder"]').count()),
    'Web Finder is gone from the inventory'
  )

  step('No provider or model was asked')
  await new Promise((r) => setTimeout(r, 1000))
  check(seen.length === 0, `no request while the tab was open or on Refresh (${seen.join(', ')})`)
  check(!errors.length, `no page errors (${errors.join('; ')})`)
  check(!Object.values(KEYS).some((k) => output.includes(k)), "no key appears in the app's output")
  await w.click('button:text-is("Done")')
} finally {
  await app.close()
  server.close()
}
console.log('\ne2e done, exit', process.exitCode ?? 0)
