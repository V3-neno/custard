import { parentPort } from 'worker_threads'
import { dirname } from 'path'
import * as ts from 'typescript'
import { typecheck } from './typecheck'

// Runs the type check away from the main process, which would otherwise stop
// responding to the window for as long as the compiler takes.
parentPort?.on(
  'message',
  (m: { dir: string; sdkDir: string; widgetEntries: string[]; libDir?: string }) => {
    try {
      const libDir = m.libDir ?? dirname(require.resolve('typescript/lib/typescript.js'))
      parentPort?.postMessage({
        ok: true,
        errors: typecheck(ts, {
          dir: m.dir,
          sdkDir: m.sdkDir,
          widgetEntries: m.widgetEntries,
          libDir
        })
      })
    } catch (err) {
      parentPort?.postMessage({ ok: false, error: String((err as Error)?.message ?? err) })
    }
  }
)
