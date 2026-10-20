import { execFile, spawn, type ChildProcess } from 'child_process'
import { randomBytes } from 'crypto'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ScriptManifest } from './manifest'

// Starts one script process and watches it: input as JSON on stdin, nothing
// from the model on the command line, no shell, a timeout, a cap on output,
// and Stop that ends the whole process tree (Scrapling's browser fetchers
// start Chromium, so killing only Python would leave browsers running).
//
// None of this contains the script. It runs as the user.

export const RESULT_MARK = '@custard-result '
export const OUTPUT_LIMITS = {
  stdout: 2 * 1024 * 1024,
  stderrTail: 16 * 1024,
  stdoutTail: 4 * 1024
}

export type Ended = 'exit' | 'timeout' | 'stopped' | 'output-limit' | 'spawn-failed'

export type RunSpec = {
  file: string
  args: string[]
  cwd: string
  env: Record<string, string>
  stdin: string
  timeoutMs: number
  maxStdout?: number
  signal?: AbortSignal
  platform?: NodeJS.Platform
}

export type RunOutcome = {
  ended: Ended
  exitCode: number | null
  stdout: string
  stderrTail: string
  durationMs: number
  spawnError?: string
}

// Ends the process and everything it started. POSIX: the child leads its own
// process group (spawned detached), so the group is killed. Windows:
// taskkill /T walks the tree.
export function killTree(child: ChildProcess, platform: NodeJS.Platform): void {
  if (child.pid === undefined || child.exitCode !== null) return
  if (platform === 'win32') {
    execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {
      if (child.exitCode === null) child.kill()
    })
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      child.kill('SIGKILL')
    }
  }
}

export function runProcess(spec: RunSpec): Promise<RunOutcome> {
  const platform = spec.platform ?? process.platform
  const maxStdout = spec.maxStdout ?? OUTPUT_LIMITS.stdout
  const started = Date.now()
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      child = spawn(spec.file, spec.args, {
        cwd: spec.cwd,
        env: spec.env,
        shell: false,
        windowsHide: true,
        detached: platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe']
      })
    } catch (err) {
      resolve({
        ended: 'spawn-failed',
        exitCode: null,
        stdout: '',
        stderrTail: '',
        durationMs: 0,
        spawnError: (err as Error).message
      })
      return
    }
    const out: Buffer[] = []
    let outBytes = 0
    let errTail = ''
    let ended: Ended | null = null
    let done = false
    const stop = (why: Ended): void => {
      if (ended) return
      ended = why
      killTree(child, platform)
    }
    const timer = setTimeout(() => stop('timeout'), spec.timeoutMs)
    const onAbort = (): void => stop('stopped')
    if (spec.signal?.aborted) onAbort()
    spec.signal?.addEventListener('abort', onAbort)

    child.stdout!.on('data', (b: Buffer) => {
      if (outBytes >= maxStdout) return
      outBytes += b.length
      out.push(outBytes > maxStdout ? b.subarray(0, b.length - (outBytes - maxStdout)) : b)
      if (outBytes > maxStdout) stop('output-limit')
    })
    child.stderr!.on('data', (b: Buffer) => {
      errTail = (errTail + b.toString('utf8')).slice(-OUTPUT_LIMITS.stderrTail)
    })
    // A script that exits without reading its input closes stdin early.
    child.stdin!.on('error', () => {})
    child.stdin!.end(spec.stdin)

    const finish = (exitCode: number | null, spawnError?: string): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      spec.signal?.removeEventListener('abort', onAbort)
      resolve({
        ended: spawnError ? 'spawn-failed' : (ended ?? 'exit'),
        exitCode,
        stdout: Buffer.concat(out).toString('utf8'),
        stderrTail: errTail,
        durationMs: Date.now() - started,
        ...(spawnError ? { spawnError } : {})
      })
    }
    child.on('error', (err) => finish(null, err.message))
    // 'close' waits for the pipes too. A grandchild that escaped the kill can
    // hold them open, so don't wait for it longer than a moment after exit.
    child.on('exit', (code) => {
      const t = setTimeout(() => {
        child.stdout?.destroy()
        child.stderr?.destroy()
        finish(code)
      }, 2000)
      child.on('close', () => {
        clearTimeout(t)
        finish(code)
      })
    })
  })
}

export type ParsedResult = { ok: true; result: unknown } | { ok: false; error: string }

// The last line starting with RESULT_MARK is the answer; everything else on
// stdout is the script's own printing and only goes to the run record.
export function parseResult(stdout: string): ParsedResult | null {
  const lines = stdout.split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith(RESULT_MARK)) continue
    try {
      const v = JSON.parse(lines[i].slice(RESULT_MARK.length)) as Record<string, unknown>
      if (v && v.ok === true && 'result' in v) return { ok: true, result: v.result }
      if (v && v.ok === false)
        return { ok: false, error: typeof v.error === 'string' ? v.error : 'The script failed.' }
    } catch {
      // Not valid JSON: fall through to "no result".
    }
    return null
  }
  return null
}

// How to start a script's approved entry. Python: -E (ignore PYTHON*
// variables), -s (no user site-packages), -B and a pycache prefix that never
// exists, so no .pyc is written or read from the approved copy. Not -I: that
// also drops the script's own folder from the import path.
export function commandFor(
  m: ScriptManifest,
  o: { interpreter: string; approvedDir: string; tool: string }
): { file: string; args: string[] } {
  const entry = join(o.approvedDir, ...m.entry.split('/'))
  if (m.runtime === 'python') {
    const noCache = join(tmpdir(), `custard-no-pycache-${randomBytes(6).toString('hex')}`)
    return {
      file: o.interpreter,
      args: ['-E', '-s', '-B', '-X', 'utf8', '-X', `pycache_prefix=${noCache}`, entry, o.tool]
    }
  }
  return { file: o.interpreter, args: [entry, o.tool] }
}
