// Scripts (docs/scripts.md): Python and JavaScript scripts the assistant can
// call. Stored in settings.json under `scripts`. Off by default.

export type ScriptRuntime = 'python' | 'node'

// An interpreter the user chose (Find or Browse), with the version it
// reported when it was checked.
export type InterpreterChoice = { path: string; version: number[] }

export type ScriptsSettings = {
  // The one switch. Off: no script is offered or runs, and running ones stop.
  enabled: boolean
  python: InterpreterChoice | null
  node: InterpreterChoice | null
}

export const DEFAULT_SCRIPTS: ScriptsSettings = { enabled: false, python: null, node: null }

// One line per script for Settings.
export type ScriptSummary = {
  id: string
  name: string
  runtime: ScriptRuntime | null
  approved: string | null
  enabled: boolean
  useInChat: boolean
  problem: string | null
}

export type ScriptsView = {
  settings: ScriptsSettings
  running: string[]
  scripts: ScriptSummary[]
}

const choice = (v: unknown): InterpreterChoice | null => {
  const c = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  if (typeof c.path !== 'string' || !c.path || c.path.length > 1000) return null
  if (
    !Array.isArray(c.version) ||
    c.version.length !== 3 ||
    c.version.some((n) => typeof n !== 'number' || !Number.isInteger(n) || n < 0)
  )
    return null
  return { path: c.path, version: c.version as number[] }
}

export function normalizeScripts(raw: unknown): ScriptsSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    enabled: r.enabled === true,
    python: choice(r.python),
    node: choice(r.node)
  }
}

export const SCRIPT_RISK =
  'Scripts run on this computer as you, outside Custard’s sandbox. An approved script can read and change your files, use the internet, and read data Custard stores, including API keys. Custard checks that only the version you approved runs, asks before each run, limits time and output, and can stop it. It can’t make a harmful script safe. Only approve code you have read or trust.'
