import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import vm from 'vm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  cutResult,
  widgetData,
  PluginHost,
  type ApprovalRequest,
  type RuntimeFactory,
  type TestRunner,
  type ToolOutcome,
  type ToolSnapshot
} from './host'
import type { NetRequest, NetResponse } from './net'
import { PluginStore } from './store'

// The host with real builds (esbuild) and a stand-in runtime that runs the
// bundle in a Node vm context with the same bridge shape as the sandbox
// preload. The vm is NOT a security boundary; it's only for testing the
// host's checks. The real sandbox is tested in test/electron.

const SDK = resolve(__dirname, '../../plugin-sdk')

type Bridge = {
  call(
    callId: string,
    tool: string,
    input: unknown,
    config: unknown,
    meta?: unknown
  ): Promise<{ content: string; isError: boolean }>
  cancel(callId: string): void
  tools(): string[]
}

let runtimeStarts = 0
let testRunnerOverride: TestRunner | null = null
let typecheckCalls: unknown[][] = []
let typecheckResult: string[] | Error = []
let exits: ((reason: string) => void)[] = []

const vmRuntime: RuntimeFactory = async ({ code, onCap, onExit }) => {
  runtimeStarts++
  let h: Bridge | null = null
  const context = vm.createContext({
    custardPluginHost: {
      register: (x: Bridge) => (h = x),
      cap: (id: string, n: string, a: unknown) => onCap(id, n, a)
    },
    AbortController,
    setTimeout,
    clearTimeout,
    URL,
    console
  })
  vm.runInContext(code, context, { timeout: 2000 })
  if (!h) throw new Error('The plugin did not register.')
  const bridge = h as Bridge
  let dead = false
  exits.push((reason) => {
    dead = true
    onExit(reason)
  })
  return {
    tools: bridge.tools(),
    handle: {
      dispose: () => void (dead = true),
      // Like the real runtime: a call cut short by a timeout or a cancel
      // after it was sent is marked interrupted.
      call: async (callId, tool, input, config, timeoutMs, signal, meta) => {
        if (dead) return { content: 'not running', isError: true, notSent: true }
        signal.addEventListener('abort', () => bridge.cancel(callId))
        let timer: ReturnType<typeof setTimeout> | undefined
        const timedOut = new Promise<ToolOutcome>((res) => {
          timer = setTimeout(
            () =>
              res({
                content: 'The plugin did not answer in time.',
                isError: true,
                interrupted: true
              }),
            timeoutMs
          )
        })
        const r = await Promise.race([
          bridge.call(callId, tool, JSON.parse(JSON.stringify(input)), config, meta),
          timedOut
        ])
        clearTimeout(timer)
        return signal.aborted ? { ...r, interrupted: true } : r
      }
    }
  }
}

let base: string
let src: string
let opened: string[]
let net: NetRequest[]
let netRoute: (r: NetRequest) => NetResponse
let store: PluginStore
let host: PluginHost
let ask = true
let browser: (url: string) => void = () => {}

const crypto = {
  available: () => true,
  encrypt: (s: string) => Buffer.from(`enc:${s}`),
  decrypt: (b: Buffer) => b.toString().slice(4)
}

function manifest(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    manifestVersion: 1,
    id: 'demo',
    name: 'Demo',
    description: 'Test plugin',
    version: '1.0.0',
    apiVersion: 1,
    entry: 'src/index.ts',
    instructions: 'instructions.md',
    permissions: {
      network: ['api.example.com', 'auth.example.com'],
      openExternal: ['spotify:'],
      storage: true
    },
    config: {
      clientId: { type: 'string', title: 'Client ID' },
      region: { type: 'string', title: 'Region', default: 'eu' },
      apiKey: { type: 'string', title: 'API key', secret: true }
    },
    auth: {
      type: 'oauth-pkce',
      authorizeUrl: 'https://auth.example.com/authorize',
      tokenUrl: 'https://auth.example.com/token',
      redirectPort: 43999,
      redirectPath: '/cb',
      scopes: ['read'],
      clientIdConfigKey: 'clientId',
      apiHosts: ['api.example.com']
    },
    tools: [
      {
        name: 'echo',
        description: 'Echo',
        effect: 'read',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text']
        }
      },
      {
        name: 'call_api',
        description: 'Call the API',
        effect: 'read',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string' },
            auth: { type: 'boolean' },
            method: { type: 'string' },
            body: { type: 'string' }
          }
        }
      },
      {
        name: 'act',
        description: 'Change something',
        effect: 'write',
        label: 'Did {text}',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } } }
      },
      {
        name: 'slow',
        description: 'Never ends',
        effect: 'read',
        inputSchema: { type: 'object', properties: {} }
      },
      {
        name: 'open',
        description: 'Open',
        effect: 'write',
        inputSchema: { type: 'object', properties: { url: { type: 'string' } } }
      },
      {
        name: 'remember',
        description: 'Store',
        effect: 'read',
        inputSchema: { type: 'object', properties: { v: { type: 'string' } } }
      },
      {
        name: 'config',
        description: 'Show config',
        effect: 'read',
        inputSchema: { type: 'object', properties: {} }
      }
    ],
    ...over
  }
}

const INDEX = `
import { definePlugin, PluginError } from 'custard-plugin-sdk'
import { greet } from './greet'
export let actCalls = 0
export default definePlugin({
  tools: {
    echo: ({ text }) => greet(text),
    call_api: async ({ url, auth, method, body }, ctx) => {
      const r = await ctx.fetch(url, { auth, method, body })
      return 'status ' + r.status + ' ' + (await r.text())
    },
    post: async ({ url }, ctx) => {
      const r = await ctx.fetch(url, { method: 'POST', body: '{}' })
      return 'status ' + r.status
    },
    act: ({ text }, ctx) => {
      (globalThis as any).actCalls = ((globalThis as any).actCalls ?? 0) + 1
      if (text === 'fail') throw new PluginError('could not do it')
      // Accepted, but the answer never comes back.
      if (text === 'hang') return new Promise((resolve) => ctx.signal.addEventListener('abort', () => resolve('aborted')))
      return 'done ' + text
    },
    slow: (_i, ctx) => new Promise((resolve) => ctx.signal.addEventListener('abort', () => resolve('aborted'))),
    open: async ({ url }, ctx) => { await ctx.openExternal(url); return 'opened' },
    remember: async ({ v }, ctx) => { await ctx.storage.set('v', v); return String(await ctx.storage.get('v')) },
    config: (_i, ctx) => JSON.stringify(ctx.config),
  }
})
`

function writePlugin(files: Record<string, string>, man = manifest()): void {
  const dir = join(src, 'demo')
  mkdirSync(join(dir, 'src'), { recursive: true })
  mkdirSync(join(dir, 'tests'), { recursive: true })
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify(man))
  writeFileSync(join(dir, 'instructions.md'), 'Use demo tools carefully.')
  writeFileSync(
    join(dir, 'src', 'greet.ts'),
    "export const greet = (t: string): string => 'hello ' + t\n"
  )
  writeFileSync(join(dir, 'src', 'index.ts'), INDEX)
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(dir, p, '..'), { recursive: true })
    writeFileSync(join(dir, p), c)
  }
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'custard-host-'))
  src = join(base, 'plugin')
  mkdirSync(src)
  opened = []
  net = []
  netRoute = () => ({ status: 200, headers: {}, body: 'ok' })
  runtimeStarts = 0
  testRunnerOverride = null
  typecheckCalls = []
  typecheckResult = []
  exits = []
  ask = true
  browser = () => {}
  store = new PluginStore(join(base, 'data'), crypto)
  host = new PluginHost({
    sourceRoot: () => src,
    sdkDir: SDK,
    store,
    runtime: vmRuntime,
    testRunner: async (code, o) => {
      if (testRunnerOverride) return testRunnerOverride(code, o)
      const ctx = vm.createContext({ setTimeout, clearTimeout, console, AbortController, URL })
      vm.runInContext(code, ctx)
      return vm.runInContext(
        `globalThis.__custardRunTests(${JSON.stringify(o?.name ?? null)})`,
        ctx
      )
    },
    typecheck: async (...a) => {
      typecheckCalls.push(a)
      if (typecheckResult instanceof Error) throw typecheckResult
      return typecheckResult
    },
    openExternal: async (u) => void opened.push(u),
    openBrowser: async (u) => browser(u),
    askByDefault: () => ask,
    transport: () => async (r) => {
      net.push(r)
      return netRoute(r)
    }
  })
})

