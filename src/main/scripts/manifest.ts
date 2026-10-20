import type { JsonSchema } from '../../shared/plugins'
import { checkSchema } from '../plugins/schema'

// script.json: what a user script is, how it runs and which tools it offers.
// The folder name is the id, as for plugins. Declarations (`declares`) are
// shown to the user and never enforced: a script runs as the user, outside
// any sandbox (docs/proposals/script-tools.md, section 4).

export const SCRIPT_ID = /^[a-z][a-z0-9-]{1,30}$/
const TOOL_NAME = /^[a-z][a-z0-9_]{0,40}$/

// Tool names the model sees: `script_<id>__<tool>`. Plugin ids can't contain
// "_", so these never collide with plugin tools (`<id>__<tool>`).
export const SCRIPT_PREFIX = 'script_'
export const scriptToolName = (id: string, tool: string): string => `${SCRIPT_PREFIX}${id}__${tool}`
export function splitScriptToolName(name: string): { scriptId: string; tool: string } | null {
  if (!name.startsWith(SCRIPT_PREFIX)) return null
  const rest = name.slice(SCRIPT_PREFIX.length)
  const i = rest.indexOf('__')
  if (i < 0) return null
  const scriptId = rest.slice(0, i)
  const tool = rest.slice(i + 2)
  return SCRIPT_ID.test(scriptId) && TOOL_NAME.test(tool) ? { scriptId, tool } : null
}

export const TIMEOUT = { default: 60_000, min: 1_000, max: 600_000 }

export type ScriptRuntime = 'python' | 'node'

export type ScriptTool = {
  name: string
  description: string
  inputSchema: JsonSchema
  effect: 'read' | 'write'
  label?: string
  timeoutMs?: number
}

export type ScriptManifest = {
  id: string
  name: string
  version: string
  description?: string
  runtime: ScriptRuntime
  // Lowest interpreter version, as "3.10" (Python) or "20" (Node).
  minVersion?: string
  entry: string
  // Commands run once by "Install dependencies", shown word for word first.
  // Each is an argument list whose first word is the runtime ("python" or
  // "node"); it runs with the script's own interpreter, never a shell.
  setup: string[][]
  tools: ScriptTool[]
  declares: { network: boolean; files: 'work' | 'anywhere' }
}

export type ScriptManifestResult =
  { ok: true; manifest: ScriptManifest } | { ok: false; errors: string[] }

const VERSION = /^\d+\.\d+\.\d+$/
const MIN_VERSION = /^\d{1,2}(\.\d{1,2})?$/
const ENTRY: Record<ScriptRuntime, RegExp> = {
  python: /^[\w-]+(\/[\w-]+)*\.py$/,
  node: /^[\w-]+(\/[\w-]+)*\.(mjs|cjs|js)$/
}
// A setup word: plain characters only, so what is shown is exactly what runs.
const SETUP_WORD = /^[\w.:=@/+-]{1,200}$/

function checkTools(id: string, tools: unknown, errors: string[]): ScriptTool[] {
  if (!Array.isArray(tools) || tools.length === 0 || tools.length > 32) {
    errors.push('tools must list 1 to 32 tools')
    return []
  }
  const names = new Set<string>()
  for (const [i, t] of (tools as Partial<ScriptTool>[]).entries()) {
    const at = `tools[${i}]${t?.name ? ` (${t.name})` : ''}`
    if (!t || typeof t !== 'object') {
      errors.push(`${at}: must be an object`)
      continue
    }
    const allowed = new Set(['name', 'description', 'inputSchema', 'effect', 'label', 'timeoutMs'])
    for (const k of Object.keys(t))
      if (!allowed.has(k)) errors.push(`${at}: "${k}" is not supported`)
    if (typeof t.name !== 'string' || !TOOL_NAME.test(t.name))
      errors.push(`${at}: name must be lowercase letters, digits and _ (start with a letter)`)
    else if (names.has(t.name)) errors.push(`${at}: duplicate tool name`)
    else if (scriptToolName(id, t.name).length > 64)
      errors.push(`${at}: "${scriptToolName(id, t.name)}" is longer than 64 characters`)
    if (typeof t.name === 'string') names.add(t.name)
    if (typeof t.description !== 'string' || !t.description || t.description.length > 1024)
      errors.push(`${at}: description must be 1 to 1024 characters`)
    if (t.effect !== 'read' && t.effect !== 'write')
      errors.push(`${at}: effect must be "read" or "write"`)
    const schemaErrors = checkSchema(t.inputSchema, `${at}.inputSchema`)
    errors.push(...schemaErrors)
    if (!schemaErrors.length && t.inputSchema?.type !== 'object')
      errors.push(`${at}.inputSchema: type must be "object"`)
    if (t.label !== undefined && (typeof t.label !== 'string' || t.label.length > 120))
      errors.push(`${at}: label must be a short string`)
    if (
      t.timeoutMs !== undefined &&
      (typeof t.timeoutMs !== 'number' || t.timeoutMs < TIMEOUT.min || t.timeoutMs > TIMEOUT.max)
    )
      errors.push(`${at}: timeoutMs must be between ${TIMEOUT.min} and ${TIMEOUT.max}`)
  }
  return tools as ScriptTool[]
}

