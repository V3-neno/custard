import { app, BrowserWindow } from 'electron'
import { createServer } from 'http'
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { bundle } from '../../src/main/plugins/build'
import { createRuntime, runTestsInSandbox } from '../../src/main/plugins/runtime'

// Runs the real plugin sandbox in Electron: network isolation, the bridge,
// timeouts, hangs, crashes and cancellation. Started by scripts/test-electron.mjs.

const preload = process.env.CUSTARD_TEST_PRELOAD!
const SDK = resolve(process.env.CUSTARD_REPO!, 'src/plugin-sdk')
const results: { name: string; ok: boolean; detail?: string }[] = []
const check = (name: string, ok: boolean, detail?: unknown): void => {
  results.push({ name, ok, detail: detail === undefined ? undefined : JSON.stringify(detail) })
  if (process.env.CUSTARD_TEST_VERBOSE)
    console.log(ok ? 'ok' : 'FAIL', name, detail === undefined ? '' : JSON.stringify(detail))
}

async function build(source: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'custard-sbx-'))
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src', 'index.ts'), source)
  const r = await bundle(dir, SDK, { kind: 'plugin', entry: 'src/index.ts' })
  if (!r.ok) throw new Error(r.errors.join('\n'))
  return r.code
}

const PROBE = `
import { definePlugin } from 'custard-plugin-sdk'
const attempt = async (f: () => Promise<unknown>): Promise<string> => { try { return 'ok ' + String(await f()) } catch (e) { return 'blocked' } }
export default definePlugin({ tools: {
  probe: async () => JSON.stringify({
    require: typeof (globalThis as any).require,
    process: typeof (globalThis as any).process,
    electron: typeof (globalThis as any).electron,
    ipc: typeof (globalThis as any).ipcRenderer,
    fetch: await attempt(() => fetch('http://127.0.0.1:' + PORT + '/fetch').then(r => r.status)),
    https: await attempt(() => fetch('https://example.com/').then(r => r.status)),
    file: await attempt(() => fetch('file:///etc/hostname').then(r => r.text())),
    xhr: await attempt(() => new Promise((res, rej) => { const x = new XMLHttpRequest(); x.open('GET', 'http://127.0.0.1:' + PORT + '/xhr'); x.onload = () => res(x.status); x.onerror = () => rej(new Error('x')); x.send() })),
    ws: await attempt(() => new Promise((res, rej) => { const w = new WebSocket('ws://127.0.0.1:' + PORT + '/ws'); w.onopen = () => res('open'); w.onerror = () => rej(new Error('ws')) })),
    img: await attempt(() => new Promise((res, rej) => { const i = new Image(); i.onload = () => res('loaded'); i.onerror = () => rej(new Error('img')); i.src = 'http://127.0.0.1:' + PORT + '/img' })),
    beacon: String(navigator.sendBeacon('http://127.0.0.1:' + PORT + '/beacon', 'x')),
    iframe: await attempt(() => new Promise((res, rej) => { const f = document.createElement('iframe'); f.src = 'http://127.0.0.1:' + PORT + '/frame'; f.onload = () => res('loaded'); f.onerror = rej; document.body.appendChild(f); setTimeout(() => rej(new Error('t')), 1500) })),
    navigate: await attempt(async () => { location.href = 'http://127.0.0.1:' + PORT + '/nav'; await new Promise(r => setTimeout(r, 500)); return location.href }),
    open: String(window.open('http://127.0.0.1:' + PORT + '/popup')),
  }),
  viaHost: async (_i, ctx) => (await ctx.fetch('https://api.example.com/x')).text(),
  wait: (_i, ctx) => new Promise((resolve) => ctx.signal.addEventListener('abort', () => { resolve('saw abort') })),
  never: () => new Promise(() => {}),
  spin: () => { for (;;) {} },
}})
`

// Plugin windows are the only windows here; don't quit when one closes.
app.on('window-all-closed', () => {})