const ALL = [
  'network:api.example.com',
  'network:auth.example.com',
  'open:spotify:',
  'storage',
  'account:auth.example.com',
  'account-token:auth.example.com',
  'account-api:api.example.com',
  'account-scope:read',
  'action:act',
  'action:open'
]

async function activate(approved = ALL): Promise<string> {
  const review = await host.review('demo')
  expect(review.errors).toEqual([])
  await host.activate('demo', review.buildId!, approved)
  return review.buildId!
}

const yes = async (): Promise<boolean> => true
const no = async (): Promise<boolean> => false
const invoke = (
  name: string,
  input: unknown,
  snapshot?: ToolSnapshot,
  approve: (r: ApprovalRequest) => Promise<boolean> = yes,
  signal = new AbortController().signal
): Promise<ToolOutcome> =>
  host.invoke(name, input, {
    snapshot: snapshot ?? host.toolSet('code').snapshot,
    signal,
    approve,
    mode: 'code'
  })

describe('validation and review', () => {
  it('does not keep a build whose sources changed while bundling (L19)', async () => {
    writePlugin({})
    const pending = host.validate('demo')
    // Changed after the sources were read and hashed, before the bundler reads them.
    writeFileSync(
      join(src, 'demo', 'src', 'greet.ts'),
      "export const greet = (): string => 'CHANGED'\n"
    )
    const v = await pending
    expect(v.ok).toBe(false)
    expect(v.errors.join(' ')).toMatch(/changed while/)
    expect(v.buildId).toBeNull()
    // A fresh validation builds what is there now.
    const again = await host.validate('demo')
    expect(again.ok).toBe(true)
    expect(store.build('demo', again.buildId!).code).toContain('CHANGED')
  })

  it('reports manifest errors without building', async () => {
    writePlugin({}, manifest({ apiVersion: 99 }))
    const r = await host.review('demo')
    expect(r.ok).toBe(false)
    expect(r.errors.join()).toMatch(/apiVersion 99 is not supported/)
  })

  it('refuses imports outside the plugin folder, npm packages and Node modules', async () => {
    for (const bad of ["import '../../etc/x'", "import 'left-pad'", "import 'fs'"]) {
      writePlugin({ 'src/index.ts': `${bad}\n${INDEX}` })
      const r = await host.review('demo')
      expect(r.ok).toBe(false)
    }
  })

  it('shows new permissions and the source diff', async () => {
    writePlugin({})
    const r = await host.review('demo')
    expect(r.newPermissions).toEqual(ALL)
    expect(r.files.map((f) => f.change)).toContain('added')
  })

  it('runs plugin tests and the load check in a sandbox', async () => {
    writePlugin({
      'tests/echo.test.ts': `
        import { test, assert, createContext } from 'custard-plugin-sdk/testing'
        import plugin from '../src/index'
        test('echo greets', async () => assert.equal(await plugin.tools.echo({ text: 'x' }, createContext()), 'hello x'))
        test('fails on purpose', () => assert.equal(1, 2))
      `
    })
    const r = await host.test('demo')
    expect(r.results.map((x) => [x.name, x.ok])).toEqual([
      ['Plugin loads and handles every tool in plugin.json', true],
      ['echo greets', true],
      ['fails on purpose', false]
    ])
    expect(r.ok).toBe(false)
  })
})

describe('plugin_test filters, timings and stops', () => {
  const TESTS = {
    'tests/a.test.ts': `
      import { test, assert } from 'custard-plugin-sdk/testing'
      test('alpha one', () => assert.equal(1, 1))
      test('alpha two', () => assert.equal(1, 2))
    `,
    'tests/b.test.ts': `
      import { test, assert } from 'custard-plugin-sdk/testing'
      test('beta', async () => assert.equal(2, 2))
    `
  }
  it('runs one file, without the load check, and says what it left out', async () => {
    writePlugin(TESTS)
    const r = await host.test('demo', undefined, { file: 'tests/b.test.ts' })
    expect(r.results.map((x) => x.name)).toEqual(['beta'])
    expect(r.results[0].ms).toBeTypeOf('number')
    expect(r.ok).toBe(true)
  })
  it('accepts a backslash or ./ spelling of the file, and refuses a file that is not a test', async () => {
    writePlugin(TESTS)
    expect(
      (await host.test('demo', undefined, { file: '.\\tests\\b.test.ts' })).results
    ).toHaveLength(1)
    const r = await host.test('demo', undefined, { file: 'src/index.ts' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/no test file src\/index\.ts.*tests\/a\.test\.ts, tests\/b\.test\.ts/)
  })
  it('runs tests by name and counts the others as skipped', async () => {
    writePlugin(TESTS)
    const r = await host.test('demo', undefined, { name: 'ALPHA' })
    expect(r.results.map((x) => [x.name, x.ok])).toEqual([
      ['alpha one', true],
      ['alpha two', false]
    ])
    expect(r).toMatchObject({ ran: 2, skipped: 1, ok: false })
  })
  it('a name that matches nothing is a failure, not a pass', async () => {
    writePlugin(TESTS)
    const r = await host.test('demo', undefined, { name: 'zzz' })
    expect(r).toMatchObject({ ok: false, ran: 0, error: expect.stringMatching(/"zzz"/) })
  })
  it('keeps the tests that finished when a run is stopped', async () => {
    writePlugin(TESTS)
    testRunnerOverride = async () => {
      throw Object.assign(new Error('Tests took longer than 30 seconds, so they were stopped.'), {
        partial: [
          { name: 'alpha one', ok: true, ms: 3 },
          { name: 'alpha two', ok: true, skipped: true }
        ]
      })
    }
    const r = await host.test('demo')
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/longer than 30 seconds/)
    expect(r.results.map((x) => x.name)).toEqual([
      'Plugin loads and handles every tool in plugin.json',
      'alpha one'
    ])
  })
})

describe('plugin_validate type check', () => {
  it('reports type errors apart from errors, and only when asked', async () => {
    writePlugin({})
    typecheckResult = ['src/index.ts:3: TS2322: Type string is not assignable to type number']
    const plain = await host.validate('demo')
    expect(plain.typeErrors).toBeUndefined()
    expect(typecheckCalls).toHaveLength(0)
    const v = await host.validate('demo', { typeCheck: true })
    expect(v.ok).toBe(true)
    expect(v.typeErrors).toEqual(typecheckResult)
    expect(typecheckCalls[0][2]).toEqual([])
  })
  it('a check that cannot run is a warning, not a failed validation', async () => {
    writePlugin({})
    typecheckResult = new Error('typescript is missing')
    const v = await host.validate('demo', { typeCheck: true })
    expect(v.ok).toBe(true)
    expect(v.typeErrors).toBeUndefined()
    expect(v.warnings.join('\n')).toMatch(/Types were not checked: typescript is missing/)
  })
})

