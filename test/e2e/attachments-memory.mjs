// Step 5 privacy in the built app, against test/e2e/interrupt-mock.mjs:
// automatic memory never sees attached files' names or contents, even when
// the user's words and the assistant's answer quote them, and files alone
// never start a capture.
// Usage, from the repo root after `npx electron-vite build`:
//   node test/e2e/interrupt-mock.mjs <out> &   (with <out>/vault a copy of vault-template)
//   node test/e2e/attachments-memory.mjs <out> <screenshot dir>
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
const CFG = OUT + '/cfg-filemem'
const FILES = OUT + '/files-mem'
fs.mkdirSync(FILES, { recursive: true })

// Synthetic, distinctive names and contents: none of these may reach memory.
const TEXT_NAME = 'Zephyr-Quokka-Ledger-7741.md'
const IMAGE_NAME = 'Marmalade-Harbor-0042.png'
const SECRET = 'PLUM-VORTEX-9932 is the gate code for the boathouse.'
const FORBIDDEN = /zephyr|quokka|7741|marmalade|harbor|0042|plum-vortex|9932|boathouse|gate code/i
fs.writeFileSync(`${FILES}/${TEXT_NAME}`, `${SECRET}\n`)
// The smallest PNG header Custard accepts (it reads headers only).
const png = Buffer.alloc(33)
Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0)
png.writeUInt32BE(13, 8)
png.write('IHDR', 12, 'latin1')
png.writeUInt32BE(3, 16)
png.writeUInt32BE(3, 20)
png[24] = 8
png[25] = 2
fs.writeFileSync(`${FILES}/${IMAGE_NAME}`, png)

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
const chat = (start) => conversations().find((c) => c.title.startsWith(start))
const until = async (f, ms = 15000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await f()) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}
// Every file in the vault, with its text.
const vaultFiles = (dir = `${OUT}/vault`) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    return e.isDirectory() ? vaultFiles(p) : [{ p, text: fs.readFileSync(p, 'utf8') }]
  })
const vaultBefore = new Set(vaultFiles().map((f) => f.p))

const app = await electron.launch({
  executablePath: createRequire(import.meta.url)('electron'),
  args: [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), '--password-store=basic', '.'],
  env: { ...process.env, ANTHROPIC_BASE_URL: 'http://127.0.0.1:8899', XDG_CONFIG_HOME: CFG }
})
await app.evaluate(({ safeStorage, dialog }) => {
  safeStorage.setUsePlainTextEncryption?.(true)
  globalThis.__pick = []
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: globalThis.__pick })
})
const pickNext = (paths) => app.evaluate((_, p) => (globalThis.__pick = p), paths)
let w = null
for (let i = 0; !w && i < 300; i++) {
  w = app.windows().find((x) => x.url().endsWith('/renderer/index.html')) ?? null
  if (!w) await new Promise((r) => setTimeout(r, 100))
}
await w.setViewportSize({ width: 1280, height: 900 })
w.on('pageerror', (e) => console.log('pageerror:', e.message))
await w.waitForSelector('text=Custard')
const idle = () => w.waitForSelector('button[title=Send]', { timeout: 30000 })
const chips = '[aria-label="Files to send"] li'
const send = async (t) => {
  await w.fill('textarea', t)
  await w.keyboard.press('Enter')
}
const attach = async (names) => {
  await pickNext(names.map((n) => `${FILES}/${n}`))
  await w.click('button[aria-label="Attach files"]')
  await w.waitForFunction(
    ([s, n]) => document.querySelectorAll(s).length === n,
    [chips, names.length]
  )
}
const newChat = async () => {
  await w.click('button[title="Chat history"]')
  await w.getByRole('button', { name: 'New chat', exact: true }).click()
}

try {
  step('Setup: key and vault, memory on')
  await w.click('button[title=Settings]')
  await w.fill('input[aria-label="Claude API key"]', 'sk-ant-test')
  await w.press('input[aria-label="Claude API key"]', 'Enter')
  await pickNext([`${OUT}/vault`])
  await w.click('button:has-text("Use an existing vault")')
  await w.waitForSelector('text=· connected')
  check(
    await w.locator('input[aria-label="Remember automatically"]').isChecked(),
    '"Remember automatically" is on'
  )
  await w.click('button:text-is("Done")')

  step('A remembered chat whose words and answer quote the files')
  await attach([TEXT_NAME, IMAGE_NAME])
  await send(`quote test: I prefer short answers. What do "${TEXT_NAME}" and "${IMAGE_NAME}" say?`)
  await idle()
  const c1 = chat('quote test')
  const last = c1.messages.at(-1).content
  const answer =
    typeof last === 'string' ? last : last.map((b) => (b.type === 'text' ? b.text : '')).join('')
  check(
    answer.includes(TEXT_NAME) &&
      answer.includes(IMAGE_NAME) &&
      answer.includes('PLUM-VORTEX-9932'),
    "the assistant's answer quotes both names and the file's text"
  )
  check(
    await until(() => chat('quote test')?.memory?.job?.status === 'saved'),
    `the chat was remembered (${chat('quote test')?.memory?.job?.status})`
  )
  const ev = summaries().at(-1)?.evidence ?? ''
  check(summaries().length === 1, 'one summary call')
  check(!FORBIDDEN.test(ev), 'the summarizer saw no file name or content')
  check(
    /I prefer short answers\. What do "\[attached file\]" and "\[attached file\]" say\? \[2 files attached \(1 image, 1 text file\); names and contents not shown\]/.test(
      ev
    ),
    'it saw the request with the names replaced, and the count and types'
  )
  check(
    /Assistant's last answer: left out, because the chat has attached files/.test(ev),
    "the assistant's answer was left out"
  )
  const added = vaultFiles().filter((f) => !vaultBefore.has(f.p))
  check(
    added.length >= 1 && added.some((f) => f.text.includes('Prefers short answers')),
    `a capture note was saved (${added.map((f) => path.basename(f.p)).join(', ')})`
  )
  check(
    vaultFiles().every((f) => !FORBIDDEN.test(f.text)) &&
      vaultFiles().every((f) => !FORBIDDEN.test(f.p)),
    'no note or file name in the vault holds a file name or content'
  )
  await w.screenshot({ path: `${SHOTS}/step5-06-memory.png` })

  step('Files alone never start a capture')
  await newChat()
  const calls = summaries().length
  for (let i = 0; i < 2; i++) {
    await attach([IMAGE_NAME])
    await send('')
    await w.waitForSelector('button[title=Send]', { timeout: 30000 }).catch(() => {})
    // The send button is disabled while the box is empty; wait for the reply.
    await until(() => (chat(IMAGE_NAME)?.messages.length ?? 0) === (i + 1) * 2)
  }
  const c2 = chat(IMAGE_NAME)
  check(c2?.attachments?.length === 2, 'two messages with only a file each were sent')
  await new Promise((r) => setTimeout(r, 2000))
  check(summaries().length === calls, 'no summary call was made for them')
  check(
    !['saved', 'pending'].includes(chat(IMAGE_NAME)?.memory?.job?.status),
    `and nothing was captured (${chat(IMAGE_NAME)?.memory?.job?.status ?? 'no job'})`
  )
} catch (err) {
  console.log('error:', err.message)
  await w.screenshot({ path: `${SHOTS}/step5-memory-error.png` }).catch(() => {})
  process.exitCode = 1
} finally {
  await app.close()
}
console.log('\ne2e done, exit', process.exitCode ?? 0)
