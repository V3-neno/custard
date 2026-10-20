import { execFileSync } from 'child_process'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { beforeAll, describe, expect, it } from 'vitest'
import { NODE_HELPER, NODE_HELPER_NAME, PY_HELPER, PY_HELPER_NAME } from './helpers'
import { ScriptHost } from './host'
import { discover, type Interpreter } from './interpreters'
import { parseResult } from './runner'
import { ScriptStore, SnapshotError } from './store'

// Real Python and Node processes in temporary folders. These check what the
// runner controls (approval, input, environment, limits, Stop); none of them
// claim the script is contained.

let python: Interpreter
let node: Interpreter

beforeAll(async () => {
  python = (await discover('python'))[0]
  node = (await discover('node'))[0]
  expect(python, 'Python must be installed for these tests').toBeTruthy()
  expect(node, 'Node must be installed for these tests').toBeTruthy()
})

const tool = (name: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  name,
  description: `${name} tool`,
  inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
  effect: 'read',
  ...extra
})

const PY_MAIN = `import os, subprocess, sys, time
from custard_script import run

def echo(input):
    return {"echo": input.get("text"), "cwd": os.getcwd()}

def env(input):
    return sorted(os.environ.keys())

def boom(input):
    raise ValueError("bad selector")

def slow(input):
    time.sleep(30)
    return "late"

def tree(input):
    # A child that would outlive Python if only Python were killed.
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
    with open(input["text"], "w") as f:
        f.write(str(child.pid))
    time.sleep(60)

def flood(input):
    sys.stdout.write("x" * (3 * 1024 * 1024))
    sys.stdout.flush()
    return "done"

def noresult(input):
    print("just printing")
    sys.exit(0)

def chatty(input):
    print("progress 1")
    print("@custard-result not json")
    return {"n": 1}

run({"echo": echo, "env": env, "boom": boom, "slow": slow, "tree": tree, "flood": flood,
     "noresult": lambda i: os._exit(0), "chatty": chatty})
`

function makeScript(
  store: ScriptStore,
  id: string,
  o: { runtime?: 'python' | 'node'; main?: string; tools?: unknown[]; minVersion?: string } = {}
): void {
  const src = store.srcDir(id)
  mkdirSync(src, { recursive: true })
  const runtime = o.runtime ?? 'python'
  const entry = runtime === 'python' ? 'main.py' : 'main.mjs'
  writeFileSync(
    join(src, 'script.json'),
    JSON.stringify({
      name: id,
      version: '0.1.0',
      runtime,
      entry,
      ...(o.minVersion ? { minVersion: o.minVersion } : {}),
      tools: o.tools ?? [
        tool('echo'),
        tool('env'),
        tool('boom'),
        tool('slow', { timeoutMs: 1500 }),
        tool('tree', { timeoutMs: 1500 }),
        tool('flood'),
        tool('noresult'),
        tool('chatty')
      ]
    })
  )
  if (runtime === 'python') {
    writeFileSync(join(src, PY_HELPER_NAME), PY_HELPER)
    writeFileSync(join(src, 'main.py'), o.main ?? PY_MAIN)
  } else {
    writeFileSync(join(src, NODE_HELPER_NAME), NODE_HELPER)
    writeFileSync(join(src, 'main.mjs'), o.main ?? '')
  }
}

function setup(o: { enabled?: boolean; env?: NodeJS.ProcessEnv } = {}): {
  store: ScriptStore
  host: ScriptHost
  flags: { enabled: boolean }
} {
  const store = new ScriptStore(mkdtempSync(join(tmpdir(), 'custard-scripts-')))
  const flags = { enabled: o.enabled ?? true }
  const host = new ScriptHost(store, {
    enabled: () => flags.enabled,
    interpreter: (r) => (r === 'python' ? python : node),
    env: o.env ?? process.env
  })
  return { store, host, flags }
}

function approved(store: ScriptStore, id: string): void {
  store.approve(id, store.review(id).digest)
  store.setState(id, { enabled: true })
}