describe('activation and permissions', () => {
  it('requires every requested permission to be approved', async () => {
    writePlugin({})
    const r = await host.review('demo')
    await expect(host.activate('demo', r.buildId!, ALL.slice(1))).rejects.toThrow(
      /Approve these permissions/
    )
    expect(host.toolSet('code').tools).toEqual([])
  })

  it('registers namespaced tools and instructions once active', async () => {
    writePlugin({})
    await activate()
    const set = host.toolSet('code')
    expect(set.tools.map((t) => t.name)).toContain('demo__echo')
    expect(set.tools.every((t) => /^[a-zA-Z0-9_-]{1,64}$/.test(t.name))).toBe(true)
    expect(set.instructions[0]).toContain('Use demo tools carefully.')
    expect(await invoke('demo__echo', { text: 'you' })).toEqual({
      content: 'hello you',
      isError: false,
      outcome: 'completed'
    })
  })

  it('asks again when an update requests more permissions', async () => {
    writePlugin({})
    await activate()
    const m = manifest({ version: '1.1.0' })
    ;(m.permissions as { network: string[] }).network.push('more.example.com')
    writePlugin({}, m)
    const r = await host.review('demo')
    expect(r.newPermissions).toEqual(['network:more.example.com'])
    await expect(host.activate('demo', r.buildId!, [])).rejects.toThrow(/more.example.com/)
    expect(host.status('demo').active?.version).toBe('1.0.0')
    await host.activate('demo', r.buildId!, r.newPermissions)
    expect(host.status('demo').active?.version).toBe('1.1.0')
  })

  it('keeps the running version when an update fails to load (automatic rollback)', async () => {
    writePlugin({})
    await activate()
    writePlugin(
      { 'src/index.ts': "throw new Error('boom at load')" },
      manifest({ version: '2.0.0' })
    )
    const r = await host.review('demo')
    await expect(host.activate('demo', r.buildId!, [])).rejects.toThrow(
      /2.0.0 failed to start.*1.0.0 is still the active version/s
    )
    expect(host.status('demo')).toMatchObject({
      state: 'enabled',
      running: true,
      active: { version: '1.0.0' }
    })
    expect(await invoke('demo__echo', { text: 'a' })).toEqual({
      content: 'hello a',
      isError: false,
      outcome: 'completed'
    })
  })

  it('refuses a build whose code lacks a handler for a declared tool', async () => {
    writePlugin({
      'src/index.ts':
        "import { definePlugin } from 'custard-plugin-sdk'\nexport default definePlugin({ tools: { echo: () => 'x' } })"
    })
    const r = await host.review('demo')
    await expect(host.activate('demo', r.buildId!, ALL)).rejects.toThrow(/no handler for call_api/)
  })

  it('rolls back to the previous version', async () => {
    writePlugin({})
    await activate()
    writePlugin(
      { 'src/greet.ts': "export const greet = (t: string): string => 'bye ' + t\n" },
      manifest({ version: '1.0.1' })
    )
    const r = await host.review('demo')
    await host.activate('demo', r.buildId!, [])
    expect((await invoke('demo__echo', { text: 'a' })).content).toBe('bye a')
    await host.rollback('demo')
    expect(host.status('demo').active?.version).toBe('1.0.0')
    expect((await invoke('demo__echo', { text: 'a' })).content).toBe('hello a')
  })
})

describe('invocation-time checks', () => {
  it('unregisters tools on disable and rejects stale calls without running them', async () => {
    writePlugin({})
    await activate()
    const stale = host.toolSet('code').snapshot
    host.disable('demo')
    expect(host.toolSet('code').tools).toEqual([])
    const r = await invoke('demo__act', { text: 'x' }, stale)
    expect(r).toEqual({
      content: 'The demo plugin is disabled, so this call was not run.',
      isError: true,
      outcome: 'not-run'
    })
  })

  it('rejects calls offered by an older build after an update', async () => {
    writePlugin({})
    await activate()
    const stale = host.toolSet('code').snapshot
    writePlugin({}, manifest({ version: '1.0.1' }))
    const r = await host.review('demo')
    await host.activate('demo', r.buildId!, [])
    expect((await invoke('demo__echo', { text: 'x' }, stale)).content).toMatch(
      /updated or rolled back/
    )
  })

  it('rejects tools the model was never offered', async () => {
    writePlugin({})
    await activate()
    expect((await invoke('demo__echo', { text: 'x' }, new Map())).content).toMatch(/not available/)
    expect((await invoke('other__echo', { text: 'x' })).content).toMatch(/not available/)
  })

  it('tells the plugin who started the call, never from the input', async () => {
    writePlugin({
      'src/index.ts': INDEX.replace(
        'echo: ({ text }) => greet(text),',
        'echo: (_i, ctx) => ctx.caller,'
      )
    })
    await activate()
    const as = (caller?: 'assistant' | 'widget' | 'automation'): Promise<ToolOutcome> =>
      host.invoke(
        'demo__echo',
        { text: 'widget' },
        {
          snapshot: host.toolSet('code').snapshot,
          signal: new AbortController().signal,
          approve: yes,
          mode: 'code',
          ...(caller ? { caller } : {})
        }
      )
    expect((await as('widget')).content).toBe('widget')
    expect((await as('automation')).content).toBe('automation')
    expect((await as('assistant')).content).toBe('assistant')
    // Left out, it claims the least.
    expect((await as()).content).toBe('assistant')
  })

  it('validates input against the schema before the plugin runs', async () => {
    writePlugin({})
    await activate()
    expect((await invoke('demo__echo', { text: 5 })).content).toMatch(
      /Invalid input: input.text must be a string/
    )
  })

  it('asks before write tools, and a refusal means the plugin is never called', async () => {
    writePlugin({})
    await activate()
    const asked: string[] = []
    const r = await invoke('demo__act', { text: 'x' }, undefined, async (req) => {
      asked.push(req.label)
      return false
    })
    expect(asked).toEqual(['Did x'])
    expect(r.content).toMatch(/declined/)
    // Read tools never ask.
    await invoke('demo__echo', { text: 'x' }, undefined, no)
  })

  it('skips the question when the user turned it off for that tool', async () => {
    writePlugin({})
    await activate()
    host.setAskEveryTime('demo', 'act', false)
    expect((await invoke('demo__act', { text: 'x' }, undefined, no)).content).toBe('done x')
  })

  it('restarts a crashed plugin on the next call', async () => {
    writePlugin({})
    await activate()
    exits[exits.length - 1]('it crashed (killed)')
    expect(host.status('demo').running).toBe(false)
    expect(host.status('demo').errors.at(-1)?.message).toMatch(/crashed/)
    expect((await invoke('demo__echo', { text: 'x' })).content).toBe('hello x')
    expect(runtimeStarts).toBe(2)
  })

  it('cancels a running call when the request is stopped', async () => {
    writePlugin({})
    await activate()
    const c = new AbortController()
    const p = invoke('demo__slow', {}, undefined, yes, c.signal)
    setTimeout(() => c.abort(), 10)
    expect((await p).content).toBe('aborted')
  })
})

describe('what became of a call', () => {
  const withTimeouts = (): Record<string, unknown> => {
    const m = manifest()
    m.tools = (m.tools as Record<string, unknown>[]).map((t) =>
      t.name === 'act' || t.name === 'slow' ? { ...t, timeoutMs: 1000 } : t
    )
    return m
  }

  it('completed, or failed when the plugin reports an error', async () => {
    writePlugin({})
    await activate()
    expect((await invoke('demo__act', { text: 'x' })).outcome).toBe('completed')
    const r = await invoke('demo__act', { text: 'fail' })
    expect(r).toMatchObject({ outcome: 'failed', content: 'could not do it' })
  })

  it('not run when refused before the plugin was called', async () => {
    writePlugin({})
    await activate()
    expect((await invoke('demo__act', { text: 'x' }, undefined, no)).outcome).toBe('not-run')
    expect((await invoke('demo__act', { text: 5 })).outcome).toBe('not-run')
    expect((await invoke('demo__nope', {})).outcome).toBe('not-run')
    // Stopped while the approval card was up.
    const c = new AbortController()
    const r = await invoke(
      'demo__act',
      { text: 'x' },
      undefined,
      async () => {
        c.abort()
        return false
      },
      c.signal
    )
    expect(r).toMatchObject({
      outcome: 'not-run',
      content: 'Stopped before it ran, so nothing was done.'
    })
  })

  it('unknown when a write times out after it was sent; a read is just failed', async () => {
    writePlugin({}, withTimeouts())
    await activate()
    const w = await invoke('demo__act', { text: 'hang' })
    expect(w).toMatchObject({ outcome: 'unknown', isError: true })
    const r = await invoke('demo__slow', {})
    expect(r).toMatchObject({ outcome: 'failed', isError: true })
  }, 10_000)

  it('unknown when a running write is stopped', async () => {
    writePlugin({})
    await activate()
    const c = new AbortController()
    const p = invoke('demo__act', { text: 'hang' }, undefined, yes, c.signal)
    setTimeout(() => c.abort(), 20)
    expect((await p).outcome).toBe('unknown')
  })

  it('skips the question for a call the user already approved', async () => {
    writePlugin({})
    await activate()
    const r = await host.invoke(
      'demo__act',
      { text: 'x' },
      {
        snapshot: host.toolSet('code').snapshot,
        signal: new AbortController().signal,
        mode: 'code',
        approve: no,
        preApproved: true
      }
    )
    expect(r).toMatchObject({ outcome: 'completed', content: 'done x' })
  })
})

