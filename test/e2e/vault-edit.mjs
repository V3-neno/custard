// Editable folders: Claude changes notes without a card only inside folders
// the user allowed in Settings, and everything else stays as it was.
// Against test/e2e/interrupt-mock.mjs; usage as for hardening.mjs:
//   node test/e2e/vault-edit.mjs <out> <screenshot dir>
// Linux only as written, with a display or xvfb-run. Needs the playwright package.
import { _electron as electron } from 'playwright'
import { createRequire } from 'module'
import fs from 'fs'

const [, , OUT, SHOTS] = process.argv
const check = (cond, what) => {
  console.log((cond ? '✓ ' : '✕ ') + what)
  if (!cond) process.exitCode = 1
}
const step = (s) => console.log('\n## ' + s)
const CFG = OUT + '/cfg-vedit'
const V = OUT + '/vault'
const file = (p) => fs.readFileSync(`${V}/${p}`, 'utf8')
const put = (p, text) => {
  fs.mkdirSync(`${V}/${p.split('/').slice(0, -1).join('/')}`, { recursive: true })
  fs.writeFileSync(`${V}/${p}`, text)
}
put(
  'Notes/Plan.md',
  '---\ntags: [plan]\n---\n# Plan\n\nThe draft is here.\n\n## Log\n- start\n\n## Later\nx\n'
)
put('Journal/Log.md', '# Log\n- first\n')
put('Custard/Captures/Old.md', 'old capture\n')

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
await app.evaluate(({ safeStorage, dialog }, vault) => {
  safeStorage.setUsePlainTextEncryption?.(true)
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [vault] })
}, V)
let w = null
for (let i = 0; !w && i < 300; i++) {
  w = app.windows().find((x) => x.url().endsWith('/renderer/index.html')) ?? null
  if (!w) await new Promise((r) => setTimeout(r, 100))
}
await w.setViewportSize({ width: 1280, height: 900 })
w.on('pageerror', (e) => console.log('pageerror:', e.message))
await w.waitForSelector('text=Custard')

const send = async (t) => {
  await w.fill('textarea', t)
  await w.keyboard.press('Enter')
}
const idle = () => w.waitForSelector('button[title=Send]', { timeout: 30000 })
const card = () => w.locator('[role=alertdialog]')
const nextCard = async (ms = 4000) => {
  try {
    await card().first().waitFor({ timeout: ms })
    return card().first()
  } catch {
    return null
  }
}
const convDir = `${CFG}/custard/conversations`
const results = () =>
  fs
    .readdirSync(convDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(`${convDir}/${f}`, 'utf8')))
    .flatMap((c) => c.messages)
    .flatMap((m) =>
      Array.isArray(m.content)
        ? m.content.filter((x) => x.type === 'tool_result').map((x) => String(x.content))
        : []
    )
const openSettings = async () => {
  await w.click('button[title=Settings]')
  await w.waitForSelector('text=Obsidian vault')
}
const closeSettings = () => w.click('button:text-is("Done")')
const allow = async (folder, mode) => {
  await w.fill('input[aria-label="Folder to allow"]', folder)
  await w.selectOption('select[aria-label="What Claude may do there"]', mode)
  await w.click('button:text-is("Allow")')
  await w.waitForSelector(`ul[aria-label="Editable folders"] >> text=${folder}/`)
}

