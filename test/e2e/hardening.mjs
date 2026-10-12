// Security and data-integrity regressions (hardening pass) in the built app,
// against test/e2e/interrupt-mock.mjs:
//   M1  Plugins-mode file writes, deletes and renames each need approval of
//       the whole change. General Code was removed: a renderer-supplied
//       folder is refused, and an old General Code chat can't send.
//   M2  A Plugins chat with no plugin chosen gets no plugin tools, and a
//       forged call is refused.
//   M5  model-requested notes need approval of their full content, and
//       vault_append is off.
//   L9  approvals show everything, not the first 800 characters.
// Usage, from the repo root after `npx electron-vite build`:
//   node test/e2e/interrupt-mock.mjs <out> &   (with <out>/plugin and <out>/vault as for memory.mjs)
//   node test/e2e/hardening.mjs <out> <screenshot dir>
// Linux only as written, with a display or xvfb-run. Needs the playwright package.
import { _electron as electron } from 'playwright'
import { createRequire } from 'module'
import fs from 'fs'
import path from 'path'

const [, , OUT, SHOTS] = process.argv
const check = (cond, what) => {
  console.log((cond ? '✓ ' : '✕ ') + what)
  if (!cond) process.exitCode = 1
}
const step = (s) => console.log('\n## ' + s)

// Plugins are managed from Plugins mode's start page (the hub), not Settings.
// Opening it closes Settings if open and remembers the mode to come back to.
let backTo = null
const openPlugins = async () => {
  if (await w.locator('h2:text-is("Settings")').count()) await w.click('button:text-is("Done")')
  backTo = (await w.locator('button.molten-fill[title]').first().innerText()).trim()
  await w.click('button[title][class*="rounded-full"]:text-is("Plugins")')
  if (!(await w.locator('text=What Custard can reach').count()))
    await w.click('button[title][class*="rounded-full"]:text-is("Plugins")')
  await w.waitForSelector('text=What Custard can reach')
}
// Closes the plugin's panel and goes back to the mode it was opened from.
const closePlugins = async () => {
  await w.click('[role=dialog] button:text-is("Done")')
  if (backTo && backTo !== 'Plugins') await w.click(`button[title]:text-is("${backTo}")`)
}
const CFG = OUT + '/cfg-hard'
// The plugin M1 creates; its files are seeded once it exists.
const WS = OUT + '/plugin/ws-hard'
const ELSEWHERE = OUT + '/ws-not-chosen'
fs.rmSync(WS, { recursive: true, force: true })
fs.mkdirSync(ELSEWHERE, { recursive: true })

const read = (f, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(OUT + f, 'utf8'))
  } catch {
    return fallback
  }
}
const summaries = () => read('/memory.json', [])
const conversations = () => {
  const dir = `${CFG}/custard/conversations`
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(`${dir}/${f}`, 'utf8')))
}
const until = async (f, ms = 15000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await f()) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}
const vaultFiles = (dir = `${OUT}/vault`) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    return e.isDirectory() ? vaultFiles(p) : [{ p, text: fs.readFileSync(p, 'utf8') }]
  })
const vaultBefore = new Set(vaultFiles().map((f) => f.p))

async function launch() {
  const app = await electron.launch({
    executablePath: createRequire(import.meta.url)('electron'),
    args: [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), '--password-store=basic', '.'],
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:8899',
      XDG_CONFIG_HOME: CFG,
      CUSTARD_PLUGIN_DIR: OUT + '/plugin'
    }
  })
  await app.evaluate(({ safeStorage, dialog, shell }, vault) => {
    safeStorage.setUsePlainTextEncryption?.(true)
    globalThis.__pick = null
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: globalThis.__pick ?? [vault]
    })
    // Confirmations: remember what was asked, answer the second button.
    globalThis.__asked = []
    dialog.showMessageBox = async (...args) => {
      const o = args.at(-1)
      globalThis.__asked.push({ message: o.message, detail: o.detail })
      return { response: 1, checkboxChecked: false }
    }
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
const send = async (t) => {
  await w.fill('textarea', t)
  await w.keyboard.press('Enter')
}
const idle = () => w.waitForSelector('button[title=Send]', { timeout: 30000 })
const card = () => w.locator('[role=alertdialog]')
// Waits for an approval card; null when none comes.
const nextCard = async (ms = 8000) => {
  try {
    await card().first().waitFor({ timeout: ms })
    return card().first()
  } catch {
    return null
  }
}
const answer = async (c, name) => {
  await c.getByRole('button', { name, exact: true }).click()
  await c.waitFor({ state: 'detached', timeout: 10000 }).catch(() => {})
}
const spotifyCalls = () => read('/spotify.json', [])
const newest = () => conversations().sort((a, b) => b.updatedAt - a.updatedAt)[0]
const results = (c) =>
  (c?.messages ?? []).flatMap((m) =>
    Array.isArray(m.content)
      ? m.content.filter((x) => x.type === 'tool_result').map((x) => String(x.content))
      : []
  )