describe('a long result', () => {
  it('is cut at 50,000 characters and says how much is left out', async () => {
    writePlugin({})
    await activate()
    netRoute = () => ({ status: 200, headers: {}, body: 'x'.repeat(60_000) })
    const r = await invoke('demo__call_api', { url: 'https://api.example.com/big' })
    expect(r.isError).toBe(false)
    expect(r.content.startsWith('status 200 xxx')).toBe(true)
    expect(r.content).toContain(
      '\n[… 10,011 more characters are left out here: Custard keeps at most 50,000 characters of one plugin result]'
    )
    expect(r.content.length).toBeLessThan(50_300)
  })
  it('is not touched, and gets no note, at or under the limit', () => {
    expect(cutResult('y'.repeat(50_000))).toBe('y'.repeat(50_000))
    expect(cutResult('y'.repeat(50_001))).toContain('1 more characters are left out here')
  })
  it('redacts a key before it cuts, so a key at the cut is not left half showing', async () => {
    writePlugin({})
    await activate()
    await store.setSecret('demo', 'token', 'S3CRET-VALUE-1234567890')
    netRoute = () => ({
      status: 200,
      headers: {},
      body: `${'x'.repeat(49_985)}S3CRET-VALUE-1234567890${'z'.repeat(100)}`
    })
    const r = await invoke('demo__call_api', { url: 'https://api.example.com/key' })
    expect(r.content).not.toContain('S3CR')
  })
})

describe('capabilities', () => {
  it('only reaches allowed hosts', async () => {
    writePlugin({})
    await activate()
    expect((await invoke('demo__call_api', { url: 'https://evil.example.org/' })).content).toMatch(
      /no permission to connect to evil.example.org/
    )
    expect((await invoke('demo__call_api', { url: 'https://api.example.com/x' })).content).toBe(
      'status 200 ok'
    )
  })

  it('adds the access token only for API hosts and keeps it out of results', async () => {
    writePlugin({})
    await activate()
    store.setSecret(
      'demo',
      '__oauth',
      JSON.stringify({
        accessToken: 'tok-123456',
        refreshToken: 'ref-123456',
        expiresAt: Date.now() + 3600_000,
        scope: 'read'
      })
    )
    netRoute = (r) => ({
      status: 200,
      headers: {},
      body: `saw ${r.headers.authorization ?? 'none'}`
    })
    const r = await invoke('demo__call_api', { url: 'https://api.example.com/me', auth: true })
    expect(net.at(-1)!.headers.authorization).toBe('Bearer tok-123456')
    expect(r.content).toBe('status 200 saw Bearer [redacted]')
    await invoke('demo__call_api', { url: 'https://auth.example.com/x', auth: true })
    expect(net.at(-1)!.headers.authorization).toBeUndefined()
  })

  it('refreshes once after a 401 and retries', async () => {
    writePlugin({})
    await activate()
    host.setConfig('demo', { clientId: 'abc' })
    store.setSecret(
      'demo',
      '__oauth',
      JSON.stringify({
        accessToken: 'old-123456',
        refreshToken: 'ref-123456',
        expiresAt: Date.now() + 3600_000,
        scope: 'read'
      })
    )
    netRoute = (r) =>
      r.url.hostname === 'auth.example.com'
        ? {
            status: 200,
            headers: {},
            body: JSON.stringify({ access_token: 'new-123456', expires_in: 3600 })
          }
        : r.headers.authorization === 'Bearer new-123456'
          ? { status: 200, headers: {}, body: 'fresh' }
          : { status: 401, headers: {}, body: '' }
    expect(
      (await invoke('demo__call_api', { url: 'https://api.example.com/me', auth: true })).content
    ).toBe('status 200 fresh')
    expect(JSON.parse(store.secrets('demo').__oauth).refreshToken).toBe('ref-123456')
  })

  it('opens only declared link prefixes', async () => {
    writePlugin({})
    await activate()
    expect((await invoke('demo__open', { url: 'spotify:item/1' })).content).toBe('opened')
    expect((await invoke('demo__open', { url: 'file:///etc/passwd' })).content).toMatch(
      /may not open/
    )
    expect(opened).toEqual(['spotify:item/1'])
  })

  it('opens only links made of plain URL characters (L20)', async () => {
    writePlugin({})
    await activate()
    for (const url of [
      'spotify:x" --inspect',
      "spotify:x'y",
      'spotify:x\\..\\y',
      'spotify:x<y>',
      'spotify:x`y`',
      'spotify:x|y',
      'spotify:caf\u00e9',
      'spotify:x^y'
    ])
      expect((await invoke('demo__open', { url })).content, url).toMatch(/may not open/)
    expect(
      (await invoke('demo__open', { url: 'spotify:track/4uLU6hMC?si=a%20b&x=1#t' })).content
    ).toBe('opened')
    expect(opened).toEqual(['spotify:track/4uLU6hMC?si=a%20b&x=1#t'])
  })

  it('refuses capabilities outside an active call', async () => {
    writePlugin({})
    await activate()
    expect(await host.capability('demo', 'made-up-call', 'storage.get', { key: 'v' })).toEqual({
      ok: false,
      error: 'Plugins can only use the host during a tool call.'
    })
  })

  it('gives plugins non-secret config only, with defaults', async () => {
    writePlugin({})
    await activate()
    host.setConfig('demo', { clientId: 'abc', apiKey: 'sk-very-secret' })
    expect(JSON.parse((await invoke('demo__config', {})).content)).toEqual({
      region: 'eu',
      clientId: 'abc'
    })
    expect(readFileSync(join(base, 'data', 'demo', 'config.json'), 'utf8')).not.toContain(
      'sk-very-secret'
    )
    expect(host.status('demo').config.secretsSet).toEqual(['apiKey'])
  })

  it('denies storage without the permission', async () => {
    const m = manifest()
    ;(m.permissions as { storage: boolean }).storage = false
    writePlugin({}, m)
    await activate(ALL.filter((p) => p !== 'storage'))
    expect((await invoke('demo__remember', { v: 'x' })).content).toMatch(/no storage permission/)
  })
})

