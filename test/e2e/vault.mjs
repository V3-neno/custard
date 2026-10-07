// Step 4 in the built app, against test/e2e/interrupt-mock.mjs: a vault search
// with phrases, a folder filter and accents, a long note read in two parts,
// and no note-editing tool offered (targeted editing is deferred).
// Usage, from the repo root after `npx electron-vite build`:
//   node test/e2e/interrupt-mock.mjs <out> &   (with <out>/vault as for interrupt.mjs)
//   node test/e2e/vault.mjs <out> <screenshot dir>
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
const PLAN = `${OUT}/vault/Projects/Plan.md`
const ORIGINAL = '# Release plan\n\nStatus: draft\n\nMeet at the Café on Friday.\n'
fs.mkdirSync(`${OUT}/vault/Projects`, { recursive: true })
fs.writeFileSync(PLAN, ORIGINAL)
fs.writeFileSync(`${OUT}/vault/Projects/Other.md`, 'cafe, but no plan\n')
const LONG = Array.from({ length: 700 }, (_, i) => `line ${i} ${'x'.repeat(90)}`).join('\n') + '\n'
fs.writeFileSync(`${OUT}/vault/Projects/Long.md`, LONG)
const plan = () => fs.readFileSync(PLAN, 'utf8')
const CFG = OUT + '/cfg-vault'
const requests = () => {
  try {
    return JSON.parse(fs.readFileSync(`${OUT}/anthropic.json`, 'utf8'))
  } catch {
    return []
  }
}
const app = await electron.launch({
  executablePath: createRequire(import.meta.url)('electron'),
  args: [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), '--password-store=basic', '.'],
  env: { ...process.env, ANTHROPIC_BASE_URL: 'http://127.0.0.1:8899', XDG_CONFIG_HOME: CFG }
})
await app.evaluate(({ safeStorage, dialog }, vault) => {
  safeStorage.setUsePlainTextEncryption?.(true)
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [vault] })
}, OUT + '/vault')
let w = null
for (let i = 0; !w && i < 300; i++) {
  w = app.windows().find((x) => x.url().endsWith('/renderer/index.html')) ?? null
  if (!w) await new Promise((r) => setTimeout(r, 100))
}
await w.setViewportSize({ width: 1280, height: 900 })
w.on('pageerror', (e) => console.log('pageerror:', e.message))
await w.waitForSelector('text=Custard')
const shot = (n) => w.screenshot({ path: `${SHOTS}/${n}.png` })
const send = async (t) => {
  await w.fill('textarea', t)
  await w.keyboard.press('Enter')
}
const idle = () => w.waitForSelector('button[title=Send]', { timeout: 30000 })
const results = () =>
  requests()
    .flatMap((r) => r.messages)
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .filter((c) => c.type === 'tool_result')
    .map((c) => String(c.content))
    // Each request repeats the history, so each result once.
    .filter((c, i, all) => all.indexOf(c) === i)

try {
  step('Setup: key and vault')
  await w.click('button[title=Settings]')
  await w.fill('input[aria-label="Claude API key"]', 'sk-ant-test')
  await w.press('input[aria-label="Claude API key"]', 'Enter')
  await w.click('button:has-text("Use an existing vault")')
  await w.waitForSelector('text=· connected')
  await w.click('button:text-is("Done")')

  step('Search: phrase, folder and accents')
  await send('search test')
  await idle()
  const found = results()[0] ?? ''
  check(
    /^2 notes matched cafe "release plan" folder:Projects \(1 with every term, listed first\)/.test(
      found
    ),
    'the result gives the total and ranks the note with every term first'
  )
  check(
    /- Projects\/Plan\.md\n/.test(found) && /Other\.md \(1 of 2 terms\)/.test(found),
    'the partial match is labelled'
  )
  check(found.includes('Café'), 'an accent-insensitive match is quoted as written')
  check((await w.locator('text=Searched notes for').count()) > 0, 'the search shows in the chat')
  check(
    requests()[0]
      .tools.filter((t) => t.startsWith('vault_'))
      .join() === 'vault_search,vault_list,vault_read,vault_create_note,vault_append',
    'no note-editing tool is offered'
  )
  await shot('01-search')

  step('A long note is read in two parts')
  await send('parts test')
  await idle()
  const parts = results().filter((r) => r.startsWith('[Projects/Long.md'))
  const version = /version (\w+)/.exec(parts[0] ?? '')?.[1]
  check(parts.length === 2, 'the model read it in two calls')
  check(
    /· characters 0–[\d,]+ of [\d,]+ · more follows\]/.test(parts[0]) &&
      /For the next part, call vault_read with offset \d+/.test(parts[0]),
    'the first part says more follows and where'
  )
  check(
    /· end of note\]/.test(parts[1] ?? '') && parts[1].includes(`version ${version}`),
    'the second part ends the note at the same version'
  )
  const body = (p) =>
    p
      .split('\n')
      .slice(1)
      .join('\n')
      .replace(/\n\[Part ends at[^\n]*\]$/, '')
  check(
    body(parts[0]) + body(parts[1] ?? '') === LONG,
    'the two parts join back into the note exactly'
  )
  check(
    (await w.locator('text=Read Projects/Long.md (continued)').count()) === 1,
    'the chat shows the continued read'
  )
  check(plan() === ORIGINAL, 'nothing in the vault changed')
} catch (err) {
  console.log('✕ crashed:', err.message)
  process.exitCode = 1
  await shot('error').catch(() => undefined)
} finally {
  await app.close()
}
