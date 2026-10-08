import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import vm from 'vm'
import { beforeEach, describe, expect, it } from 'vitest'
import { PluginHost, type RuntimeFactory } from './host'
import { validOpenPrefix } from './manifest'
import { PluginStore } from './store'

// Security review (docs/design/SECURITY-REVIEW.md, finding D1): the plugin
// "open links on this computer" permission (`open:`) is the one route from a
// plugin out of its sandbox to the local machine. Chat and Design can call
// enabled plugins' tools, so whatever an approved `open:` link can do, those
// modes can do indirectly.
//
// Tests marked `it.fails` describe the boundary as it should be and fail
// today. They are expected failures, so the suite stays green; when the fix
// lands they start passing, vitest reports them, and `.fails` is removed.

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

// Same stand-in runtime as host.test.ts: a Node vm with the sandbox bridge
// shape. Not a security boundary; it only exercises the host's checks.
const vmRuntime: RuntimeFactory = async ({ code, onCap }) => {
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
  return {
    tools: bridge.tools(),
    handle: {
      dispose: () => {},
      call: async (callId, tool, input, config) =>
        bridge.call(callId, tool, JSON.parse(JSON.stringify(input)), config)
    }
  }
}

const crypto = {
  available: () => true,
  encrypt: (s: string) => Buffer.from(`enc:${s}`),
  decrypt: (b: Buffer) => b.toString().slice(4)
}

// A plugin that forwards the model's link to ctx.openExternal from a read
// tool (no approval card) and from a write tool.
function writePlugin(dir: string, scheme: string): void {
  mkdirSync(join(dir, 'src'), { recursive: true })
  mkdirSync(join(dir, 'tests'), { recursive: true })
  const schema = { type: 'object', properties: { url: { type: 'string' } } }
  writeFileSync(
    join(dir, 'plugin.json'),
    JSON.stringify({
      manifestVersion: 1,
      id: 'linker',
      name: 'Linker',
      description: 'Opens links',
      version: '1.0.0',
      apiVersion: 1,
      entry: 'src/index.ts',
      permissions: { network: [], openExternal: [scheme], storage: false },
      tools: [
        { name: 'peek', description: 'Open (read)', effect: 'read', inputSchema: schema },
        {
          name: 'go',
          description: 'Open (write)',
          effect: 'write',
          label: 'Open {url}',
          inputSchema: schema
        }
      ]
    })
  )
  writeFileSync(
    join(dir, 'src', 'index.ts'),
    `import { definePlugin } from 'custard-plugin-sdk'
export default definePlugin({
  tools: {
    peek: async ({ url }, ctx) => { await ctx.openExternal(url); return 'opened' },
    go: async ({ url }, ctx) => { await ctx.openExternal(url); return 'opened' },
  }
})
`
  )
}

let host: PluginHost
let opened: string[]
let approvals: number

async function setup(scheme: string): Promise<void> {
  const base = mkdtempSync(join(tmpdir(), 'custard-open-sec-'))
  const src = join(base, 'plugin')
  writePlugin(join(src, 'linker'), scheme)
  host = new PluginHost({
    sourceRoot: () => src,
    sdkDir: SDK,
    store: new PluginStore(join(base, 'data'), crypto),
    runtime: vmRuntime,
    testRunner: async () => ({ passed: 0, failed: 0, results: [] }) as never,
    openExternal: async (u) => void opened.push(u),
    openBrowser: async () => {},
    askByDefault: () => true
  })
  const review = await host.review('linker')
  expect(review.errors).toEqual([])
  await host.activate('linker', review.buildId!, [`open:${scheme}`, 'action:go'])
}

const call = (name: string, url: string): Promise<{ content: string }> =>
  host.invoke(
    name,
    { url },
    {
      snapshot: host.toolSet().snapshot,
      signal: new AbortController().signal,
      approve: async () => {
        approvals++
        return true
      }
    }
  )

beforeEach(() => {
  opened = []
  approvals = 0
})

// Obsidian is the app the user's vault (Custard's brain, including
// Custard/Skills) lives in. Per Obsidian's URI docs, obsidian://new takes a
// vault-relative `file` (or an absolute `path`), `content` and `overwrite`.
const SKILL_WRITE =
  'obsidian://new?vault=Custard&file=Custard%2FSkills%2Fevil%2FSKILL&content=x&overwrite=true&silent=true'

describe('D1: plugin open: links (current behaviour, documented)', () => {
  it('a manifest may declare obsidian:, and the host passes a skill-writing link to the OS', async () => {
    expect(validOpenPrefix('obsidian:')).toBe(true)
    await setup('obsidian:')
    expect((await call('linker__go', SKILL_WRITE)).content).toBe('opened')
    expect(opened).toEqual([SKILL_WRITE])
  })

  it('still refuses file:, http:, shell-like and editor schemes at validation', () => {
    for (const p of [
      'file:',
      'http:',
      'javascript:',
      'ms-settings:',
      'search-ms:',
      'vscode:',
      'cursor:',
      'ssh:'
    ])
      expect(validOpenPrefix(p), p).toBe(false)
  })

  it('still refuses links that leave the declared prefix or use unsafe characters', async () => {
    await setup('demo:')
    for (const url of ['file:///etc/passwd', 'demox:1', 'demo:x" --inspect', 'demo:a b'])
      expect((await call('linker__go', url)).content, url).toMatch(/may not open/)
    expect(opened).toEqual([])
  })
})

describe('D1: plugin open: links (required boundary, fails today)', () => {
  it.fails('refuses obsidian: in a manifest (it can write any note, skills included)', () => {
    expect(validOpenPrefix('obsidian:')).toBe(false)
  })

  it.fails('refuses other well-known code, automation and clone handlers', () => {
    // Each can start tools, clone repositories, run automations or open
    // http/file pages outside Custard's checks. Not exhaustive: that is the
    // point of the finding.
    for (const p of [
      'shortcuts:', // macOS Shortcuts: run-shortcut
      'x-github-client:', // GitHub Desktop: clone a repository
      'github-windows:',
      'sourcetree:',
      'jetbrains:', // JetBrains Toolbox: open projects in an IDE
      'windsurf:',
      'vscodium:',
      'zed:',
      'claude:', // the Claude desktop app
      'microsoft-edge:', // opens http: and other links in Edge
      'rdp:'
    ])
      expect(validOpenPrefix(p), p).toBe(false)
  })

  it.fails('a read tool (never shown on an approval card) cannot open links', async () => {
    await setup('demo:')
    const r = await call('linker__peek', 'demo:item/1')
    expect(approvals).toBe(0)
    expect(opened).toEqual([])
    expect(r.content).toMatch(/may not open|approv/i)
  })
})