app.whenReady().then(async () => {
  const hits: string[] = []
  const server = createServer((req, res) => {
    hits.push(req.url ?? '')
    res.end('ok')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as { port: number }).port
  const code = await build(PROBE.replace(/PORT/g, String(port)))

  const caps: { callId: string; name: string }[] = []
  const exits: string[] = []
  const factory = createRuntime(preload)
  const start = (): ReturnType<typeof factory> =>
    factory({
      pluginId: 'probe',
      code,
      onCap: async (callId, name) => {
        caps.push({ callId, name })
        return { ok: true, value: { status: 200, headers: {}, body: 'from host' } }
      },
      onExit: (reason) => void exits.push(reason)
    })
  const signal = (): AbortSignal => new AbortController().signal

  try {
    const { handle, tools } = await start()
    check(
      'registers its tools over the bridge',
      tools.join() === 'probe,viaHost,wait,never,spin',
      tools
    )

    const probe = JSON.parse((await handle.call('c1', 'probe', {}, {}, 20_000, signal())).content)
    await new Promise((r) => setTimeout(r, 1000))
    check(
      'no Node.js, Electron or IPC in plugin code',
      probe.require === 'undefined' &&
        probe.process === 'undefined' &&
        probe.electron === 'undefined' &&
        probe.ipc === 'undefined',
      probe
    )
    for (const k of ['fetch', 'https', 'file', 'xhr', 'ws', 'img'])
      check(`direct network blocked: ${k}`, probe[k] === 'blocked', probe[k])
    // An iframe's load event fires for the browser's own error page, so the
    // proof for iframes, beacons and navigation is the server's empty log.
    check('popups denied', probe.open === 'null', probe.open)
    check('no request reached the local server', hits.length === 0, hits)

    const via = await handle.call('c2', 'viaHost', {}, {}, 20_000, signal())
    check(
      'host capability works and carries the call id',
      via.content === 'from host' && caps.at(-1)?.callId === 'c2',
      { via, caps }
    )

    const ac = new AbortController()
    const p = handle.call('c3', 'wait', {}, {}, 20_000, ac.signal)
    setTimeout(() => ac.abort(), 100)
    const cancelled = await p
    check(
      'cancelling resolves the call at once',
      cancelled.content === 'The call was cancelled.',
      cancelled
    )

    const t0 = Date.now()
    const timedOut = await handle.call('c4', 'never', {}, {}, 1500, signal())
    check(
      'a call that never answers times out',
      /did not answer within 2 seconds/.test(timedOut.content) && Date.now() - t0 < 2500,
      { timedOut, ms: Date.now() - t0 }
    )
    check('a slow but responsive plugin keeps running', exits.length === 0, exits)

    if (process.env.CUSTARD_TEST_VERBOSE) console.log('spin start')
    const spun = await handle.call('c5', 'spin', {}, {}, 1000, signal())
    if (process.env.CUSTARD_TEST_VERBOSE) console.log('spin settled', spun)
    await new Promise((r) => setTimeout(r, 2500))
    check(
      'a busy loop times out and its window is killed',
      /did not answer/.test(spun.content) && exits.some((e) => /stopped responding/.test(e)),
      { spun, exits }
    )
    check(
      'only the plugin window was affected',
      BrowserWindow.getAllWindows().length === 0,
      BrowserWindow.getAllWindows().length
    )

    const second = await start()
    const pending = second.handle.call('c6', 'never', {}, {}, 20_000, signal())
    const wins = BrowserWindow.getAllWindows()
    wins[0].webContents.forcefullyCrashRenderer()
    const crashed = await pending
    await new Promise((r) => setTimeout(r, 300))
    check(
      'a crash ends pending calls and is reported',
      /stopped/.test(crashed.content) && exits.some((e) => /crashed/.test(e)),
      { crashed, exits }
    )

    const third = await start()
    const inflight = third.handle.call('c7', 'never', {}, {}, 20_000, signal())
    third.handle.dispose('disabled')
    const disabled = await inflight
    check(
      'disposing (disable) ends in-flight calls',
      /stopped \(disabled\)/.test(disabled.content),
      disabled
    )
    const after = await third.handle.call('c8', 'viaHost', {}, {}, 20_000, signal())
    check('no calls after disposal', after.content === 'The plugin is not running.', after)

    const testCode = await (async () => {
      const dir = mkdtempSync(join(tmpdir(), 'custard-sbx-t-'))
      mkdirSync(join(dir, 'tests'))
      writeFileSync(
        join(dir, 'tests', 'a.test.ts'),
        "import { test, assert } from 'custard-plugin-sdk/testing'\ntest('passes', () => assert(true))\ntest('fails', () => assert.equal(1, 2))\ntest('no network', async () => { let ok = false; try { await fetch('http://127.0.0.1:" +
          port +
          "/t') } catch { ok = true }; assert(ok, 'fetch worked') })"
      )
      const r = await bundle(dir, SDK, { kind: 'tests', files: ['tests/a.test.ts'] })
      if (!r.ok) throw new Error(r.errors.join())
      return r.code
    })()
    const tr = await runTestsInSandbox(testCode)
    check(
      'plugin tests run in a sandbox',
      JSON.stringify(tr.map((r) => r.ok)) === '[true,false,true]',
      tr
    )
  } catch (err) {
    check('suite ran', false, String((err as Error).stack ?? err))
  }
  server.close()
  console.log('RESULTS ' + JSON.stringify(results))
  app.exit(results.every((r) => r.ok) ? 0 : 1)
})
