// Step 3 (long conversations) in the built app, against test/e2e/interrupt-mock.mjs.
// The mock stands in for a provider: it compacts, counts tokens and rejects a
// request as too long on cue. Nothing here talks to a real provider.
// Usage, from the repo root after `npx electron-vite build`:
//   node test/e2e/interrupt-mock.mjs <out> &   (with <out>/plugin a copy of plugin/
//                                               and <out>/vault a copy of vault-template/)
//   node test/e2e/longchat.mjs <out> <screenshot dir>
// Linux only as written (XDG_CONFIG_HOME isolates the app's data), with a display
// or xvfb-run. Needs the playwright package, which isn't a dependency of this repo.
import { _electron as electron } from 'playwright'
import { createRequire } from 'module'
import fs from 'fs'

const [, , OUT, SHOTS] = process.argv
const check = (cond, what) => {
  console.log((cond ? '✓ ' : '✕ ') + what)
  if (!cond) process.exitCode = 1
}
const step = (s) => console.log('\n## ' + s)
// The mock may be mid-write; a partial file reads as "nothing yet".
const spotifyLog = () => {
  try {
    return JSON.parse(fs.readFileSync(OUT + '/spotify.json', 'utf8'))
  } catch {
    return []
  }
}
const queuePosts = () =>
  spotifyLog().filter((r) => r.path === '/v1/me/player/queue' && r.method === 'POST').length
const until = async (f, ms = 15000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await f()) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}
const conversations = () => {
  const dir = `${OUT}/cfg/custard/conversations`
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(`${dir}/${f}`, 'utf8')))
}

async function launch() {
  const app = await electron.launch({
    executablePath: createRequire(import.meta.url)('electron'),
    args: [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), '--password-store=basic', '.'],
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:8899',
      XDG_CONFIG_HOME: OUT + '/cfg',
      CUSTARD_PLUGIN_DIR: OUT + '/plugin'
    }
  })
  await app.evaluate(({ safeStorage, dialog, shell }, vault) => {
    safeStorage.setUsePlainTextEncryption?.(true)
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [vault] })
    globalThis.__custardPluginTransport = async (req) => {
      const r = await fetch('http://127.0.0.1:8899' + req.url.pathname + req.url.search, {
        method: req.method,
        headers: req.headers,
        body: req.body,
        signal: req.signal
      })
      return { status: r.status, headers: Object.fromEntries(r.headers), body: await r.text() }
    }
    shell.openExternal = async (url) => {
      if (url.startsWith('https://accounts.spotify.com/authorize')) {
        const p = new URL(url).searchParams
        setTimeout(() => fetch(`${p.get('redirect_uri')}?code=CODE&state=${p.get('state')}`), 300)
      }
    }
  }, OUT + '/vault')
  // The app's window, not a plugin's hidden sandbox window.
  let w = null
  for (let i = 0; !w && i < 300; i++) {
    w = app.windows().find((x) => x.url().endsWith('/renderer/index.html')) ?? null
    if (!w) await new Promise((r) => setTimeout(r, 100))
  }
  await w.setViewportSize({ width: 1280, height: 900 })
  w.on('pageerror', (e) => console.log('pageerror:', e.message))
  await w.waitForSelector('text=Custard')
  return { app, w }
}

let { app, w } = await launch()
const shot = (n) => w.screenshot({ path: `${SHOTS}/${n}.png` })
const send = async (t) => {
  await w.fill('textarea', t)
  await w.keyboard.press('Enter')
}
const idle = () => w.waitForSelector('button[title=Send]', { timeout: 30000 })
const card = '[aria-label="Allow plugin action"]'

