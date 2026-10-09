// Test harness (plain .mjs, like test/e2e, which ESLint skips).
/* eslint-disable @typescript-eslint/explicit-function-return-type */
// 4.1: what the production sandbox actually is in a packaged build, per
// process, on Linux. Run through test/platform/packaged-linux.sh (non-root,
// no --no-sandbox, packaged binary in CUSTARD_EXE):
//   sudo test/platform/packaged-linux.sh test/platform/sandbox-evidence.mjs
// Records Electron/Chromium/Node versions, the launch flags of every process,
// the binary's fuses, and for each renderer whether the kernel shows it
// sandboxed (seccomp-bpf filter, its own user/pid/net namespaces), then checks
// the preview has no privileged bridge. Writes <out>/sandbox-evidence.json.
// It opens a preview with the d-security mock ("d escape test").
import { _electron as electron } from 'playwright'
import { getCurrentFuseWire, FuseV1Options } from '@electron/fuses'
import fs from 'fs'

const [, , OUT] = process.argv
const EXE = process.env.CUSTARD_EXE
const CFG = OUT + '/cfg-evidence'
const check = (cond, what) => {
  console.log((cond ? '✓ ' : '✕ ') + what)
  if (!cond) process.exitCode = 1
}
const step = (s) => console.log('\n## ' + s)
if (!EXE) {
  console.log('CUSTARD_EXE is not set: this checks a packaged build only.')
  process.exit(2)
}
if (process.getuid?.() === 0) {
  console.log('Running as root: Chromium refuses its sandbox, so nothing here would be evidence.')
  process.exit(2)
}
fs.rmSync(CFG, { recursive: true, force: true })

const evidence = { checked: new Date().toISOString(), exe: EXE }
step('Binary')
const wire = await getCurrentFuseWire(EXE)
evidence.fuses = Object.fromEntries(
  Object.entries(FuseV1Options)
    .filter(([k]) => isNaN(Number(k)))
    .map(([k, v]) => [k, String.fromCharCode(wire[v] ?? 0)])
)
// '1' enabled, '0' disabled, 'r' removed.
console.log('  fuses:', JSON.stringify(evidence.fuses))