describe('where account credentials may go (M3)', () => {
  const signedIn = (): void =>
    store.setSecret(
      'demo',
      '__oauth',
      JSON.stringify({
        accessToken: 'tok-123456',
        refreshToken: 'ref-123456',
        expiresAt: Date.now() + 3600_000,
        scope: 'read'
      })
    )
  // v2 already had cdn.example.net for plain network access; it now also
  // gets the access token, and the token endpoint moves there.
  const moved = (): Record<string, unknown> => {
    const m = manifest({ version: '2.0.0' })
    ;(m.permissions as { network: string[] }).network.push('cdn.example.net')
    return m
  }

  it('an update that sends the token to another allowed host needs approval, and signs out', async () => {
    const v1 = manifest()
    ;(v1.permissions as { network: string[] }).network.push('cdn.example.net')
    writePlugin({}, v1)
    await activate([...ALL, 'network:cdn.example.net'])
    signedIn()
    const m = moved()
    ;(m.auth as { apiHosts: string[] }).apiHosts.push('cdn.example.net')
    writePlugin({}, m)
    const r = await host.review('demo')
    expect(r.newPermissions).toEqual(['account-api:cdn.example.net'])
    await expect(host.activate('demo', r.buildId!, [])).rejects.toThrow(/Approve these permissions/)
    expect(host.status('demo').auth?.connected).toBe(true)
    await host.activate('demo', r.buildId!, ['account-api:cdn.example.net'])
    // The saved tokens were issued for a different set of destinations.
    expect(host.status('demo').auth?.connected).toBe(false)
  })

  it('a moved token endpoint needs approval too', async () => {
    const v1 = manifest()
    ;(v1.permissions as { network: string[] }).network.push('cdn.example.net')
    writePlugin({}, v1)
    await activate([...ALL, 'network:cdn.example.net'])
    const m = moved()
    ;(m.auth as { tokenUrl: string }).tokenUrl = 'https://cdn.example.net/token'
    writePlugin({}, m)
    expect((await host.review('demo')).newPermissions).toEqual(['account-token:cdn.example.net'])
  })

  it('an update that leaves the credentials alone keeps the sign-in', async () => {
    writePlugin({})
    await activate()
    signedIn()
    writePlugin({}, manifest({ version: '1.1.0' }))
    const r = await host.review('demo')
    expect(r.newPermissions).toEqual([])
    await host.activate('demo', r.buildId!, [])
    expect(host.status('demo').auth?.connected).toBe(true)
  })

  it('never follows a redirect off the approved API hosts with the token', async () => {
    writePlugin({})
    await activate()
    signedIn()
    netRoute = (r): NetResponse =>
      r.url.hostname === 'api.example.com'
        ? { status: 307, headers: { location: 'https://auth.example.com/elsewhere' }, body: '' }
        : { status: 200, headers: {}, body: 'followed' }
    const r = await invoke('demo__call_api', { url: 'https://api.example.com/me', auth: true })
    expect(r.content).toMatch(/Refused a redirect to auth.example.com/)
    expect(net.map((n) => n.url.hostname)).toEqual(['api.example.com'])
  })

  it('never redirects a token request, whose body carries the refresh token', async () => {
    writePlugin({})
    await activate()
    host.setConfig('demo', { clientId: 'abc' })
    store.setSecret(
      'demo',
      '__oauth',
      JSON.stringify({
        accessToken: 'old-123456',
        refreshToken: 'ref-123456',
        expiresAt: 0,
        scope: ''
      })
    )
    netRoute = (r): NetResponse =>
      r.url.pathname === '/token'
        ? { status: 307, headers: { location: 'https://api.example.com/steal' }, body: '' }
        : { status: 200, headers: {}, body: 'ok' }
    await invoke('demo__call_api', { url: 'https://api.example.com/me', auth: true })
    expect(net.some((n) => n.url.pathname === '/steal')).toBe(false)
    expect(net.filter((n) => String(n.body ?? '').includes('ref-123456'))).toHaveLength(1)
  })

  it('an update or rollback asks again for actions set to not ask, and per-chat approvals name the build', async () => {
    writePlugin({})
    const first = await activate()
    host.setAskEveryTime('demo', 'act', false)
    let seen: ApprovalRequest | null = null
    await invoke('demo__act', { text: 'x' }, undefined, async (r) => {
      seen = r
      return true
    })
    expect(seen).toBeNull()
    writePlugin({}, manifest({ version: '1.1.0' }))
    const r = await host.review('demo')
    await host.activate('demo', r.buildId!, [])
    expect(host.status('demo').tools.find((t) => t.name === 'act')?.askEveryTime).toBe(true)
    await invoke('demo__act', { text: 'x' }, undefined, async (req) => {
      seen = req
      return true
    })
    expect(seen!.buildId).toBe(r.buildId)
    expect(seen!.buildId).not.toBe(first)
  })
})

describe('sign-ins and refreshes outlived by a sign-out (L5)', () => {
  const expired = (): void =>
    store.setSecret(
      'demo',
      '__oauth',
      JSON.stringify({
        accessToken: 'old-123456',
        refreshToken: 'ref-123456',
        expiresAt: 0,
        scope: ''
      })
    )
  // The token endpoint answers only when the test lets it.
  const heldToken = (): (() => void) => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    host = new PluginHost({
      ...(host as unknown as { d: ConstructorParameters<typeof PluginHost>[0] }).d,
      transport: () => async (r) => {
        net.push(r)
        if (r.url.pathname === '/token') {
          await gate
          return {
            status: 200,
            headers: {},
            body: JSON.stringify({
              access_token: 'new-123456',
              refresh_token: 'ref-2',
              expires_in: 3600
            })
          }
        }
        return { status: 200, headers: {}, body: 'ok' }
      }
    })
    return release
  }

  for (const [what, end] of [
    ['Disconnect', () => host.disconnect('demo')],
    ['clearing the Client ID', () => host.setConfig('demo', { clientId: '' })],
    ['uninstall', () => host.uninstall('demo')]
  ] as [string, () => void][])
    it(`a refresh still running after ${what} saves nothing`, async () => {
      writePlugin({})
      const release = heldToken()
      await activate()
      host.setConfig('demo', { clientId: 'abc' })
      expired()
      const call = invoke('demo__call_api', { url: 'https://api.example.com/me', auth: true })
      await new Promise((r) => setTimeout(r, 50))
      end()
      release()
      await call
      expect(store.secretsLocked('demo')).toBe(false)
      expect(store.secrets('demo').__oauth).toBeUndefined()
      if (what === 'uninstall') expect(existsSync(join(base, 'data', 'demo'))).toBe(false)
    })

  it('a sign-in that finishes after Disconnect saves nothing', async () => {
    writePlugin({})
    await activate()
    host.setConfig('demo', { clientId: 'abc' })
    netRoute = () => ({
      status: 200,
      headers: {},
      body: JSON.stringify({
        access_token: 'a-123456',
        refresh_token: 'r-123456',
        expires_in: 3600
      })
    })
    let callback = ''
    browser = (u) => {
      const p = new URL(u).searchParams
      callback = `${p.get('redirect_uri')}?code=CODE&state=${p.get('state')}`
    }
    const connecting = host.connect('demo').then(
      () => 'connected',
      (e: Error) => e.message
    )
    await new Promise((r) => setTimeout(r, 100))
    host.disconnect('demo')
    await fetch(callback)
    expect(await connecting).toMatch(/cancelled/)
    expect(host.status('demo').auth?.connected).toBe(false)
  })

  it("a request with another sign-in's state doesn't cancel this one (L18)", async () => {
    writePlugin({})
    await activate()
    host.setConfig('demo', { clientId: 'abc' })
    netRoute = () => ({
      status: 200,
      headers: {},
      body: JSON.stringify({
        access_token: 'a-123456',
        refresh_token: 'r-123456',
        expires_in: 3600
      })
    })
    let callback = ''
    browser = (u) => {
      const p = new URL(u).searchParams
      callback = `${p.get('redirect_uri')}?code=CODE&state=${p.get('state')}`
    }
    const connecting = host.connect('demo')
    await new Promise((r) => setTimeout(r, 100))
    await fetch(callback.replace(/state=[^&]+/, 'state=wrong'))
    await fetch(callback)
    await connecting
    expect(host.status('demo').auth?.connected).toBe(true)
  })
})

describe('settings persistence', () => {
  it('keeps config and credentials across updates, and uninstall removes them but not the source', async () => {
    writePlugin({})
    await activate()
    host.setConfig('demo', { clientId: 'abc', apiKey: 'sk-secret-1' })
    store.setSecret(
      'demo',
      '__oauth',
      JSON.stringify({ accessToken: 'a-123456', refreshToken: 'r-123456', expiresAt: 0, scope: '' })
    )
    writePlugin({}, manifest({ version: '1.2.0' }))
    const r = await host.review('demo')
    await host.activate('demo', r.buildId!, [])
    expect(host.status('demo').config.values.clientId).toBe('abc')
    expect(host.status('demo').auth?.connected).toBe(true)
    expect(store.secrets('demo').apiKey).toBe('sk-secret-1')
    host.uninstall('demo')
    expect(existsSync(join(base, 'data', 'demo'))).toBe(false)
    expect(existsSync(join(src, 'demo', 'plugin.json'))).toBe(true)
    expect(host.status('demo').state).toBe('not-activated')
  })

  it('changing the client id signs the account out', async () => {
    writePlugin({})
    await activate()
    host.setConfig('demo', { clientId: 'abc' })
    store.setSecret(
      'demo',
      '__oauth',
      JSON.stringify({ accessToken: 'a-123456', refreshToken: 'r', expiresAt: 0, scope: '' })
    )
    host.setConfig('demo', { clientId: 'xyz' })
    expect(host.status('demo').auth?.connected).toBe(false)
  })

  it('starts enabled plugins again after a restart', async () => {
    writePlugin({})
    await activate()
    const again = new PluginHost({
      ...(host as unknown as { d: ConstructorParameters<typeof PluginHost>[0] }).d
    })
    await again.startAll()
    expect(again.status('demo').running).toBe(true)
  })
})

