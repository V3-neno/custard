import { execFile } from 'child_process'
import { existsSync, statSync } from 'fs'
import { join, win32, posix } from 'path'
import { scriptEnv } from './env'
import type { ScriptRuntime } from './manifest'

// Finds the user's Python and Node. Custard never ships or downloads an
// interpreter, and never uses its own Electron as Node (release builds turn
// off the runAsNode fuse, and that stays off).
//
// Windows: the Python launcher's list (`py -0p`), then python.exe on PATH,
// skipping the Microsoft Store alias in ...\Microsoft\WindowsApps (it opens
// the Store instead of running Python). Every candidate is started once to
// read its real version; the newest wins.

export type Interpreter = { runtime: ScriptRuntime; path: string; version: number[] }

export type Probe = (
  file: string,
  args: string[]
) => Promise<{ code: number | null; stdout: string }>

export type DiscoverDeps = {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  exists: (path: string) => boolean
  probe: Probe
}

const isFile = (p: string): boolean => {
  try {
    return existsSync(p) && statSync(p).isFile()
  } catch {
    return false
  }
}

export const realProbe: Probe = (file, args) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        timeout: 10_000,
        windowsHide: true,
        maxBuffer: 64 * 1024,
        env: scriptEnv(process.env, { platform: process.platform })
      },
      (err, stdout) => {
        const code = err ? (typeof err.code === 'number' ? err.code : null) : 0
        resolve({ code, stdout: String(stdout ?? '') })
      }
    )
  })

export const defaultDeps = (): DiscoverDeps => ({
  platform: process.platform,
  env: process.env,
  exists: isFile,
  probe: realProbe
})

const pathOf = (env: NodeJS.ProcessEnv): string =>
  Object.entries(env).find(([k]) => k.toUpperCase() === 'PATH')?.[1] ?? ''

export const isStoreAlias = (p: string): boolean => /[\\/]Microsoft[\\/]WindowsApps[\\/]/i.test(p)

// Every match for `names` on PATH, in PATH order.
export function onPath(names: string[], d: DiscoverDeps): string[] {
  const win = d.platform === 'win32'
  const pjoin = win ? win32.join : posix.join
  const dirs = pathOf(d.env)
    .split(win ? ';' : ':')
    .map((s) => s.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean)
  const out: string[] = []
  for (const dir of dirs)
    for (const n of names) {
      const p = pjoin(dir, n)
      if (!out.includes(p) && d.exists(p)) out.push(p)
    }
  return out
}

// `py -0p` prints one line per install, e.g. " -V:3.12 *  C:\Python312\python.exe"
// (or " -3.12-64 *  C:\..." on older launchers).
export function parsePyList(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.match(/([A-Za-z]:\\.*?python[w]?\.exe)\s*$/i)?.[1])
    .filter((p): p is string => !!p)
}

const PY_VERSION = 'import sys; print("%d.%d.%d" % sys.version_info[:3])'

async function versionOf(
  runtime: ScriptRuntime,
  path: string,
  d: DiscoverDeps
): Promise<number[] | null> {
  const r =
    runtime === 'python'
      ? await d.probe(path, ['-E', '-s', '-c', PY_VERSION])
      : await d.probe(path, ['-p', 'process.versions.node'])
  if (r.code !== 0) return null
  const m = r.stdout.trim().match(/^(\d+)\.(\d+)\.(\d+)$/)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

export async function candidates(runtime: ScriptRuntime, d: DiscoverDeps): Promise<string[]> {
  const win = d.platform === 'win32'
  const list: string[] = []
  const add = (p: string): void => {
    if (
      !isStoreAlias(p) &&
      !list.some((q) => (win ? q.toLowerCase() === p.toLowerCase() : q === p))
    )
      list.push(p)
  }
  if (runtime === 'python') {
    if (win) {
      for (const launcher of onPath(['py.exe'], d)) {
        const r = await d.probe(launcher, ['-0p'])
        if (r.code === 0) parsePyList(r.stdout).filter(d.exists).forEach(add)
      }
      onPath(['python.exe', 'python3.exe'], d).forEach(add)
    } else {
      onPath(['python3', 'python'], d).forEach(add)
      for (const p of ['/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3'])
        if (d.exists(p)) add(p)
    }
  } else {
    if (win) {
      onPath(['node.exe'], d).forEach(add)
      for (const k of ['ProgramFiles', 'ProgramW6432']) {
        const base = Object.entries(d.env).find(([n]) => n.toUpperCase() === k.toUpperCase())?.[1]
        if (base && d.exists(win32.join(base, 'nodejs', 'node.exe')))
          add(win32.join(base, 'nodejs', 'node.exe'))
      }
    } else {
      onPath(['node'], d).forEach(add)
      for (const p of ['/opt/homebrew/bin/node', '/usr/local/bin/node']) if (d.exists(p)) add(p)
    }
  }
  return list
}

const newer = (a: number[], b: number[]): boolean => {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]
  return false
}

// All working interpreters, newest first.
export async function discover(
  runtime: ScriptRuntime,
  d: DiscoverDeps = defaultDeps()
): Promise<Interpreter[]> {
  const found: Interpreter[] = []
  for (const path of await candidates(runtime, d)) {
    const version = await versionOf(runtime, path, d)
    if (version) found.push({ runtime, path, version })
  }
  return found.sort((a, b) =>
    newer(a.version, b.version) ? -1 : newer(b.version, a.version) ? 1 : 0
  )
}

// A path the user picked with "Browse": it must start and report a version.
export async function checkInterpreter(
  runtime: ScriptRuntime,
  path: string,
  d: DiscoverDeps = defaultDeps()
): Promise<Interpreter | null> {
  if (!d.exists(path) || isStoreAlias(path)) return null
  const version = await versionOf(runtime, path, d)
  return version ? { runtime, path, version } : null
}

// The Python inside a script's venv, if "Install dependencies" made one.
export function venvPython(envDir: string, platform: NodeJS.Platform): string {
  return platform === 'win32'
    ? join(envDir, 'Scripts', 'python.exe')
    : join(envDir, 'bin', 'python')
}