const app = await electron.launch({
  executablePath: EXE,
  args: ['--password-store=basic'],
  // Playwright's Electron launcher adds --no-sandbox unless this is set.
  chromiumSandbox: true,
  env: { ...process.env, XDG_CONFIG_HOME: CFG, CUSTARD_PLUGIN_DIR: OUT + '/plugin' }
})
try {
  await app.evaluate(({ safeStorage, dialog }, vault) => {
    safeStorage.setUsePlainTextEncryption?.(true)
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [vault] })
  }, OUT + '/vault')
  let w = null
  for (let i = 0; !w && i < 300; i++) {
    w = app.windows().find((x) => x.url().endsWith('/renderer/index.html')) ?? null
    if (!w) await new Promise((r) => setTimeout(r, 100))
  }
  await w.setViewportSize({ width: 1400, height: 900 })
  await w.waitForSelector('text=Custard')

  step('Runtime')
  evidence.runtime = await app.evaluate(({ app }) => ({
    packaged: app.isPackaged,
    versions: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      v8: process.versions.v8
    },
    platform: `${process.platform} ${process.arch}`,
    argv: process.argv.slice(1),
    switches: Object.fromEntries(
      [
        'no-sandbox',
        'disable-gpu-sandbox',
        'disable-seccomp-filter-sandbox',
        'disable-namespace-sandbox',
        'disable-setuid-sandbox',
        'in-process-gpu',
        'single-process',
        'no-zygote',
        'enable-sandbox'
      ].map((s) => [s, app.commandLine.hasSwitch(s)])
    ),
    sandboxEverywhere: 'enableSandbox was not called (per-window webPreferences decide)'
  }))
  console.log('  ' + JSON.stringify(evidence.runtime.versions), evidence.runtime.platform)
  check(evidence.runtime.packaged, 'this is a packaged build')
  check(!evidence.runtime.switches['no-sandbox'], 'the browser process has no --no-sandbox')

  step('Open a preview')
  await w.click('button[title=Settings]')
  await w.fill('input[aria-label="Claude API key"]', 'sk-ant-test')
  await w.press('input[aria-label="Claude API key"]', 'Enter')
  await w.click('button:has-text("Use an existing vault")')
  await w.waitForSelector('text=· connected')
  await w.click('button:text-is("Done")')
  await w.click('button:text-is("Design")')
  await w.fill('textarea', 'd escape test')
  await w.keyboard.press('Enter')
  await w.waitForSelector('[data-preview-status=ready]', { timeout: 40000 }).catch(() => undefined)
  await w.waitForTimeout(1000)

  step('Processes (kernel view)')
  const procs = await app.evaluate(({ app, webContents }) => {
    const metrics = app.getAppMetrics()
    const wcs = webContents.getAllWebContents().map((wc) => ({
      pid: wc.getOSProcessId(),
      url: wc.getURL().slice(0, 80),
      type: wc.getType(),
      sandboxPref: wc.getLastWebPreferences?.()?.sandbox ?? null,
      preload: Boolean(wc.getLastWebPreferences?.()?.preload)
    }))
    return {
      browser: process.pid,
      metrics: metrics.map((m) => ({ pid: m.pid, type: m.type, sandboxed: m.sandboxed })),
      wcs
    }
  })
  const rd = (p) => {
    try {
      return fs.readFileSync(p, 'utf8')
    } catch (e) {
      return `unreadable (${e.code})`
    }
  }
  const ns = (pid, n) => {
    try {
      return fs.readlinkSync(`/proc/${pid}/ns/${n}`)
    } catch (e) {
      return `unreadable (${e.code})`
    }
  }
  const kernel = (pid) => {
    const status = rd(`/proc/${pid}/status`)
    const field = (f) => status.match(new RegExp(`^${f}:\\s*(.*)$`, 'm'))?.[1] ?? '?'
    const cmd = rd(`/proc/${pid}/cmdline`).split('\0')
    return {
      seccomp: field('Seccomp'),
      noNewPrivs: field('NoNewPrivs'),
      user: ns(pid, 'user'),
      pidns: ns(pid, 'pid'),
      net: ns(pid, 'net'),
      flags: cmd.filter((a) => /sandbox|zygote|type=|no-zygote/.test(a)).slice(0, 8)
    }
  }
  const browser = kernel(procs.browser)
  evidence.browser = browser
  evidence.processes = procs.metrics.map((m) => ({
    ...m,
    ...kernel(m.pid),
    contents: procs.wcs.filter((x) => x.pid === m.pid)
  }))
  for (const p of evidence.processes) {
    const label = p.contents
      .map((c) => c.url.replace(/^https:\/\/[0-9a-f]+/, 'https://<random>'))
      .join(', ')
    console.log(
      `  ${p.type.padEnd(8)} pid ${p.pid} seccomp=${p.seccomp} nnp=${p.noNewPrivs} ` +
        `ownUserNs=${p.user !== browser.user} ownNetNs=${p.net !== browser.net} ` +
        `${p.flags.filter((f) => !f.startsWith('--type')).join(' ')} ${label}`
    )
  }
  const filtered = (p) => p.seccomp === '2'
  const preview = evidence.processes.find((p) =>
    p.contents.some((c) => c.url.includes('.preview.invalid'))
  )
  const main = evidence.processes.find((p) =>
    p.contents.some((c) => c.url.endsWith('/renderer/index.html'))
  )
  check(Boolean(preview), 'a preview renderer is running')
  check(
    preview && filtered(preview),
    `the preview renderer has a seccomp-bpf filter (Seccomp: ${preview?.seccomp})`
  )
  check(
    preview && !preview.flags.includes('--no-sandbox'),
    'the preview renderer was not started with --no-sandbox'
  )
  check(preview && preview.contents.every((c) => !c.preload), 'the preview has no preload')
  const gpu = evidence.processes.find((p) => p.type === 'GPU')
  console.log(`  GPU process seccomp=${gpu?.seccomp}`)
  console.log(
    `  main window renderer: sandbox pref ${main?.contents[0]?.sandboxPref}, seccomp=${main?.seccomp}, flags ${main?.flags.join(' ')}`
  )
  evidence.mainWindow = {
    sandboxPreference: main?.contents[0]?.sandboxPref,
    seccomp: main?.seccomp,
    ownUserNs: main ? main.user !== browser.user : null
  }
  check(main?.contents[0]?.sandboxPref === true, 'the main window is created with sandbox: true')
  check(
    main && filtered(main),
    `the main window renderer has a seccomp-bpf filter (Seccomp: ${main?.seccomp})`
  )
  check(
    main && !main.flags.includes('--no-sandbox'),
    'the main window renderer was not started with --no-sandbox'
  )
  const appApi = await app.evaluate(async ({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((x) => x.webContents.getURL().endsWith('/renderer/index.html'))
      ?.webContents.executeJavaScript(
        'JSON.stringify({ custard: typeof window.custard, electron: typeof window.electron, require: typeof require, process: typeof process })'
      )
  )
  console.log('  main window globals: ' + appApi)
  const a = JSON.parse(appApi ?? '{}')
  check(
    a.custard === 'object' &&
      a.electron === 'undefined' &&
      a.require === 'undefined' &&
      a.process === 'undefined',
    'the main window has window.custard and nothing else from the preload'
  )

  step('Preview bridges')
  const bridges = await app.evaluate(async ({ webContents }) => {
    const wc = webContents.getAllWebContents().find((x) => x.getURL().includes('.preview.invalid'))
    if (!wc) return null
    return wc.executeJavaScript(
      `JSON.stringify({ custard: typeof window.custard, require: typeof require, process: typeof process, ipc: typeof window.electron, node: typeof Buffer })`
    )
  })
  console.log('  ' + bridges)
  const b = JSON.parse(bridges ?? '{}')
  check(
    b.custard === 'undefined' &&
      b.require === 'undefined' &&
      b.process === 'undefined' &&
      b.node === 'undefined',
    'the preview sees no window.custard, require, process or Buffer'
  )
} finally {
  fs.writeFileSync(OUT + '/sandbox-evidence.json', JSON.stringify(evidence, null, 1))
  await app.close().catch(() => undefined)
}