describe('the Spotify reference plugin through the host', () => {
  const PERMS = [
    'network:api.spotify.com',
    'network:accounts.spotify.com',
    'open:spotify:',
    'storage',
    'events',
    'account:accounts.spotify.com',
    'account-token:accounts.spotify.com',
    'account-api:api.spotify.com',
    'account-scope:user-read-playback-state',
    'account-scope:user-read-currently-playing',
    'account-scope:user-modify-playback-state',
    'account-scope:user-read-recently-played',
    'account-scope:user-top-read',
    'action:add_to_queue',
    'action:open',
    'action:transfer_playback',
    'action:next_track',
    'action:previous_track',
    'action:pause_playback',
    'action:resume_playback',
    'action:seek',
    'action:adjust_volume',
    'widget:player',
    'background:sync_recent@30'
  ]
  const track = {
    uri: `spotify:track:${'a'.repeat(22)}`,
    name: 'Says',
    artists: [{ name: 'Nils Frahm' }],
    duration_ms: 1000
  }

  beforeEach(async () => {
    cpSync(resolve(__dirname, '../../../plugin/spotify'), join(src, 'spotify'), { recursive: true })
    const r = await host.review('spotify')
    expect(r.errors).toEqual([])
    expect(r.newPermissions).toEqual(PERMS)
    await host.activate('spotify', r.buildId!, r.newPermissions)
    host.setConfig('spotify', { clientId: 'a'.repeat(32) })
    store.setSecret(
      'spotify',
      '__oauth',
      JSON.stringify({
        accessToken: 'sp-access-123',
        refreshToken: 'sp-refresh-123',
        expiresAt: Date.now() + 3600_000,
        scope: ''
      })
    )
    netRoute = (r) =>
      r.url.pathname === '/v1/search'
        ? { status: 200, headers: {}, body: JSON.stringify({ tracks: { items: [track] } }) }
        : r.method === 'POST'
          ? { status: 204, headers: {}, body: '' }
          : { status: 200, headers: {}, body: JSON.stringify({ queue: [{ uri: track.uri }] }) }
  })

  it('searches with a host-added token the plugin never sees', async () => {
    const r = await invoke('spotify__search', { query: 'Nils Frahm Says' })
    expect(r.content).toContain(track.uri)
    expect(net[0].url.toString()).toBe(
      'https://api.spotify.com/v1/search?q=Nils%20Frahm%20Says&type=track&limit=5'
    )
    expect(net[0].headers.authorization).toBe('Bearer sp-access-123')
    expect(r.content).not.toContain('sp-access-123')
  })

  it('queues only after the user approves, and a refusal sends nothing to Spotify', async () => {
    await invoke('spotify__search', { query: 'Nils Frahm Says' })
    const declined = await invoke('spotify__add_to_queue', { uris: [track.uri] }, undefined, no)
    expect(declined.content).toMatch(/declined/)
    expect(net.filter((r) => r.method === 'POST')).toHaveLength(0)
    const r = await invoke('spotify__add_to_queue', { uris: [track.uri] }, undefined, yes)
    expect(r.content).toMatch(/All 1 tracks were accepted/)
    expect(net.filter((r) => r.method === 'POST')).toHaveLength(1)
  })

  it('rejects a malformed URI at the host before the plugin runs', async () => {
    const r = await invoke('spotify__add_to_queue', { uris: ['spotify:track:short'] })
    expect(r.content).toMatch(/Invalid input/)
    expect(net).toHaveLength(0)
  })

  it('opens only spotify: links', async () => {
    await invoke('spotify__open', {})
    expect(opened).toEqual(['spotify:'])
  })
})

describe('widgets', () => {
  const WIDGET = {
    id: 'board',
    title: 'Board',
    description: 'A test board.',
    widgetApi: 1,
    entry: 'widget/board.ts',
    tools: ['echo', 'act']
  }
  const BOARD = `import { defineWidget } from 'custard-plugin-sdk/widget'
export default defineWidget({ mount(root) { root.textContent = 'board-7712' } })
`
  const DATA_INDEX = INDEX.replace(
    'echo: ({ text }) => greet(text),',
    "echo: ({ text }) => ({ content: greet(text), data: text === 'big' ? 'x'.repeat(70000) : { text } }),"
  )

  it('needs the widget permission, then lists and bundles it', async () => {
    writePlugin({ 'widget/board.ts': BOARD }, manifest({ widgets: [WIDGET] }))
    const review = await host.review('demo')
    expect(review.errors).toEqual([])
    await expect(host.activate('demo', review.buildId!, ALL)).rejects.toThrow(
      /Approve these permissions/
    )
    expect(host.widgetCatalog('code')).toEqual([])
    await host.activate('demo', review.buildId!, [...ALL, 'widget:board'])
    const [entry] = host.widgetCatalog('code')
    expect(entry).toMatchObject({ pluginId: 'demo', buildId: review.buildId, widget: WIDGET })
    const code = host.widgetCode('demo', review.buildId!, 'board')!
    expect(code).toContain('board-7712')
    expect(code).toContain('custardWidgetHost')
    expect(host.widgetCode('demo', review.buildId!, 'other')).toBeNull()
    expect(host.toolWrites('demo', review.buildId!, 'act')).toBe(true)
    expect(host.toolWrites('demo', review.buildId!, 'echo')).toBe(false)
    expect(host.toolWrites('demo', review.buildId!, 'nope')).toBeNull()
  })

  it('tells listeners when a plugin changes, and a disabled plugin has no widgets', async () => {
    writePlugin({ 'widget/board.ts': BOARD }, manifest({ widgets: [WIDGET] }))
    const changed: string[] = []
    host.onChange((id) => changed.push(id))
    await activate([...ALL, 'widget:board'])
    host.disable('demo')
    expect(host.widgetCatalog('code')).toEqual([])
    expect(changed).toEqual(['demo', 'demo'])
  })

  it('refuses a widget entry that is missing', async () => {
    writePlugin({}, manifest({ widgets: [WIDGET] }))
    const review = await host.review('demo')
    expect(review.errors.join(' ')).toMatch(/widget\/board\.ts/)
  })

  it("passes a tool's data on, but not when it is too large or holds a secret", async () => {
    writePlugin({ 'src/index.ts': DATA_INDEX })
    await activate()
    store.setSecret('demo', 'apiKey', 'sekret-99881')
    expect((await invoke('demo__echo', { text: 'you' })).data).toEqual({ text: 'you' })
    expect((await invoke('demo__echo', { text: 'big' })).data).toBeUndefined()
    const leaked = await invoke('demo__echo', { text: 'sekret-99881' })
    expect(leaked.data).toBeUndefined()
    expect(leaked.content).not.toContain('sekret-99881')
  })

  it('says why data was left out: to the model, to the widget, and in the log', async () => {
    writePlugin({ 'src/index.ts': DATA_INDEX })
    await activate()
    store.setSecret('demo', 'apiKey', 'sekret-99881')
    const fine = await invoke('demo__echo', { text: 'you' })
    expect(fine.dataDropped).toBeUndefined()
    expect(fine.content).not.toMatch(/left out/)
    const big = await invoke('demo__echo', { text: 'big' })
    expect(big.dataDropped).toMatch(/KB and the limit is 64 KB/)
    expect(big.content).toMatch(/data for widgets from this call was left out because it is \d+ KB/)
    const leaked = await invoke('demo__echo', { text: 'sekret-99881' })
    expect(leaked.dataDropped).toBe('it contained a saved credential')
    expect(leaked.content).not.toContain('sekret-99881')
    expect(leaked.content).toMatch(/left out because it contained a saved credential/)
    expect(host.status('demo').log.join('\n')).toMatch(/left out because it is \d+ KB/)
  })

  it('widgetData reports every way data is refused, without repeating it', () => {
    expect(widgetData(undefined, [])).toEqual({})
    expect(widgetData({ a: 1 }, [])).toEqual({ data: { a: 1 } })
    const cyclic: Record<string, unknown> = {}
    cyclic.me = cyclic
    expect(widgetData(cyclic, [])).toEqual({ dropped: "it can't be written as JSON" })
    expect(widgetData(() => 1, [])).toEqual({ dropped: "it can't be written as JSON" })
    expect(widgetData('x'.repeat(2048), [], 1024)).toEqual({
      dropped: 'it is 3 KB and the limit is 1 KB'
    })
    expect(widgetData({ k: 'topsecret' }, ['topsecret'])).toEqual({
      dropped: 'it contained a saved credential'
    })
  })

  it('needs Use in Chat and Design outside Code', async () => {
    writePlugin({ 'widget/board.ts': BOARD }, manifest({ widgets: [WIDGET] }))
    await activate([...ALL, 'widget:board'])
    expect(host.widgetCatalog('code')).toHaveLength(1)
    expect(host.widgetCatalog('chat')).toEqual([])
    expect(host.widgetCatalog('design')).toEqual([])
    host.setChatDesign('demo', true)
    expect(host.widgetCatalog('chat')).toHaveLength(1)
  })
})