// A killed process nobody has reaped yet (a zombie, common in containers
// where PID 1 doesn't reap) still answers kill(0), so read its state too.
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  try {
    return !/^State:\s+Z/m.test(readFileSync(`/proc/${pid}/status`, 'utf8'))
  } catch {
    return true
  }
}

describe('approval', () => {
  it('runs only the approved copy, never the source', async () => {
    const { store, host } = setup()
    makeScript(store, 'demo')
    approved(store, 'demo')
    appendFileSync(join(store.srcDir('demo'), 'main.py'), '\nraise SystemExit("edited")\n')
    const r = await host.run('demo', 'echo', { text: 'hi' }, { caller: 'assistant' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.result).toMatchObject({ echo: 'hi' })
  })

  it('refuses to approve when the source changed after review', () => {
    const { store } = setup()
    makeScript(store, 'demo')
    const { digest } = store.review('demo')
    appendFileSync(join(store.srcDir('demo'), 'main.py'), '\n# changed\n')
    expect(() => store.approve('demo', digest)).toThrow(/changed after you reviewed/)
    expect(store.state('demo').approval).toBeNull()
  })

  it('refuses to run when the approved copy was changed or a .pyc was planted', async () => {
    const { store, host } = setup()
    makeScript(store, 'demo')
    approved(store, 'demo')
    appendFileSync(join(store.approvedDir('demo'), 'main.py'), '\n# tampered\n')
    let r = await host.run('demo', 'echo', {}, { caller: 'assistant' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/changed since you approved/)

    approved(store, 'demo')
    mkdirSync(join(store.approvedDir('demo'), '__pycache__'))
    writeFileSync(join(store.approvedDir('demo'), '__pycache__', 'main.cpython-313.pyc'), 'x')
    r = await host.run('demo', 'echo', {}, { caller: 'assistant' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/generated files/)
  })

  it('does not write bytecode into the approved copy', async () => {
    const { store, host } = setup()
    makeScript(store, 'demo')
    approved(store, 'demo')
    expect((await host.run('demo', 'echo', {}, { caller: 'assistant' })).ok).toBe(true)
    expect(existsSync(join(store.approvedDir('demo'), '__pycache__'))).toBe(false)
    // So it keeps running.
    expect((await host.run('demo', 'echo', {}, { caller: 'assistant' })).ok).toBe(true)
  })

  it('refuses links, secret-looking files and dependency folders in the source', () => {
    const { store } = setup()
    makeScript(store, 'demo')
    writeFileSync(join(store.srcDir('demo'), '.env'), 'KEY=1')
    expect(() => store.review('demo')).toThrow(SnapshotError)

    makeScript(store, 'two')
    symlinkSync('/etc/hostname', join(store.srcDir('two'), 'link.txt'))
    expect(() => store.review('two')).toThrow(/links/)

    makeScript(store, 'three')
    mkdirSync(join(store.srcDir('three'), 'node_modules'))
    expect(() => store.review('three')).toThrow(/dependencies/)
  })
})

describe('switches and checks before running', () => {
  it('refuses everything while Scripts is off, or the script is off or unapproved', async () => {
    const { store, host, flags } = setup({ enabled: false })
    makeScript(store, 'demo')
    let r = await host.run('demo', 'echo', {}, { caller: 'assistant' })
    expect(!r.ok && r.error).toMatch(/turned off in Settings/)
    flags.enabled = true
    r = await host.run('demo', 'echo', {}, { caller: 'assistant' })
    expect(!r.ok && r.error).toMatch(/script is turned off/)
    store.setState('demo', { enabled: true })
    r = await host.run('demo', 'echo', {}, { caller: 'assistant' })
    expect(!r.ok && r.error).toMatch(/not been approved/)
  })

  it('checks the tool, the input and the interpreter version', async () => {
    const { store, host } = setup()
    makeScript(store, 'demo')
    approved(store, 'demo')
    let r = await host.run('demo', 'nope', {}, { caller: 'assistant' })
    expect(!r.ok && r.error).toMatch(/no tool "nope"/)
    r = await host.run('demo', 'echo', { text: 5 }, { caller: 'assistant' })
    expect(!r.ok && r.error).toMatch(/Invalid input: input.text must be a string/)

    makeScript(store, 'future', { minVersion: '99' })
    approved(store, 'future')
    r = await host.run('future', 'echo', {}, { caller: 'assistant' })
    expect(!r.ok && r.error).toMatch(/needs Python 99 or newer/)
  })
})

describe('running', () => {
  it('passes input on stdin and runs in the work folder', async () => {
    const { store, host } = setup()
    makeScript(store, 'demo')
    approved(store, 'demo')
    const text = 'a "quoted" $(not a shell) ; & | value'
    const r = await host.run('demo', 'echo', { text }, { caller: 'assistant' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.result).toEqual({ echo: text, cwd: store.workDir('demo') })
    expect(r.record.caller).toBe('assistant')
    expect(store.runs('demo')[0]).toMatchObject({ tool: 'echo', ok: true, ended: 'exit' })
  })

  it("doesn't pass Custard's keys or loader variables", async () => {
    const { store, host } = setup({
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: 'sk-ant',
        NODE_OPTIONS: '--no-warnings',
        PYTHONPATH: '/x'
      }
    })
    makeScript(store, 'demo')
    approved(store, 'demo')
    const r = await host.run(
      'demo',
      'env',
      {},
      { caller: 'assistant', extraEnv: { SCRAPER_MODE: 'fast' } }
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const keys = r.result as string[]
    expect(keys).toContain('PATH')
    expect(keys).toContain('SCRAPER_MODE')
    for (const k of ['ANTHROPIC_API_KEY', 'NODE_OPTIONS', 'PYTHONPATH'])
      expect(keys).not.toContain(k)
  })

  it('reports script errors briefly and keeps the traceback in the record', async () => {
    const { store, host } = setup()
    makeScript(store, 'demo')
    approved(store, 'demo')
    const r = await host.run('demo', 'boom', {}, { caller: 'assistant' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toBe('The script reported an error: ValueError: bad selector')
    expect(r.record?.stderrTail).toMatch(/Traceback/)
  })

  it('uses the last result line and ignores other printing', async () => {
    const { store, host } = setup()
    makeScript(store, 'demo')
    approved(store, 'demo')
    const r = await host.run('demo', 'chatty', {}, { caller: 'assistant' })
    expect(r.ok && r.result).toEqual({ n: 1 })
    expect(parseResult('@custard-result {"ok":true}')).toBeNull()
  })

  it('stops a script at its timeout', async () => {
    const { store, host } = setup()
    makeScript(store, 'demo')
    approved(store, 'demo')
    const t = Date.now()
    const r = await host.run('demo', 'slow', {}, { caller: 'assistant' })
    expect(Date.now() - t).toBeLessThan(10_000)
    expect(!r.ok && r.error).toMatch(/didn't finish within 2 seconds/)
    expect(r.record?.ended).toBe('timeout')
  })

  it('kills the whole process tree, not just the interpreter', async () => {
    const { store, host } = setup()
    makeScript(store, 'demo')
    approved(store, 'demo')
    const pidFile = join(mkdtempSync(join(tmpdir(), 'custard-pid-')), 'pid')
    const r = await host.run('demo', 'tree', { text: pidFile }, { caller: 'assistant' })
    expect(r.record?.ended).toBe('timeout')
    const pid = Number(readFileSync(pidFile, 'utf8'))
    await new Promise((res) => setTimeout(res, 300))
    expect(alive(pid)).toBe(false)
  })

  it('stops on the caller signal and on Stop', async () => {
    const { store, host } = setup()
    makeScript(store, 'demo', { tools: [tool('slow', { timeoutMs: 20_000 })] })
    approved(store, 'demo')
    const ac = new AbortController()
    const p = host.run('demo', 'slow', {}, { caller: 'assistant', signal: ac.signal })
    setTimeout(() => ac.abort(), 300)
    expect((await p).record?.ended).toBe('stopped')

    const q = host.run('demo', 'slow', {}, { caller: 'assistant' })
    await new Promise((res) => setTimeout(res, 300))
    expect(host.runningIds()).toEqual(['demo'])
    expect(host.stop()).toBe(1)
    const r = await q
    expect(!r.ok && r.error).toBe('The script was stopped.')
    expect(host.runningIds()).toEqual([])
  })

  it('stops a script that prints too much', async () => {
    const { store, host } = setup()
    makeScript(store, 'demo')
    approved(store, 'demo')
    const r = await host.run('demo', 'flood', {}, { caller: 'assistant' })
    expect(r.record?.ended).toBe('output-limit')
    expect(r.record!.stdoutTail.length).toBeLessThanOrEqual(4096)
  })

  it('says so when a script ends without a result', async () => {
    const { store, host } = setup()
    makeScript(store, 'demo')
    approved(store, 'demo')
    const r = await host.run('demo', 'noresult', {}, { caller: 'assistant' })
    expect(!r.ok && r.error).toMatch(/ended without a result/)
  })

  it('runs one script at a time by default', async () => {
    const { store, host } = setup()
    makeScript(store, 'demo', { tools: [tool('slow', { timeoutMs: 20_000 }), tool('echo')] })
    approved(store, 'demo')
    const first = host.run('demo', 'slow', {}, { caller: 'assistant' })
    await new Promise((res) => setTimeout(res, 200))
    const second = await host.run('demo', 'echo', {}, { caller: 'assistant' })
    expect(!second.ok && second.error).toMatch(/Another script is still running/)
    host.stop('demo')
    await first
  })

  it('prefers the script venv when one exists', async () => {
    const { store, host } = setup()
    makeScript(store, 'demo')
    approved(store, 'demo')
    execFileSync(python.path, ['-m', 'venv', '--without-pip', store.envDir('demo')])
    const m = store.verifyApproved('demo')
    const r = host.resolveInterpreter(m)
    expect('path' in r && r.path.startsWith(store.envDir('demo'))).toBe(true)
    expect((await host.run('demo', 'echo', { text: 'v' }, { caller: 'assistant' })).ok).toBe(true)
  })
})

describe('Node scripts', () => {
  it('run with the helper, get stdin input and report errors', async () => {
    const { store, host } = setup()
    makeScript(store, 'js', {
      runtime: 'node',
      main: `import { run } from './custard-script.mjs'
run({
  echo: async (input) => ({ echo: input.text, cwd: process.cwd(), keys: Object.keys(process.env) }),
  boom: () => { throw new Error('nope') }
})
`,
      tools: [tool('echo'), tool('boom')]
    })
    approved(store, 'js')
    const r = await host.run('js', 'echo', { text: 'hej' }, { caller: 'assistant' })
    expect(r.ok).toBe(true)
    if (r.ok) {
      const v = r.result as { echo: string; cwd: string; keys: string[] }
      expect(v.echo).toBe('hej')
      expect(v.cwd).toBe(store.workDir('js'))
      expect(v.keys).not.toContain('NODE_OPTIONS')
    }
    const b = await host.run('js', 'boom', {}, { caller: 'assistant' })
    expect(!b.ok && b.error).toBe('The script reported an error: nope')
  })
})

describe('uninstall', () => {
  it('removes the approval and what Custard made, keeping the source', async () => {
    const { store, host } = setup()
    makeScript(store, 'demo')
    approved(store, 'demo')
    await host.run('demo', 'echo', {}, { caller: 'assistant' })
    store.uninstall('demo')
    expect(existsSync(store.srcDir('demo'))).toBe(true)
    expect(existsSync(store.approvedDir('demo'))).toBe(false)
    expect(store.state('demo')).toEqual({ enabled: false, useInChat: false, approval: null })
    expect(store.runs('demo')).toEqual([])
  })
})