try {
  step('Setup: key, vault, nothing allowed yet')
  await w.click('button[title=Settings]')
  await w.fill('input[aria-label="Claude API key"]', 'sk-ant-test')
  await w.press('input[aria-label="Claude API key"]', 'Enter')
  await w.click('button:text-is("Use an existing vault")')
  await w.waitForSelector('text=· connected')
  await w.waitForSelector('text=Editable folders')
  check(
    (await w.locator('ul[aria-label="Editable folders"]').count()) === 0,
    'no folder is allowed by default'
  )
  await closeSettings()

  step('Nothing allowed: an existing note cannot be changed')
  await send('vgrant append')
  await idle()
  check(!(await card().count()), 'no approval card for an append')
  check(!file('Journal/Log.md').includes('APPENDED-LINE-7731'), 'the note is unchanged')

  step('Allow folders in Settings')
  await openSettings()
  await allow('Notes', 'edit')
  await allow('Journal', 'append')
  await allow('Custard', 'edit')
  await w.fill('input[aria-label="Folder to allow"]', '../outside')
  await w.click('button:text-is("Allow")')
  await w
    .locator("text=That folder can't be allowed")
    .waitFor({ timeout: 5000 })
    .catch(() => {})
  check(
    await w.locator("text=That folder can't be allowed").isVisible(),
    'a folder outside the vault is refused'
  )
  await w.screenshot({ path: SHOTS + '/vault-edit-settings.png' })
  await closeSettings()

  step('Inside a granted folder: no card')
  await send('vgrant create')
  await idle()
  check(!(await card().count()), 'a new note in an allowed folder needs no card')
  check(file('Notes/Made.md') === 'MADE-BY-CLAUDE\n', 'the note was created')
  await send('vgrant append')
  await idle()
  check(file('Journal/Log.md') === '# Log\n- first\nAPPENDED-LINE-7731\n', 'append adds to the end')
  await send('vgrant edit')
  await idle()
  check(
    file('Notes/Plan.md') ===
      '---\ntags: [plan]\n---\n# Plan\n\nThe final is here.\n\n## Log\n- start\n- EDITED-ENTRY-5528\n\n## Later\nx\n',
    'edit replaced the text and inserted under the heading, keeping the frontmatter'
  )

  step('Outside the grants')
  await send('vgrant elsewhere')
  await idle()
  check(!file('Areas/README.md').includes('ELSEWHERE-9912'), 'an ungranted note is unchanged')
  check(
    results().some((r) => /isn't in a folder the user has allowed/.test(r)),
    'Claude is told it is not in an allowed folder'
  )
  await send('vgrant protected')
  await idle()
  check(
    file('Custard/Captures/Old.md') === 'old capture\n',
    'Captures stays protected under a grant on Custard'
  )
  await send('vgrant newoutside')
  const c = await nextCard()
  check(!!c && /Outside\.md/.test((await c.textContent()) ?? ''), 'a new note elsewhere still asks')
  if (c) await c.getByRole('button', { name: "Don't allow", exact: true }).click()
  await idle()
  check(!fs.existsSync(`${V}/Inbox/Outside.md`), 'declining created nothing')

  step('Recent changes and Undo')
  await openSettings()
  const list = w.locator('ul[aria-label="Recent changes"]')
  await list.waitFor()
  check((await list.locator('li').count()) === 3, 'the three changes are listed')
  await w.screenshot({ path: SHOTS + '/vault-edit-recent.png' })
  await w.click('button[aria-label="Undo change to Journal/Log.md"]')
  await w.waitForSelector('text=Restored Journal/Log.md')
  check(file('Journal/Log.md') === '# Log\n- first\n', 'undo restored the note')
  check(
    (await w.locator('button[aria-label="Undo change to Journal/Log.md"]').count()) === 0,
    'it cannot be undone twice'
  )
  fs.writeFileSync(`${V}/Notes/Plan.md`, file('Notes/Plan.md') + 'by hand\n')
  await w.click('button[aria-label="Undo change to Notes/Plan.md"]')
  await w.waitForSelector('text=has changed since this edit')
  check(file('Notes/Plan.md').endsWith('by hand\n'), 'undo leaves a note changed since alone')

  step('Outside text: edits in allowed folders ask, for the rest of the chat')
  await allow('Journal', 'append')
  await closeSettings()
  await app.evaluate(() => {
    const { Readable } = process.getBuiltinModule('stream')
    globalThis.__custardWebHop = async () => ({
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      stream: Readable.from([
        Buffer.from(
          '<html><head><title>Tea</title></head><body><article><h1>Tea</h1><p>' +
            'Brew green tea at 80 degrees for two minutes. '.repeat(8) +
            '</p></article></body></html>'
        )
      ])
    })
  })
  const indicator = w.locator('text=Outside text')
  check((await indicator.count()) === 0, 'no indicator before any outside text')
  await send('vgrant web')
  const seen = []
  const answer = async (stopAt = 60000) => {
    const t0 = Date.now()
    for (;;) {
      if (await w.locator('button[title=Send]').count()) return
      if (Date.now() - t0 > stopAt) throw new Error('timed out')
      const c = card()
      if (await c.count()) {
        const text = (await c.first().textContent()) ?? ''
        seen.push(text)
        const hold =
          /WEB-APPEND|WEB-MADE|APPENDED-LINE|vgrant/.test(text) && !/tea\.example\.com/.test(text)
        await c
          .first()
          .getByRole('button', { name: hold ? "Don't allow" : 'Allow', exact: true })
          .click()
        await new Promise((r) => setTimeout(r, 300))
      } else await new Promise((r) => setTimeout(r, 150))
    }
  }
  await answer()
  const appendCard = seen.find((t) => /WEB-APPEND-4410/.test(t)) ?? ''
  check(!!appendCard, 'an append after a web page shows the card')
  check(/text from the web, a plugin or an automation/.test(appendCard), 'the card says why it is asking')
  check(!file('Journal/Log.md').includes('WEB-APPEND-4410'), 'declining left the note unchanged')
  check(
    seen.some((t) => /WebMade\.md/.test(t) && /WEB-MADE-2203/.test(t)),
    'a new note in an allowed folder asks too, with its content'
  )
  check(!fs.existsSync(`${V}/Notes/WebMade.md`), 'declining created nothing')
  check((await indicator.count()) > 0, 'the chat shows an Outside text indicator')
  await w.screenshot({ path: SHOTS + '/vault-edit-outside.png' })
  seen.length = 0
  await send('vgrant append')
  await answer()
  check(
    seen.some((t) => /APPENDED-LINE-7731/.test(t)),
    'a later append in the same chat still asks'
  )
  check(!file('Journal/Log.md').includes('APPENDED-LINE-7731'), 'and was declined')
  await send('vgrant append')
  for (let i = 0; i < 200 && !(await card().count()); i++)
    await new Promise((r) => setTimeout(r, 100))
  await card().first().getByRole('button', { name: 'Allow', exact: true }).click()
  await idle()
  check(file('Journal/Log.md').endsWith('APPENDED-LINE-7731\n'), 'allowing applies the change')
  await w.click('button[aria-label="Temporary chat"]')
  await w.click('button[aria-label="Temporary chat"]')
  await w.waitForSelector('text=Outside text', { state: 'detached' })
  check(true, 'a new chat clears the indicator')
  await send('vgrant append')
  await idle()
  check(!(await card().count()), 'a new chat without outside text edits with no card again')
  check(
    file('Journal/Log.md').split('APPENDED-LINE-7731').length === 3,
    'and the change was applied'
  )

  step('Removing a grant stops it')
  const logBefore = file('Journal/Log.md')
  await openSettings()
  await w.click('button[aria-label="Remove Journal"]')
  await w.waitForSelector('button[aria-label="Remove Journal"]', { state: 'detached' })
  await closeSettings()
  await send('vgrant append')
  await idle()
  check(file('Journal/Log.md') === logBefore, 'the removed grant no longer works')
} finally {
  await app.close()
  console.log('e2e done, exit', process.exitCode ?? 0)
}