describe('readToolSet (unattended runs)', () => {
  it('offers read tools only, after Use in Chat and Design, and says what is unavailable', async () => {
    writePlugin({})
    await activate()
    const before = host.readToolSet(['demo', 'nope'])
    expect(before.tools).toEqual([])
    expect(before.unavailable.sort()).toEqual(['demo', 'nope'])
    host.setChatDesign('demo', true)
    const set = host.readToolSet(['demo'])
    expect(set.unavailable).toEqual([])
    expect(set.tools.map((t) => t.name)).toContain('demo__echo')
    const writes = host
      .status('demo')
      .tools.filter((t) => t.effect === 'write')
      .map((t) => t.fullName)
    expect(writes.length).toBeGreaterThan(0)
    for (const w of writes) {
      expect(set.tools.map((t) => t.name)).not.toContain(w)
      expect(set.snapshot.has(w)).toBe(false)
    }
    // A write tool called anyway is refused, not run.
    const r = await host.invoke(
      writes[0],
      {},
      {
        snapshot: set.snapshot,
        signal: new AbortController().signal,
        approve: async () => true,
        mode: 'chat'
      }
    )
    expect(r).toMatchObject({ isError: true, outcome: 'not-run' })
  })
})

describe('Use in Chat and Design', () => {
  const chatInvoke = (
    name: string,
    input: unknown,
    mode: 'chat' | 'design' | 'skills' | 'code',
    snapshot = host.toolSet('code').snapshot,
    approve: (r: ApprovalRequest) => Promise<boolean> = yes
  ): Promise<ToolOutcome> =>
    host.invoke(name, input, { snapshot, signal: new AbortController().signal, approve, mode })

  it('is off for a newly activated plugin: Chat, Design and Skills get nothing', async () => {
    writePlugin({})
    await activate()
    expect(host.status('demo').chatDesign).toBe('off')
    for (const mode of ['chat', 'design', 'skills'] as const) {
      expect(host.toolSet(mode)).toEqual({ tools: [], snapshot: new Map(), instructions: [] })
      const r = await chatInvoke('demo__echo', { text: 'a' }, mode)
      expect(r).toMatchObject({ outcome: 'not-run', isError: true })
      expect(r.content).toMatch(/isn't turned on for Chat and Design/)
    }
    // Code's Plugins workspace, where plugins are built, doesn't need it.
    expect(host.toolSet('code').tools.length).toBeGreaterThan(0)
    expect((await chatInvoke('demo__echo', { text: 'a' }, 'code')).content).toBe('hello a')
  })

  it('refuses before anything runs or any approval is asked for', async () => {
    writePlugin({})
    await activate()
    let asked = 0
    const r = await chatInvoke('demo__act', { text: 'x' }, 'chat', undefined, async () => {
      asked++
      return true
    })
    expect(r.outcome).toBe('not-run')
    expect(asked).toBe(0)
    expect(runtimeStarts).toBe(1)
    const r2 = await chatInvoke('demo__call_api', { url: 'https://api.example.com/x' }, 'design')
    expect(r2.outcome).toBe('not-run')
    expect(net).toEqual([])
  })

  it('lets the plugin run there once turned on, until turned off', async () => {
    writePlugin({})
    await activate()
    expect(host.setChatDesign('demo', true).chatDesign).toBe('on')
    const set = host.toolSet('chat')
    expect(set.tools.map((t) => t.name)).toContain('demo__echo')
    expect((await chatInvoke('demo__echo', { text: 'a' }, 'chat', set.snapshot)).content).toBe(
      'hello a'
    )
    // A tool list offered while it was on doesn't outlive turning it off.
    host.setChatDesign('demo', false)
    expect(host.status('demo').chatDesign).toBe('off')
    const r = await chatInvoke('demo__echo', { text: 'a' }, 'chat', set.snapshot)
    expect(r.outcome).toBe('not-run')
  })

  it('checks again after the approval card, which can sit open', async () => {
    writePlugin({})
    await activate()
    host.setChatDesign('demo', true)
    const r = await chatInvoke('demo__act', { text: 'x' }, 'chat', undefined, async () => {
      host.setChatDesign('demo', false)
      return true
    })
    expect(r.outcome).toBe('not-run')
    expect(r.content).toMatch(/isn't turned on for Chat and Design/)
  })

  it('asks again when an update reaches more: a host, a link, an account scope or an action', async () => {
    const extra: [Record<string, unknown>, string[]][] = [
      [
        {
          permissions: {
            network: ['api.example.com', 'auth.example.com', 'new.example.com'],
            openExternal: ['spotify:'],
            storage: true
          }
        },
        ['network:new.example.com']
      ],
      [
        {
          permissions: {
            network: ['api.example.com', 'auth.example.com'],
            openExternal: ['spotify:', 'https://example.com/'],
            storage: true
          }
        },
        ['open:https://example.com/']
      ],
      [
        {
          auth: {
            ...(manifest().auth as Record<string, unknown>),
            scopes: ['read', 'write']
          }
        },
        ['account-scope:write']
      ],
      [
        {
          tools: [
            ...(manifest().tools as unknown[]),
            {
              name: 'post',
              description: 'Post',
              effect: 'write',
              inputSchema: { type: 'object', properties: { url: { type: 'string' } } }
            }
          ]
        },
        ['action:post']
      ]
    ]
    for (const [over, added] of extra) {
      host.uninstall('demo')
      rmSync(join(src, 'demo'), { recursive: true, force: true })
      writePlugin({})
      await activate()
      host.setChatDesign('demo', true)
      writePlugin({}, manifest({ version: '1.0.1', ...over }))
      const r = await host.review('demo')
      expect(r.errors).toEqual([])
      await host.activate('demo', r.buildId!, added)
      expect(host.status('demo').chatDesign).toBe('changed')
      expect(host.toolSet('chat').tools).toEqual([])
      expect((await chatInvoke('demo__echo', { text: 'a' }, 'chat')).outcome).toBe('not-run')
      expect(host.setChatDesign('demo', true).chatDesign).toBe('on')
      expect((await chatInvoke('demo__echo', { text: 'a' }, 'chat')).content).toBe('hello a')
    }
  })

  it('stays on for an update that reaches nothing new', async () => {
    writePlugin({})
    await activate()
    host.setChatDesign('demo', true)
    writePlugin({}, manifest({ version: '1.0.1' }))
    const r = await host.review('demo')
    await host.activate('demo', r.buildId!, [])
    expect(host.status('demo').chatDesign).toBe('on')
  })

  it('is off for state saved before it existed, or saved wrong', async () => {
    writePlugin({})
    await activate()
    const { chatDesign, ...old } = store.state('demo')
    expect(chatDesign).toBeNull()
    writeFileSync(join(base, 'data', 'demo', 'state.json'), JSON.stringify(old))
    expect(host.status('demo').chatDesign).toBe('off')
    // A string "includes" every substring: never read as a list.
    writeFileSync(
      join(base, 'data', 'demo', 'state.json'),
      JSON.stringify({ ...old, chatDesign: ALL.join(' ') })
    )
    expect(host.status('demo').chatDesign).toBe('off')
    expect(host.toolSet('chat').tools).toEqual([])
  })

  it('needs an activated plugin', () => {
    writePlugin({})
    expect(() => host.setChatDesign('demo', true)).toThrow(/activate/)
  })
})

describe('read tools only GET or HEAD', () => {
  const run = (name: string, input: unknown): Promise<ToolOutcome> =>
    host.invoke(name, input, {
      snapshot: host.toolSet('code').snapshot,
      signal: new AbortController().signal,
      approve: yes,
      mode: 'code'
    })

  it('refuses any other method, or a body, without sending it', async () => {
    writePlugin({})
    await activate()
    for (const [method, body] of [
      ['POST', undefined],
      ['put', undefined],
      ['DELETE', undefined],
      ['PATCH', '{}'],
      ['GET', '{"a":1}']
    ] as const) {
      const r = await run('demo__call_api', {
        url: 'https://api.example.com/x',
        method,
        ...(body ? { body } : {})
      })
      expect(r.isError).toBe(true)
      expect(r.content).toMatch(/Read tools may only GET or HEAD/)
    }
    expect(net).toEqual([])
  })

  it('sends GET and HEAD', async () => {
    writePlugin({})
    await activate()
    expect((await run('demo__call_api', { url: 'https://api.example.com/x' })).content).toBe(
      'status 200 ok'
    )
    await run('demo__call_api', { url: 'https://api.example.com/y', method: 'head' })
    expect(net.map((r) => [r.method, r.url.toString()])).toEqual([
      ['GET', 'https://api.example.com/x'],
      ['HEAD', 'https://api.example.com/y']
    ])
  })

  it('leaves actions (write tools) free to POST', async () => {
    const tools = [
      ...(manifest().tools as unknown[]),
      {
        name: 'post',
        description: 'Post',
        effect: 'write',
        inputSchema: { type: 'object', properties: { url: { type: 'string' } } }
      }
    ]
    writePlugin({}, manifest({ tools }))
    await activate([...ALL, 'action:post'])
    expect((await run('demo__post', { url: 'https://api.example.com/z' })).content).toBe(
      'status 200'
    )
    expect(net.map((r) => r.method)).toEqual(['POST'])
  })
})

describe('event log (ctx.events)', () => {
  let vault: string
  const DAY = (): string => {
    const d = new Date()
    const p = (n: number): string => String(n).padStart(2, '0')
    // The demo plugin has no timeZone setting, so the log uses the system's.
    const day = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    return `Custard/Plugins/Demo/Events/${day.slice(0, 7)}/${day}.md`
  }
  const LOGGER = INDEX.replace(
    'echo: ({ text }) => greet(text),',
    `echo: async ({ text }, ctx) => {
      if (text === 'state') return String(ctx.events.enabled)
      const n = text === 'many' ? 21 : 1
      try {
        for (let i = 0; i < n; i++)
          await ctx.events.append({ at: new Date().toISOString(), record: { type: text, caller: ctx.caller, i } })
      } catch (e) { return 'refused: ' + (e as Error).message }
      return 'logged'
    },`
  )
  const withEvents = (): ReturnType<typeof manifest> => {
    const m = manifest()
    return { ...m, permissions: { ...(m.permissions as object), events: true } }
  }

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'custard-host-vault-'))
    mkdirSync(join(vault, 'Custard/Plugins/Demo'), { recursive: true })
    host = new PluginHost({
      ...(host as unknown as { d: ConstructorParameters<typeof PluginHost>[0] }).d,
      eventVault: () => ({ vault, pluginFolder: 'Custard/Plugins/Demo' })
    })
  })
  afterEach(() => rmSync(vault, { recursive: true, force: true }))

  it('is a permission of its own, and approving it leaves the log off', async () => {
    writePlugin({ 'src/index.ts': LOGGER }, withEvents())
    expect((await host.review('demo')).newPermissions).toContain('events')
    await activate([...ALL, 'events'])
    expect(host.status('demo').events).toMatchObject({ on: false, granted: true, today: 0 })
    expect((await invoke('demo__echo', { text: 'state' })).content).toBe('false')
    expect((await invoke('demo__echo', { text: 'skip' })).content).toMatch(/refused: .*off/)
    expect(existsSync(join(vault, 'Custard/Plugins/Demo/Events'))).toBe(false)
  })

  it('writes entries when the user turns it on, from read tools too, with the caller', async () => {
    writePlugin({ 'src/index.ts': LOGGER }, withEvents())
    await activate([...ALL, 'events'])
    host.setEvents('demo', true)
    expect((await invoke('demo__echo', { text: 'state' })).content).toBe('true')
    expect((await invoke('demo__echo', { text: 'skip' })).content).toBe('logged')
    await host.invoke(
      'demo__echo',
      { text: 'pause' },
      {
        snapshot: host.toolSet('code').snapshot,
        signal: new AbortController().signal,
        approve: yes,
        mode: 'code',
        caller: 'widget'
      }
    )
    const text = readFileSync(join(vault, DAY()), 'utf8')
    expect(text).toContain('{"type":"skip","caller":"assistant","i":0}')
    expect(text).toContain('{"type":"pause","caller":"widget","i":0}')
    const s = host.status('demo').events!
    expect(s).toMatchObject({
      on: true,
      today: 2,
      error: null,
      folder: 'Custard/Plugins/Demo/Events'
    })
    expect(s.last).toBeTypeOf('number')
    // Off again: nothing more is written.
    host.setEvents('demo', false)
    expect((await invoke('demo__echo', { text: 'resume' })).content).toMatch(/refused/)
    expect(readFileSync(join(vault, DAY()), 'utf8')).toBe(text)
  })

  it('a plugin that does not ask for it has no log', async () => {
    writePlugin({ 'src/index.ts': LOGGER })
    await activate()
    expect(host.status('demo').events).toBeUndefined()
    expect(() => host.setEvents('demo', true)).toThrow(/no event log/)
    expect((await invoke('demo__echo', { text: 'skip' })).content).toMatch(
      /refused: .*no event log permission/
    )
  })

  it('caps entries per call and remembers the last failure', async () => {
    writePlugin({ 'src/index.ts': LOGGER }, withEvents())
    await activate([...ALL, 'events'])
    host.setEvents('demo', true)
    expect((await invoke('demo__echo', { text: 'many' })).content).toMatch(/At most 20/)
    expect(host.status('demo').events!.today).toBe(20)
    expect((await invoke('demo__echo', { text: 'Bearer abcdefghijklmnop' })).content).toMatch(
      /looks like a password or token/
    )
    expect(host.status('demo').events!.error).toMatch(/looks like a password/)
    expect((await invoke('demo__echo', { text: 'ok' })).content).toBe('logged')
    expect(host.status('demo').events!.error).toBeNull()
  })

  it('reports a missing vault without writing anywhere', async () => {
    host = new PluginHost({
      ...(host as unknown as { d: ConstructorParameters<typeof PluginHost>[0] }).d,
      eventVault: () => null
    })
    writePlugin({ 'src/index.ts': LOGGER }, withEvents())
    await activate([...ALL, 'events'])
    host.setEvents('demo', true)
    expect((await invoke('demo__echo', { text: 'skip' })).content).toMatch(/No Obsidian vault/)
  })
})

