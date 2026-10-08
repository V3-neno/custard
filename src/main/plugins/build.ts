import { createHash } from 'crypto'
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'fs'
import { dirname, join, relative, sep } from 'path'
import { isDeniedName, isInside } from '../workspace/paths'

// Bundles a plugin's TypeScript into one script for its sandbox. esbuild only
// parses and transforms files; it never runs plugin code. Imports are limited
// to files inside the plugin folder and the SDK: there are no npm packages,
// so no install scripts or build scripts ever run.

export const MAX_SOURCE_FILES = 500
export const MAX_SOURCE_BYTES = 5 * 1024 * 1024
const MAX_BUNDLE_BYTES = 2 * 1024 * 1024

export type SourceFile = { path: string; content: string }

// Every regular file in the plugin folder, skipping links, secrets and VCS data.
export function readSources(dir: string): SourceFile[] {
  const files: SourceFile[] = []
  let bytes = 0
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name)
    )) {
      if (isDeniedName(e.name) || e.isSymbolicLink()) continue
      const full = join(d, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.isFile()) {
        if (files.length >= MAX_SOURCE_FILES)
          throw new Error(`A plugin can have at most ${MAX_SOURCE_FILES} files.`)
        const content = readFileSync(full, 'utf8')
        bytes += content.length
        if (bytes > MAX_SOURCE_BYTES) throw new Error('The plugin folder is larger than 5 MB.')
        files.push({ path: relative(dir, full).split(sep).join('/'), content })
      }
    }
  }
  walk(dir)
  return files
}

export const hashSources = (files: SourceFile[]): string =>
  createHash('sha256')
    .update(files.map((f) => `${f.path}\0${f.content}\0`).join(''))
    .digest('hex')
    .slice(0, 16)

type Esbuild = typeof import('esbuild')
let esbuild: Esbuild | null = null
const load = async (): Promise<Esbuild> => (esbuild ??= await import('esbuild'))

const EXTENSIONS = ['', '.ts', '.js', '.json', '/index.ts', '/index.js']

export type BuildResult = { ok: true; code: string } | { ok: false; errors: string[] }

// kind "plugin": the entry plus the sandbox runtime. kind "widget": a
// widget's UI module plus the widget runtime. kind "tests": every test file
// plus the test runner.
export async function bundle(
  dir: string,
  sdkDir: string,
  o:
    | { kind: 'plugin'; entry: string }
    | { kind: 'widget'; entry: string }
    | { kind: 'tests'; files: string[] }
): Promise<BuildResult> {
  const { build } = await load()
  const root = realpathSync.native(dir)
  const sdkRoot = realpathSync.native(sdkDir)
  const sdk: Record<string, string> = {
    'custard-plugin-sdk': join(sdkRoot, 'index.ts'),
    'custard-plugin-sdk/testing': join(sdkRoot, 'testing.ts'),
    'custard-plugin-sdk/widget': join(sdkRoot, 'widget.ts')
  }
  const lit = (p: string): string => JSON.stringify(`./${p}`)
  const contents =
    o.kind === 'plugin'
      ? `import plugin from ${lit(o.entry)}\nimport { start } from 'custard:runtime'\nstart(plugin)\n`
      : o.kind === 'widget'
        ? `import widget from ${lit(o.entry)}\nimport { startWidget } from 'custard:widget-runtime'\nstartWidget(widget)\n`
        : `${o.files.map((f) => `import ${lit(f)}`).join('\n')}\nimport { runRegisteredTests } from 'custard-plugin-sdk/testing'\n;(globalThis as any).__custardRunTests = runRegisteredTests\n`

  const guard: import('esbuild').Plugin = {
    name: 'custard-plugin-guard',
    setup(b) {
      b.onResolve({ filter: /.*/ }, (args) => {
        // The bridge glue; it grants nothing, so any file may import it.
        if (args.path === 'custard:runtime') return { path: join(sdkRoot, 'runtime.ts') }
        if (args.path === 'custard:widget-runtime')
          return { path: join(sdkRoot, 'widget-runtime.ts') }
        if (sdk[args.path]) return { path: sdk[args.path] }
        const fromSdk = args.importer && isInside(args.importer, sdkRoot)
        if (!args.path.startsWith('.'))
          return {
            errors: [
              {
                text: `"${args.path}" can't be imported. Plugins can import files in their own folder and "custard-plugin-sdk" only; npm packages and Node modules are not available.`
              }
            ]
          }
        const base = args.importer === '<stdin>' || !args.importer ? root : dirname(args.importer)
        const allowedRoot = fromSdk ? sdkRoot : root
        for (const ext of EXTENSIONS) {
          const candidate = join(base, args.path + ext)
          if (!existsSync(candidate)) continue
          const st = lstatSync(candidate)
          if (st.isSymbolicLink())
            return {
              errors: [{ text: `${args.path} is a symbolic link, which plugins can't use.` }]
            }
          if (!st.isFile()) continue
          const real = realpathSync.native(candidate)
          if (!isInside(real, allowedRoot))
            return { errors: [{ text: `${args.path} is outside the plugin folder.` }] }
          if (relative(allowedRoot, real).split(sep).some(isDeniedName))
            return { errors: [{ text: `${args.path} can't be imported.` }] }
          return { path: real }
        }
        return { errors: [{ text: `Can't find ${args.path}` }] }
      })
    }
  }

  try {
    const result = await build({
      stdin: { contents, resolveDir: root, loader: 'ts', sourcefile: '<stdin>' },
      bundle: true,
      write: false,
      format: 'iife',
      platform: 'browser',
      target: 'es2022',
      // Ignore any tsconfig in the plugin folder.
      tsconfigRaw: '{}',
      loader: { '.ts': 'ts', '.js': 'js', '.json': 'json' },
      plugins: [guard],
      logLevel: 'silent',
      legalComments: 'none'
    })
    const code = result.outputFiles[0]?.text ?? ''
    if (code.length > MAX_BUNDLE_BYTES)
      return { ok: false, errors: ['The bundle is larger than 2 MB.'] }
    return { ok: true, code }
  } catch (err) {
    const e = err as {
      errors?: { text: string; location?: { file: string; line: number } | null }[]
    }
    const errors = (e.errors ?? [{ text: String(err) }]).map((x) =>
      x.location
        ? `${x.location.file.replace(root, '').replace(/^[\\/]/, '')}:${x.location.line}: ${x.text}`
        : x.text
    )
    return { ok: false, errors }
  }
}