try {
  step('Setup: key, vault, Spotify activated and connected')
  await w.click('button[title=Settings]')
  await w.fill('input[aria-label="Claude API key"]', 'sk-ant-test')
  await w.press('input[aria-label="Claude API key"]', 'Enter')
  await w.click('button:has-text("Use an existing vault")')
  await w.waitForSelector('text=· connected')
  await openPlugins()
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
  await closePlugins()

  step('M1: Plugins-mode file changes each ask, showing the whole change')
  await w.click('button:text-is("Plugins")')
  check(
    (await w.locator('button:text-is("General Code")').count()) === 0,
    'there is no General Code workspace to pick'
  )
  await w.click('button:text-is("New plugin")')
  await w.fill('input[aria-label="Plugin id"]', 'ws-hard')
  await w.fill('input[aria-label="Plugin name"]', 'WS Hard')
  await w.click('button:text-is("Create")')
  check(
    await until(async () => (await w.inputValue('select[aria-label=Plugin]')) === 'ws-hard'),
    'the new plugin is chosen'
  )
  fs.writeFileSync(`${WS}/keep.txt`, 'line one\nline two\n')
  fs.writeFileSync(`${WS}/gone.txt`, 'delete me\n')
  fs.writeFileSync(`${WS}/old.txt`, 'rename me\n')
  await send('fs write test: make some file changes')
  let c = await nextCard()
  check(!!c, 'creating a file asks first')
  if (c) {
    const text = await c.innerText()
    check(text.includes('Create notes/big.txt'), 'the card names the file to create')
    check(
      text.includes('TAIL-MARKER-7731'),
      'the card shows the whole content, past 800 characters'
    )
    check(
      (await c.getByRole('button', { name: 'Allow for this chat', exact: true }).count()) === 0,
      'file changes are approved one at a time ("Allow for this chat" is not offered)'
    )
    await answer(c, "Don't allow")
  }
  check(!fs.existsSync(`${WS}/notes/big.txt`), 'a declined file is not written')
  c = await nextCard()
  if (c) {
    const text = await c.innerText()
    check(
      text.includes('Replace keep.txt') &&
        text.includes('- line two') &&
        text.includes('+ line two changed'),
      'replacing a file shows a line-by-line diff'
    )
    await answer(c, 'Allow')
  } else check(false, 'replacing a file asks first')
  c = await nextCard()
  if (c) {
    check(
      (await c.innerText()).includes('Delete gone.txt'),
      'deleting a file asks first, naming it'
    )
    await answer(c, 'Allow')
  } else check(false, 'deleting a file asks first')
  c = await nextCard()
  if (c) {
    check(
      (await c.innerText()).includes('Rename old.txt to moved/new.txt'),
      'renaming a file asks first, naming both paths'
    )
    await answer(c, 'Allow')
  } else check(false, 'renaming a file asks first')
  await idle()
  check(
    fs.readFileSync(`${WS}/keep.txt`, 'utf8') === 'line one\nline two changed\n',
    'the approved change was written'
  )
  check(!fs.existsSync(`${WS}/gone.txt`), 'the approved delete happened')
  check(fs.existsSync(`${WS}/moved/new.txt`), 'the approved rename happened')

  step('M2: no plugin tools in a Plugins chat with no plugin chosen')
  await w.click('button[title="Plugins history"]')
  await w.click('button:has-text("New plugins chat")')
  await w.selectOption('select[aria-label=Plugin]', '')
  await send('plain question')
  await idle()
  const tools = read('/anthropic.json', []).at(-1)?.tools ?? []
  check(
    tools.length > 0 && !tools.some((t) => t.includes('__')),
    `requests with no plugin chosen offer no plugin tools (${tools.join(',')})`
  )
  const before = spotifyCalls().length
  await send('forged test: call a plugin anyway')
  await idle()
  check(
    !spotifyCalls()
      .slice(before)
      .some((r) => JSON.stringify(r).includes('forged-call-4410')),
    'a plugin call the model makes anyway never reaches the plugin'
  )
  check(
    results(newest()).some((r) => r.includes("isn't available in this chat")),
    'the model is told the tool is not available'
  )

  step('M1: General Code was removed: a folder from the renderer is refused')
  const refused = await w.evaluate(
    (root) =>
      new Promise((resolve) => {
        const requestId = 'forged-root'
        const off = window.custard.chat.onEvent((e) => {
          if (e.requestId !== requestId) return
          if (e.type === 'error' || e.type === 'done') {
            off()
            resolve(e)
          }
        })
        window.custard.chat.send({
          requestId,
          conversationId: null,
          mode: 'code',
          text: 'plain question',
          settings: { model: 'claude-opus-5-5', effort: 'medium' },
          workspace: { kind: 'general', root }
        })
      }),
    ELSEWHERE
  )
  check(
    refused.type === 'error' && /General Code was removed/.test(refused.message),
    `a renderer-supplied folder is refused (${refused.type}: ${refused.message ?? ''})`
  )
  check(
    !conversations().some((x) => x.workspace?.root?.endsWith('ws-not-chosen')),
    'no conversation was made for that folder'
  )

  step('M1: an old General Code chat opens but cannot send')
  const old = {
    ...newest(),
    id: 'old-general-chat',
    workspace: { kind: 'general', root: ELSEWHERE }
  }
  fs.writeFileSync(`${CFG}/custard/conversations/${old.id}.json`, JSON.stringify(old))
  const oldSend = await w.evaluate(
    () =>
      new Promise((resolve) => {
        const requestId = 'old-general'
        const off = window.custard.chat.onEvent((e) => {
          if (e.requestId !== requestId) return
          if (e.type === 'error' || e.type === 'done') {
            off()
            resolve(e)
          }
        })
        window.custard.chat.send({
          requestId,
          conversationId: 'old-general-chat',
          mode: 'code',
          text: 'keep going',
          settings: { model: 'claude-opus-5-5', effort: 'medium' }
        })
      })
  )
  check(
    oldSend.type === 'error' && /read only/.test(oldSend.message),
    `an old General Code chat can't send (${oldSend.type}: ${oldSend.message ?? ''})`
  )

  step('M5: notes the model asks to create need approval of their full content')
  await w.click('button:text-is("Chat")')
  await send('note test: save two notes')
  c = await nextCard()
  check(!!c, 'creating a note asks first')
  // L3: the chat is answering (waiting for approval); deleting it is refused.
  const answering = newest()
  const deleted = await w.evaluate(
    (id) =>
      window.custard.conversations.delete(id).then(
        () => 'deleted',
        (e) => String(e.message ?? e)
      ),
    answering?.id
  )
  check(/still answering/.test(deleted), `deleting a chat while it answers is refused (${deleted})`)
  if (c) {
    const text = await c.innerText()
    check(text.includes('Inbox/Approved.md'), 'the card names the note')
    check(text.includes('NOTE-TAIL-5512'), "the card shows the note's whole content")
    check(
      (await c.getByRole('button', { name: 'Allow for this chat', exact: true }).count()) === 0,
      'notes are approved one at a time'
    )
    await answer(c, 'Allow')
  }
  c = await nextCard()
  check(!!c, 'the second note asks too')
  if (c) await answer(c, "Don't allow")
  await idle()
  check(
    fs.readFileSync(`${OUT}/vault/Inbox/Approved.md`, 'utf8').includes('NOTE-TAIL-5512'),
    'the approved note was created'
  )
  check(!fs.existsSync(`${OUT}/vault/Inbox/Declined.md`), 'the declined note was not')

  step('M5: appending to an existing note is off')
  const prefs = `${OUT}/vault/Areas/README.md`
  const prefsBefore = fs.readFileSync(prefs, 'utf8')
  await send('append test: add a line to my preferences')
  check(!(await nextCard(3000)), 'no approval is offered for an append')
  await idle()
  check(fs.readFileSync(prefs, 'utf8') === prefsBefore, 'the existing note is unchanged')
  check(
    conversations().some((x) => x.id === answering?.id),
    'the chat that was answering still exists afterwards'
  )

  step('L4: an unsent message survives switching mode')
  await w.fill('textarea', 'half-written message 6612')
  await w.click('button:text-is("Design")')
  await w.click('button:text-is("Chat")')
  check(
    (await w.inputValue('textarea')) === 'half-written message 6612',
    'the draft is still there after switching away and back'
  )
  check(
    !(read('/anthropic.json', []).at(-1)?.tools ?? []).includes('vault_append'),
    'vault_append is not offered'
  )
} catch (err) {
  console.log('error:', err.message)
  await w.screenshot({ path: `${SHOTS}/hardening-error.png` }).catch(() => {})
  process.exitCode = 1
} finally {
  await app.close()
}
console.log('\ne2e done, exit', process.exitCode ?? 0)