describe('background sync', () => {
  const withSync = (): Record<string, unknown> =>
    manifest({ background: { tool: 'config', everyMinutes: 30 } })
  const SYNC = [...ALL, 'background:config@30']

  it('asks for its own permission, and is off until the user turns it on', async () => {
    writePlugin(
      {
        'src/index.ts': INDEX.replace(
          'config: (_i, ctx) => JSON.stringify(ctx.config),',
          'config: (_i, ctx) => ctx.caller,'
        )
      },
      withSync()
    )
    const review = await host.review('demo')
    expect(review.newPermissions).toContain('background:config@30')
    await activate(SYNC)
    expect(host.status('demo').background).toMatchObject({ on: false, granted: true })
    expect(host.backgroundPlugins()).toEqual([])
    expect((await host.invokeBackground('demo', new AbortController().signal)).outcome).toBe(
      'not-run'
    )
    host.setBackground('demo', true)
    expect(host.backgroundPlugins()).toEqual([{ id: 'demo', name: 'Demo', everyMinutes: 30 }])
    const r = await host.invokeBackground('demo', new AbortController().signal)
    expect(r.content).toBe('background')
    host.setBackground('demo', false)
    expect(host.backgroundPlugins()).toEqual([])
  })

  it('never offers the background tool to a model', async () => {
    writePlugin({}, withSync())
    await activate(SYNC)
    host.setChatDesign('demo', true)
    for (const mode of ['code', 'chat'] as const)
      expect(host.toolSet(mode).tools.map((t) => t.name)).not.toContain('demo__config')
    expect(host.readToolSet(['demo']).tools.map((t) => t.name)).not.toContain('demo__config')
  })

  it('can’t be turned on without the permission, and stops when the plugin is disabled', async () => {
    writePlugin({}, withSync())
    await activate(SYNC)
    host.setBackground('demo', true)
    host.disable('demo')
    expect(host.backgroundPlugins()).toEqual([])
    writePlugin({}, manifest())
    await activate(ALL)
    expect(() => host.setBackground('demo', true)).toThrow(/no background sync/)
  })
})