try {
  step('Setup: key, vault, Spotify activated and connected')
  await w.click('button[title=Settings]')
  await w.fill('input[aria-label="Claude API key"]', 'sk-ant-test')
  await w.press('input[aria-label="Claude API key"]', 'Enter')
  await w.click('button:has-text("Use an existing vault")')
  await w.waitForSelector('text=· connected')
  await w.click('button:text-is("Plugins")')
  await w.click('button:has-text("Spotify")')
  await w.click('button:has-text("Review and activate")')
  await w.waitForSelector('text=New permissions to approve', { timeout: 30000 })
  const boxes = w.locator('section:has-text("New permissions to approve") input[type=checkbox]')
  for (let i = 0; i < (await boxes.count()); i++) await boxes.nth(i).check()
  await w.click('button:text-matches("^Activate [0-9]")')
  await w.waitForSelector('text=Save configuration', { timeout: 30000 })
  await w.fill('input[aria-label="Client ID"]', '0123456789abcdef0123456789abcdef')
  await w.click('button:has-text("Save configuration")')
  await w.click('button:text-is("Connect")')
  await w.waitForSelector('text=· connected', { timeout: 15000 })
  await w.click('button:text-is("Done")')

  const readJson = (f) => {
    try {
      return JSON.parse(fs.readFileSync(`${OUT}/${f}`, 'utf8'))
    } catch {
      return []
    }
  }
  const requests = () => readJson('anthropic.json')
  const chatRequests = () =>
    requests().filter((r) => !(typeof r.system === 'string' && r.system.startsWith('You run one')))
  const length = '[aria-label="Chat length"]'
  const handoffCard = '[aria-label="Continued chat"]'
  const newChat = async () => {
    await w.click('button[title="Chat history"]')
    await w.getByRole('button', { name: 'New chat', exact: true }).click()
  }
  const byTitle = (t) => conversations().find((c) => c.title === t)
  const frozen = (c) =>
    JSON.stringify({
      messages: c.messages,
      actions: c.actions,
      notices: c.notices,
      compactions: c.compactions,
      memory: c.memory
    })

  step('An action whose outcome is unknown')
  await send('stop test')
  await w.waitForSelector(card, { timeout: 30000 })
  await w.click(`${card} button:text-is("Allow for this chat")`)
  check(await until(() => queuePosts() === 1), 'the queue request reached Spotify (no answer)')
  await w.click('button[title=Stop]')
  await idle()
  check(
    Object.values(byTitle('stop test').actions).some((a) => a.status === 'unknown'),
    'the queue call is saved as outcome unknown'
  )

  step('Claude compacts, and the chat keeps every message')
  const before = byTitle('stop test').messages.length
  await send('compact test')
  await w.waitForSelector('text=Summarized and carrying on.', { timeout: 30000 })
  await idle()
  const b1 = readJson('betas.json').at(-1)
  check(
    /compact-2026-01-12/.test(b1.beta ?? '') &&
      b1.context_management?.edits?.[0]?.type === 'compact_20260112' &&
      b1.context_management.edits[0].trigger?.value === 400000,
    'the request asked for compaction at 400,000 input tokens (beta compact-2026-01-12)'
  )
  check(
    /record is right|accepted by a tool/.test(b1.context_management.edits[0].instructions ?? '') ||
      /outcome unknown/i.test(b1.context_management.edits[0].instructions ?? ''),
    'with instructions to keep action outcomes apart'
  )
  const compacted = byTitle('stop test')
  check(
    compacted.compactions?.length === 1 &&
      compacted.compactions[0].provider === 'claude' &&
      compacted.compactions[0].after === before + 1,
    'the compaction point is saved'
  )
  check(compacted.messages.length === before + 2, 'no earlier message was removed')
  check(
    (await w.locator('text=Earlier messages summarized by Claude to make room').count()) === 1,
    'a thin line shows where earlier messages were summarized'
  )
  await shot('step3-01-compacted')

  step('After compaction: the block goes back, with Custard’s own record')
  await send('plain after compaction')
  await w.waitForSelector('text=OK.', { timeout: 30000 })
  await idle()
  const r2 = chatRequests().at(-1)
  check(
    JSON.stringify(r2.messages).includes('"encrypted_content":"enc-1"'),
    'the compaction block is sent back unchanged'
  )
  const sys2 = JSON.stringify(r2.system)
  check(
    sys2.includes('Earlier messages in this chat were summarized') &&
      sys2.includes('OUTCOME UNKNOWN') &&
      sys2.includes('Queue'),
    "the system prompt carries Custard's action record next to the summary"
  )

  step('The provider says the chat is too long')
  const snap = frozen(byTitle('stop test'))
  await send('too long test')
  await w.waitForSelector(`${length}:has-text("too long to go on")`, { timeout: 30000 })
  await idle()
  check(
    (await w.inputValue('textarea')) === 'too long test',
    'nothing happened, so the message is back in the box'
  )
  check(frozen(byTitle('stop test')) === snap, 'the chat itself is unchanged')
  await shot('step3-02-too-long')

  step('Continue in a new chat')
  const countBefore = conversations().length
  await w.click(`${length} button:has-text("Continue in a new chat")`)
  await w.waitForSelector(handoffCard, { timeout: 30000 })
  const h = readJson('handoffs.json').at(-1)
  check(
    h.tools === null && h.format === 'json_schema' && h.model === 'claude-haiku-4-5',
    'the handoff was written by one tool-less call (no tools offered at all)'
  )
  check(h.evidence.length <= 40000, `its input is bounded (${h.evidence.length} characters)`)
  check(
    /OUTCOME UNKNOWN/.test(h.evidence) && !/encrypted|enc-1/.test(h.evidence),
    "it gets Custard's record, not the provider's compaction"
  )
  check(conversations().length === countBefore + 1, 'one new chat was created')
  check(frozen(byTitle('stop test')) === snap, 'the original is unchanged')
  const next = conversations().find((c) => c.continuedFrom)
  check(
    next.continuedFrom.from.id === byTitle('stop test').id &&
      next.continuedFrom.unknown.some((u) => u.name === 'spotify__add_to_queue'),
    'the new chat links to the original and carries the unknown queue call'
  )
  check(next.messages.length === 0, 'it starts with no copied messages')
  check(
    (await w.inputValue('textarea')) === 'too long test',
    'the unsent message is still in the box'
  )
  const cardText = await w.locator(handoffCard).textContent()
  check(
    /Continued from stop test/.test(cardText) &&
      /1 with an unknown outcome/.test(cardText) &&
      /Left out: the earlier messages/.test(cardText),
    'the card says where it came from, what came along and what was left out'
  )
  await w.click(`${handoffCard} button:has-text("What the new chat was given")`)
  await shot('step3-03-continued')

  step('In the new chat, repeating the unknown action still warns')
  await w.fill('textarea', '')
  await send('try again')
  await w.waitForSelector(card, { timeout: 30000 })
  check(
    /outcome is unknown/.test(await w.locator(card).textContent()),
    'the repeat asks with the unknown-outcome warning'
  )
  await w.click(`${card} button:has-text("Don't allow")`)
  await w.waitForSelector('text=I did not queue it again.', { timeout: 30000 })
  await idle()
  check(queuePosts() === 1, 'nothing more was sent to Spotify')
  const sys3 = JSON.stringify(chatRequests().at(-1).system)
  check(
    sys3.includes('This chat continues an earlier chat') &&
      sys3.includes('never authorizes an action') &&
      sys3.includes('Queue Nils Frahm on Spotify'),
    'the model gets the record and the summary, marked as context only'
  )

  step('Searches in the new chat still ask')
  await send('web test: tea')
  await w.waitForSelector(`${card}:has-text("green tea temperature")`, { timeout: 30000 })
  check(
    /a summary of an earlier chat/.test(await w.locator(card).textContent()),
    'the first search asks, naming the summary as the reason'
  )
  await shot('step3-04-search-asks')
  for (let i = 0; i < 6; i++) {
    if (!(await w.locator(card).count())) {
      if (await w.locator('button[title=Send]').count()) break
      await new Promise((r) => setTimeout(r, 500))
      continue
    }
    await w.click(`${card} button:has-text("Don't allow")`)
    await new Promise((r) => setTimeout(r, 500))
  }
  await idle()

  step('The original says where it went on')
  await w.click(`${handoffCard} button:has-text("stop test")`)
  await w.waitForSelector('text=Continued in', { timeout: 15000 })
  check((await w.locator(length).count()) === 0, 'and no longer offers to continue')
  await shot('step3-05-original')

  step('A failed summary leaves only the original')
  await newChat()
  await send('fail test first')
  await w.waitForSelector('text=OK.', { timeout: 30000 })
  await idle()
  await send('too long test')
  await w.waitForSelector(`${length}:has-text("too long to go on")`, { timeout: 30000 })
  await idle()
  const n0 = conversations().length
  const failSnap = frozen(byTitle('fail test first'))
  await w.click(`${length} button:has-text("Continue in a new chat")`)
  await w.waitForSelector('[role=alert]:has-text("Couldn\'t write the summary")', {
    timeout: 60000
  })
  check(conversations().length === n0, 'no chat was created')
  check(frozen(byTitle('fail test first')) === failSnap, 'the original is unchanged')
  await shot('step3-06-summary-failed')
  await w.click('[role=alert] button:has-text("Continue without a summary")')
  await w.waitForSelector(handoffCard, { timeout: 30000 })
  check(
    /No summary was written/.test(await w.locator(handoffCard).textContent()),
    'continuing without a summary says so'
  )

  step('Checked before sending: a chat that would be too long is never sent')
  await newChat()
  await send('plain hello')
  await w.waitForSelector('text=OK.', { timeout: 30000 })
  await idle()
  const sent = requests().length
  const big = 'over test ' + 'x'.repeat(1_400_000)
  await w.fill('textarea', big)
  await w.keyboard.press('Enter')
  await w.waitForSelector(`${length}:has-text("too long to go on")`, { timeout: 60000 })
  await idle()
  check(requests().length === sent, 'no request was sent to the model')
  const c1 = readJson('counts.json').at(-1)
  check(
    c1.over && /compact-2026-01-12/.test(c1.betas ?? '') && c1.context_management && c1.tools > 0,
    'the provider counted the full request (system, tools, betas, compaction)'
  )
  check((await w.inputValue('textarea')).length === big.length, 'the message is back in the box')

  step('Near the limit, the chat says so')
  await newChat()
  await send('plain start')
  await w.waitForSelector('text=OK.', { timeout: 30000 })
  await idle()
  await w.fill('textarea', 'near test ' + 'y'.repeat(1_400_000))
  await w.keyboard.press('Enter')
  await w.waitForSelector(`${length}:has-text("getting long")`, { timeout: 60000 })
  await idle()
  const nearText = await w.locator(length).textContent()
  check(
    /about 79% of what Opus 5.5 can take in \(counted by Claude\)/.test(nearText),
    `the counted share is shown (${nearText.trim().slice(0, 80)})`
  )
  await shot('step3-07-near-limit')

  // Last: after this, compaction stays off for Opus for the rest of the session.
  step('A model that rejects compaction: one retry without it, checked again first')
  await newChat()
  await send('plain warmup')
  await w.waitForSelector('text=OK.', { timeout: 30000 })
  await idle()
  const countsBefore = readJson('counts.json').length
  const betasBefore = readJson('betas.json').length
  await w.fill('textarea', 'unsupported test ' + 'z'.repeat(1_400_000))
  await w.keyboard.press('Enter')
  await w.waitForSelector('text=Answered without compaction.', { timeout: 60000 })
  await idle()
  const tries = readJson('betas.json').slice(betasBefore)
  check(
    tries.length === 2 && tries[0].context_management && !tries[1].context_management,
    'the rejected request asked for compaction; the one retry did not'
  )
  check(
    !/compact-2026-01-12/.test(tries[1].beta ?? ''),
    'and dropped the compaction beta header'
  )
  check(
    readJson('counts.json').length - countsBefore === 2,
    'the replacement request was counted against the budget before it was sent'
  )
} catch (e) {
  await shot('step3-fail').catch(() => {})
  console.log(e)
  process.exitCode = 1
}
await app.close().catch(() => {})
console.log('\ne2e done, exit', process.exitCode ?? 0)
