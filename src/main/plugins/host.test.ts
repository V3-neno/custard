import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import vm from 'vm'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  PluginHost,
  type ApprovalRequest,
  type RuntimeFactory,
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
    config: unknown
  ): Promise<{ content: string; isError: boolean }>
  cancel(callId: string): void
  tools(): string[]
}

let runtimeStarts = 0
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
      call: async (callId, tool, input, config, _timeoutMs, signal) => {
        if (dead) return { content: 'not running', isError: true }
        signal.addEventListener('abort', () => bridge.cancel(callId))
        return bridge.call(callId, tool, JSON.parse(JSON.stringify(input)), config)
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
      openExternal: ['demo:'],
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
          properties: { url: { type: 'string' }, auth: { type: 'boolean' } }
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
        effect: 'read',
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
    call_api: async ({ url, auth }, ctx) => {
      const r = await ctx.fetch(url, { auth })
      return 'status ' + r.status + ' ' + (await r.text())
    },
    act: ({ text }) => { (globalThis as any).actCalls = ((globalThis as any).actCalls ?? 0) + 1; return 'done ' + text },
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
  exits = []
  ask = true
  store = new PluginStore(join(base, 'data'), crypto)
  host = new PluginHost({
    sourceRoot: () => src,
    sdkDir: SDK,
    store,
    runtime: vmRuntime,
    testRunner: async (code) => {
      const ctx = vm.createContext({ setTimeout, console, AbortController, URL })
      vm.runInContext(code, ctx)
      return vm.runInContext('globalThis.__custardRunTests()', ctx)
    },
    openExternal: async (u) => void opened.push(u),
    openBrowser: async () => {},
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
  'open:demo:',
  'storage',
  'account:auth.example.com',
  'account-scope:read',
  'action:act'
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
  host.invoke(name, input, { snapshot: snapshot ?? host.toolSet().snapshot, signal, approve })

describe('validation and review', () => {
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

describe('activation and permissions', () => {
  it('requires every requested permission to be approved', async () => {
    writePlugin({})
    const r = await host.review('demo')
    await expect(host.activate('demo', r.buildId!, ALL.slice(1))).rejects.toThrow(
      /Approve these permissions/
    )
    expect(host.toolSet().tools).toEqual([])
  })

  it('registers namespaced tools and instructions once active', async () => {
    writePlugin({})
    await activate()
    const set = host.toolSet()
    expect(set.tools.map((t) => t.name)).toContain('demo__echo')
    expect(set.tools.every((t) => /^[a-zA-Z0-9_-]{1,64}$/.test(t.name))).toBe(true)
    expect(set.instructions[0]).toContain('Use demo tools carefully.')
    expect(await invoke('demo__echo', { text: 'you' })).toEqual({
      content: 'hello you',
      isError: false
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
      isError: false
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
    const stale = host.toolSet().snapshot
    host.disable('demo')
    expect(host.toolSet().tools).toEqual([])
    const r = await invoke('demo__act', { text: 'x' }, stale)
    expect(r).toEqual({
      content: 'The demo plugin is disabled, so this call was not run.',
      isError: true
    })
  })

  it('rejects calls offered by an older build after an update', async () => {
    writePlugin({})
    await activate()
    const stale = host.toolSet().snapshot
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
    expect((await invoke('demo__open', { url: 'demo:item/1' })).content).toBe('opened')
    expect((await invoke('demo__open', { url: 'file:///etc/passwd' })).content).toMatch(
      /may not open/
    )
    expect(opened).toEqual(['demo:item/1'])
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
    'account:accounts.spotify.com',
    'account-scope:user-read-playback-state',
    'account-scope:user-read-currently-playing',
    'account-scope:user-modify-playback-state',
    'action:add_to_queue',
    'action:open',
    'action:transfer_playback'
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
