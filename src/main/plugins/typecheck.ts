import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { dirname, join, sep } from 'path'
import { isInside } from '../workspace/paths'

// Type-checks a plugin's TypeScript the way an editor would, so a wrong type or
// a misspelt SDK call is reported by plugin_validate and not first seen when a
// tool runs. esbuild only strips types, so this never changes what is built.
//
// The compiler reads only the plugin folder, the SDK and the compiler's own
// library files, through a host that refuses every other path. It parses and
// checks; it never runs plugin code.

type TS = typeof import('typescript')

export const MAX_TYPE_ERRORS = 30

// What the plugin sandbox provides besides the language itself and the SDK
// context (there is no fetch, DOM or Node here, which is the point).
const GLOBALS = `
declare function setTimeout(fn: () => void, ms?: number): number
declare function clearTimeout(id: number | undefined): void
declare function setInterval(fn: () => void, ms?: number): number
declare function clearInterval(id: number | undefined): void
declare const console: { log(...a: unknown[]): void; warn(...a: unknown[]): void; error(...a: unknown[]): void }
declare class AbortController { readonly signal: AbortSignal; abort(reason?: unknown): void }
interface AbortSignal { readonly aborted: boolean; readonly reason?: unknown; addEventListener(t: 'abort', fn: () => void, o?: { once?: boolean }): void; removeEventListener(t: 'abort', fn: () => void): void; throwIfAborted(): void }
declare class URL { constructor(u: string, base?: string); href: string; origin: string; protocol: string; host: string; hostname: string; pathname: string; search: string; hash: string; searchParams: URLSearchParams; toString(): string }
declare class URLSearchParams { constructor(init?: string | Record<string, string> | string[][]); get(k: string): string | null; getAll(k: string): string[]; has(k: string): boolean; set(k: string, v: string): void; append(k: string, v: string): void; delete(k: string): void; toString(): string; forEach(fn: (v: string, k: string) => void): void }
declare class TextEncoder { encode(s?: string): Uint8Array }
declare class TextDecoder { constructor(label?: string); decode(b?: Uint8Array): string }
`

const GLOBALS_FILE = '/__custard_globals.d.ts'

export type TypeCheckInput = {
  dir: string
  sdkDir: string
  // The folder holding lib.*.d.ts.
  libDir: string
  // Each widget's entry file, relative to the plugin folder. Widgets and tests
  // run in a browser view, so they are checked with the DOM; the plugin's own
  // code is checked without it (no fetch, no document).
  widgetEntries?: string[]
}

// Every .ts file in the plugin folder, apart from hidden and declaration files.
function sources(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.isSymbolicLink()) continue
      const full = join(d, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.isFile() && /\.ts$/.test(e.name) && !/\.d\.ts$/.test(e.name)) out.push(full)
      if (out.length > 500) return
    }
  }
  walk(dir)
  return out
}

export function typecheck(ts: TS, o: TypeCheckInput): string[] {
  // Without its library files the compiler reports hundreds of errors about
  // `Array` and `Promise`; better to say the check can't run.
  if (!existsSync(join(o.libDir, 'lib.es2022.d.ts')))
    throw new Error("the TypeScript library files aren't installed")
  const all = sources(o.dir)
  const domDirs = [
    join(o.dir, 'tests'),
    ...(o.widgetEntries ?? [])
      .map((e) => dirname(join(o.dir, e)))
      .filter((d) => d !== o.dir && isInside(d, o.dir))
  ]
  const isDom = (f: string): boolean => domDirs.some((d) => isInside(f, d))
  const entries = (o.widgetEntries ?? []).map((e) => join(o.dir, e))
  const plain = all.filter((f) => !isDom(f) && !entries.includes(f))
  const dom = all.filter((f) => isDom(f) || entries.includes(f))
  const seen = new Set<string>()
  const lines: string[] = []
  for (const [roots, withDom] of [
    [plain, false],
    [dom, true]
  ] as const)
    if (roots.length)
      for (const l of check(ts, o, roots, withDom))
        if (!seen.has(l)) {
          seen.add(l)
          lines.push(l)
        }
  if (lines.length <= MAX_TYPE_ERRORS) return lines
  return [
    ...lines.slice(0, MAX_TYPE_ERRORS),
    `[… ${lines.length - MAX_TYPE_ERRORS} more type errors left out; fix these first …]`
  ]
}

function check(ts: TS, o: TypeCheckInput, roots: string[], withDom: boolean): string[] {
  const dir = o.dir
  const allowed = (f: string): boolean =>
    f === GLOBALS_FILE || isInside(f, dir) || isInside(f, o.sdkDir) || isInside(f, o.libDir)
  const options: import('typescript').CompilerOptions = {
    noEmit: true,
    strict: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: withDom ? ['lib.es2022.d.ts', 'lib.dom.d.ts'] : ['lib.es2022.d.ts'],
    types: [],
    skipLibCheck: true,
    noResolve: false,
    baseUrl: dir,
    paths: {
      'custard-plugin-sdk': [join(o.sdkDir, 'index.ts')],
      'custard-plugin-sdk/testing': [join(o.sdkDir, 'testing.ts')],
      'custard-plugin-sdk/widget': [join(o.sdkDir, 'widget.ts')]
    }
  }
  const base = ts.createCompilerHost(options, true)
  const host: import('typescript').CompilerHost = {
    ...base,
    getDefaultLibLocation: () => o.libDir,
    getDefaultLibFileName: () => join(o.libDir, 'lib.es2022.d.ts'),
    fileExists: (f) => f === GLOBALS_FILE || (allowed(f) && existsSync(f) && statSync(f).isFile()),
    directoryExists: (d) => allowed(d) && existsSync(d),
    getDirectories: () => [],
    readFile: (f) => {
      if (f === GLOBALS_FILE) return GLOBALS
      if (!allowed(f)) return undefined
      try {
        return readFileSync(f, 'utf8')
      } catch {
        return undefined
      }
    },
    getSourceFile: (f, lang) => {
      const text = host.readFile(f)
      return text === undefined ? undefined : ts.createSourceFile(f, text, lang, true)
    },
    realpath: (f) => f,
    getCurrentDirectory: () => dir
  }
  const program = ts.createProgram(withDom ? roots : [GLOBALS_FILE, ...roots], options, host)
  const found = ts
    .getPreEmitDiagnostics(program)
    .filter((d) => d.category === ts.DiagnosticCategory.Error)
  return found.map((d) => {
    const text = ts.flattenDiagnosticMessageText(d.messageText, '\n').split('\n')[0]
    if (!d.file || d.start === undefined) return `TS${d.code}: ${text}`
    const pos = d.file.getLineAndCharacterOfPosition(d.start)
    const name = isInside(d.file.fileName, dir)
      ? d.file.fileName
          .slice(dir.length + 1)
          .split(sep)
          .join('/')
      : `custard-plugin-sdk/${d.file.fileName
          .slice(o.sdkDir.length + 1)
          .split(sep)
          .join('/')}`
    return `${name}:${pos.line + 1}: TS${d.code}: ${text}`
  })
}