function checkSetup(runtime: unknown, setup: unknown, errors: string[]): string[][] {
  if (setup === undefined) return []
  if (!Array.isArray(setup) || setup.length > 8) {
    errors.push('setup must be a list of at most 8 commands')
    return []
  }
  for (const [i, cmd] of setup.entries()) {
    if (
      !Array.isArray(cmd) ||
      cmd.length < 2 ||
      cmd.length > 32 ||
      cmd.some((w) => typeof w !== 'string' || !SETUP_WORD.test(w))
    ) {
      errors.push(`setup[${i}]: must be a list of 2 to 32 plain words`)
      continue
    }
    if (cmd[0] !== runtime) errors.push(`setup[${i}]: must start with "${String(runtime)}"`)
  }
  return setup as string[][]
}

export function parseScriptManifest(raw: unknown, folderName: string): ScriptManifestResult {
  const errors: string[] = []
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return { ok: false, errors: ['script.json must be a JSON object'] }
  const m = raw as Record<string, unknown>
  const allowed = new Set([
    'name',
    'version',
    'description',
    'runtime',
    'minVersion',
    'entry',
    'setup',
    'tools',
    'declares'
  ])
  for (const k of Object.keys(m)) if (!allowed.has(k)) errors.push(`"${k}" is not supported`)
  if (!SCRIPT_ID.test(folderName))
    errors.push(
      'the folder name must be 2 to 31 lowercase letters, digits and -, starting with a letter'
    )
  if (typeof m.name !== 'string' || !m.name.trim() || m.name.length > 60)
    errors.push('name must be 1 to 60 characters')
  if (typeof m.version !== 'string' || !VERSION.test(m.version))
    errors.push('version must look like 1.0.0')
  if (
    m.description !== undefined &&
    (typeof m.description !== 'string' || m.description.length > 500)
  )
    errors.push('description must be at most 500 characters')
  const runtime = m.runtime
  if (runtime !== 'python' && runtime !== 'node') errors.push('runtime must be "python" or "node"')
  if (
    m.minVersion !== undefined &&
    (typeof m.minVersion !== 'string' || !MIN_VERSION.test(m.minVersion))
  )
    errors.push('minVersion must look like "3.10" or "20"')
  if (
    typeof m.entry !== 'string' ||
    (runtime === 'python' || runtime === 'node' ? !ENTRY[runtime].test(m.entry) : true)
  )
    errors.push(
      runtime === 'node'
        ? 'entry must be a relative .mjs, .cjs or .js path inside the script folder'
        : 'entry must be a relative .py path inside the script folder'
    )
  const setup = checkSetup(runtime, m.setup, errors)
  const tools = checkTools(folderName, m.tools, errors)
  const d = (m.declares ?? {}) as Record<string, unknown>
  if (typeof d !== 'object' || Array.isArray(d)) errors.push('declares must be an object')
  else {
    for (const k of Object.keys(d))
      if (k !== 'network' && k !== 'files') errors.push(`declares.${k} is not supported`)
    if (d.network !== undefined && typeof d.network !== 'boolean')
      errors.push('declares.network must be true or false')
    if (d.files !== undefined && d.files !== 'work' && d.files !== 'anywhere')
      errors.push('declares.files must be "work" or "anywhere"')
  }
  if (errors.length) return { ok: false, errors }
  return {
    ok: true,
    manifest: {
      id: folderName,
      name: (m.name as string).trim(),
      version: m.version as string,
      ...(m.description ? { description: m.description as string } : {}),
      runtime: runtime as ScriptRuntime,
      ...(m.minVersion ? { minVersion: m.minVersion as string } : {}),
      entry: m.entry as string,
      setup,
      tools,
      declares: {
        network: d.network === true,
        files: d.files === 'anywhere' ? 'anywhere' : 'work'
      }
    }
  }
}

// "3.10" >= "3.9", compared as numbers.
export function versionAtLeast(have: number[], min: string | undefined): boolean {
  if (!min) return true
  const want = min.split('.').map(Number)
  for (let i = 0; i < want.length; i++) {
    const h = have[i] ?? 0
    if (h !== want[i]) return h > want[i]
  }
  return true
}
