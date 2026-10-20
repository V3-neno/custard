import { existsSync, mkdirSync } from 'fs'
import { validate } from '../plugins/schema'
import { scriptEnv } from './env'
import { venvPython, type Interpreter } from './interpreters'
import { TIMEOUT, versionAtLeast, type ScriptManifest, type ScriptRuntime } from './manifest'
import { commandFor, OUTPUT_LIMITS, parseResult, runProcess, type Ended } from './runner'
import { SnapshotError, type RunRecord, type ScriptStore } from './store'

// Runs a script's tool after every check that doesn't depend on the chat:
// Scripts switched on, the script enabled, its approved copy unchanged, the
// tool declared, the input valid, an interpreter that's new enough, and a free
// slot. Asking the user (approval cards) and fencing the result for the model
// happen in the chat layer, which calls this only after the user said yes.

export type ScriptCaller = 'assistant' | 'test'

export type HostOptions = {
  // Settings → Scripts. Off by default; turning it off stops running scripts.
  enabled: () => boolean
  interpreter: (runtime: ScriptRuntime) => Interpreter | null
  maxConcurrent?: () => number
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  now?: () => number
}

export type RunResult =
  | { ok: true; result: unknown; record: RunRecord }
  | { ok: false; error: string; record: RunRecord | null }

export const MAX_CONCURRENT = { default: 1, max: 3 }

export class ScriptHost {
  private running = new Map<string, { id: string; controller: AbortController }>()
  private seq = 0

  constructor(
    readonly store: ScriptStore,
    private o: HostOptions
  ) {}

  private get platform(): NodeJS.Platform {
    return this.o.platform ?? process.platform
  }

  private limit(): number {
    const n = this.o.maxConcurrent?.() ?? MAX_CONCURRENT.default
    return Math.min(MAX_CONCURRENT.max, Math.max(1, Math.floor(n) || 1))
  }

  runningIds(): string[] {
    return [...new Set([...this.running.values()].map((r) => r.id))]
  }

  // Stops every run of one script, or of all scripts.
  stop(id?: string): number {
    let n = 0
    for (const r of this.running.values())
      if (!id || r.id === id) {
        r.controller.abort()
        n++
      }
    return n
  }

  // Which interpreter a script would use now; the reason if none.
  resolveInterpreter(m: ScriptManifest): { path: string } | { error: string } {
    const base = this.o.interpreter(m.runtime)
    const label = m.runtime === 'python' ? 'Python' : 'Node.js'
    if (!base) return { error: `${label} isn't set up. Choose it in Settings → Scripts.` }
    if (!versionAtLeast(base.version, m.minVersion))
      return {
        error: `This script needs ${label} ${m.minVersion} or newer; Settings → Scripts uses ${base.version.join('.')}.`
      }
    if (m.runtime === 'python') {
      const venv = venvPython(this.store.envDir(m.id), this.platform)
      if (existsSync(venv)) return { path: venv }
    }
    return { path: base.path }
  }

  async run(
    id: string,
    tool: string,
    input: unknown,
    o: {
      caller: ScriptCaller
      signal?: AbortSignal
      extraEnv?: Record<string, string>
      // The approval the caller offered or showed: a different one (the
      // script was approved again meanwhile) doesn't run.
      expectDigest?: string
    }
  ): Promise<RunResult> {
    const refuse = (error: string): RunResult => ({ ok: false, error, record: null })
    if (!this.o.enabled()) return refuse('Scripts are turned off in Settings → Scripts.')
    let manifest: ScriptManifest
    try {
      if (!this.store.state(id).enabled) return refuse('This script is turned off.')
      manifest = this.store.verifyApproved(id, o.expectDigest)
    } catch (err) {
      return refuse(
        err instanceof SnapshotError ? err.message : `Script error: ${(err as Error).message}`
      )
    }
    const spec = manifest.tools.find((t) => t.name === tool)
    if (!spec) return refuse(`This script has no tool "${tool}".`)
    const problems = validate(spec.inputSchema, input ?? {})
    if (problems.length) return refuse(`Invalid input: ${problems.slice(0, 5).join('; ')}`)
    const interp = this.resolveInterpreter(manifest)
    if ('error' in interp) return refuse(interp.error)
    if (this.running.size >= this.limit())
      return refuse('Another script is still running. Wait for it or stop it.')

    const key = `${id}#${++this.seq}`
    const controller = new AbortController()
    const onOuter = (): void => controller.abort()
    if (o.signal?.aborted) controller.abort()
    o.signal?.addEventListener('abort', onOuter)
    this.running.set(key, { id, controller })
    const now = this.o.now ?? Date.now
    const at = now()
    try {
      const cwd = this.store.workDir(id)
      mkdirSync(cwd, { recursive: true })
      const cmd = commandFor(manifest, {
        interpreter: interp.path,
        approvedDir: this.store.approvedDir(id),
        tool
      })
      const outcome = await runProcess({
        ...cmd,
        cwd,
        env: scriptEnv(this.o.env ?? process.env, { platform: this.platform, extra: o.extraEnv }),
        stdin: JSON.stringify({ tool, input: input ?? {} }),
        timeoutMs: Math.min(TIMEOUT.max, spec.timeoutMs ?? TIMEOUT.default),
        signal: controller.signal,
        platform: this.platform
      })
      const parsed = outcome.ended === 'exit' ? parseResult(outcome.stdout) : null
      const error = parsed?.ok
        ? undefined
        : describeFailure(
            outcome.ended,
            outcome.exitCode,
            parsed,
            outcome.spawnError,
            spec.timeoutMs
          )
      const record: RunRecord = {
        at,
        tool,
        input: input ?? {},
        caller: o.caller,
        ok: !!parsed?.ok,
        answered: parsed !== null,
        ...(error ? { error } : {}),
        exitCode: outcome.exitCode,
        ended: outcome.ended,
        durationMs: outcome.durationMs,
        stdoutTail: outcome.stdout.slice(-OUTPUT_LIMITS.stdoutTail),
        stderrTail: outcome.stderrTail
      }
      try {
        this.store.addRun(id, record)
      } catch (err) {
        console.error('Could not save the script run record', err)
      }
      return parsed?.ok
        ? { ok: true, result: parsed.result, record }
        : { ok: false, error: error!, record }
    } finally {
      o.signal?.removeEventListener('abort', onOuter)
      this.running.delete(key)
    }
  }
}

function describeFailure(
  ended: Ended,
  exitCode: number | null,
  parsed: ReturnType<typeof parseResult>,
  spawnError: string | undefined,
  timeoutMs: number | undefined
): string {
  switch (ended) {
    case 'timeout':
      return `The script didn't finish within ${Math.round((timeoutMs ?? TIMEOUT.default) / 1000)} seconds and was stopped.`
    case 'stopped':
      return 'The script was stopped.'
    case 'output-limit':
      return 'The script printed more than 2 MB and was stopped.'
    case 'spawn-failed':
      return `The script couldn't start: ${spawnError ?? 'unknown error'}`
    default:
      if (parsed && !parsed.ok) return `The script reported an error: ${parsed.error}`
      return exitCode === 0
        ? "The script ended without a result. Use the helper's run() to return one."
        : `The script ended with exit code ${exitCode} and no result. Its error output is in the run record.`
  }
}
