// Code blocks (drafted prompts, skills, code) have a one-click Copy button,
// and long ones start collapsed under Show more.
// Against test/e2e/interrupt-mock.mjs; usage as for web.mjs:
//   node test/e2e/copy.mjs <out> <screenshot dir>
// Linux only as written, with a display or xvfb-run. Needs the playwright package.
import { _electron as electron } from 'playwright'
import { createRequire } from 'module'

const [, , OUT, SHOTS] = process.argv
const check = (cond, what) => {
  console.log((cond ? '✓ ' : '✕ ') + what)
  if (!cond) process.exitCode = 1
}

const app = await electron.launch({
  executablePath: createRequire(import.meta.url)('electron'),
  args: [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), '--password-store=basic', '.'],
  env: {
    ...process.env,
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:8899',
    XDG_CONFIG_HOME: OUT + '/cfg-copy',
    CUSTARD_PLUGIN_DIR: OUT + '/plugin'
  }
})
await app.evaluate(({ safeStorage }) => safeStorage.setUsePlainTextEncryption?.(true))
const w = await app.firstWindow()
await w.setViewportSize({ width: 1280, height: 900 })
w.on('pageerror', (e) => console.log('pageerror:', e.message))
await w.waitForSelector('text=Custard')
try {
  await w.click('button[title=Settings]')
  await w.fill('input[aria-label="Claude API key"]', 'sk-ant-test')
  await w.press('input[aria-label="Claude API key"]', 'Enter')
  await w.click('button:text-is("Done")')
  await w.fill('textarea', 'copy test')
  await w.keyboard.press('Enter')
  await w.waitForSelector('.markdown pre', { timeout: 30000 })
  const button = w.locator('.markdown button[aria-label=Copy]')
  check((await button.count()) === 1, 'the code block has a Copy button')
  // An icon at the top right of the block (Neno's reference), not a text pill.
  const [b, pre] = await Promise.all([
    button.boundingBox(),
    w.locator('.markdown pre').boundingBox()
  ])
  check(
    pre.x + pre.width - (b.x + b.width) < 24 && b.y - pre.y < 24 && b.width < 32,
    'the Copy button is a small icon at the top right of the block'
  )
  check((await button.locator('svg').count()) === 1, 'the Copy button is an icon')
  await button.click()
  await w.waitForSelector('.markdown button[aria-label=Copied]')
  const copied = await app.evaluate(({ clipboard }) => clipboard.readText())
  check(
    copied === 'Build a tea timer.\nUse the forge style.',
    `one click copies the block's text exactly (${JSON.stringify(copied)})`
  )
  check(
    (await w.locator('.markdown button:text-is("Show more")').count()) === 0,
    'a short block has no Show more'
  )
  await w.screenshot({ path: SHOTS + '/copy.png' })

  // A long block starts collapsed; Copy takes all of it either way.
  const full = Array.from({ length: 40 }, (_, i) => `Step ${i + 1}: keep the forge style.`).join(
    '\n'
  )
  await w.fill('textarea', 'long copy test')
  await w.keyboard.press('Enter')
  await w.waitForSelector('.markdown pre >> nth=1', { timeout: 30000 })
  const longPre = w.locator('.markdown pre').nth(1)
  const block = longPre.locator('..')
  const more = block.locator('button:text-is("Show more")')
  await more.waitFor({ timeout: 5000 })
  const clipped = (el) => el.scrollHeight > el.clientHeight + 1
  check(await longPre.evaluate(clipped), 'a long block starts collapsed')
  check((await more.count()) === 1, 'a long block has Show more')
  await block.locator('button[aria-label=Copy]').click()
  await block.locator('button[aria-label=Copied]').waitFor()
  check(
    (await app.evaluate(({ clipboard }) => clipboard.readText())) === full,
    'Copy on a collapsed block copies all of it'
  )
  await w.screenshot({ path: SHOTS + '/copy-collapsed.png' })
  await app.evaluate(({ clipboard }) => clipboard.writeText(''))
  await more.click()
  await block.locator('button:text-is("Show less")').waitFor()
  check(!(await longPre.evaluate(clipped)), 'Show more expands it')
  await block.locator('button[aria-label=Copy]').waitFor()
  await block.locator('button[aria-label=Copy]').click()
  await block.locator('button[aria-label=Copied]').waitFor()
  check(
    (await app.evaluate(({ clipboard }) => clipboard.readText())) === full,
    'Copy on an expanded block copies all of it'
  )
  await block.locator('button:text-is("Show less")').click()
  check(await longPre.evaluate(clipped), 'Show less collapses it again')
} finally {
  await app.close()
  console.log('e2e done, exit', process.exitCode ?? 0)
}
