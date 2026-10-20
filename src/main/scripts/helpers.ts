// Small helpers a new script gets in its folder, so its code only defines
// handlers. They read {"tool", "input"} from stdin, call the handler and print
// one result line (RESULT_MARK + JSON) at the end. Errors print a traceback to
// stderr (kept in the run record, not shown to the model) and a short message.

export const PY_HELPER_NAME = 'custard_script.py'
export const PY_HELPER = `"""Custard script helper. Usage:

    from custard_script import run

    def fetch_page(input):
        return {"text": "..."}

    run({"fetch_page": fetch_page})
"""
import json
import sys
import traceback

MARK = "@custard-result "


def _emit(value):
    sys.stdout.write("\\n" + MARK + json.dumps(value, ensure_ascii=False, default=str) + "\\n")
    sys.stdout.flush()


def run(handlers):
    tool = sys.argv[1] if len(sys.argv) > 1 else ""
    try:
        payload = json.loads(sys.stdin.read() or "{}")
    except ValueError:
        _emit({"ok": False, "error": "Custard sent input that isn't JSON."})
        sys.exit(2)
    handler = handlers.get(tool)
    if handler is None:
        _emit({"ok": False, "error": "No handler for tool %r." % tool})
        sys.exit(2)
    try:
        result = handler(payload.get("input") or {})
    except Exception as err:  # noqa: BLE001
        traceback.print_exc()
        _emit({"ok": False, "error": "%s: %s" % (type(err).__name__, err)})
        sys.exit(1)
    _emit({"ok": True, "result": result})
`

export const NODE_HELPER_NAME = 'custard-script.mjs'
export const NODE_HELPER = `// Custard script helper. Usage:
//
//   import { run } from './custard-script.mjs'
//   run({ fetch_page: async (input) => ({ text: '...' }) })

const MARK = '@custard-result '

function emit(value) {
  process.stdout.write('\\n' + MARK + JSON.stringify(value) + '\\n')
}

async function readStdin() {
  const chunks = []
  for await (const c of process.stdin) chunks.push(c)
  return Buffer.concat(chunks).toString('utf8')
}

export async function run(handlers) {
  const tool = process.argv[2] ?? ''
  let payload
  try {
    payload = JSON.parse((await readStdin()) || '{}')
  } catch {
    emit({ ok: false, error: "Custard sent input that isn't JSON." })
    process.exitCode = 2
    return
  }
  const handler = Object.hasOwn(handlers, tool) ? handlers[tool] : undefined
  if (typeof handler !== 'function') {
    emit({ ok: false, error: 'No handler for tool ' + JSON.stringify(tool) + '.' })
    process.exitCode = 2
    return
  }
  try {
    const result = await handler(payload.input ?? {})
    emit({ ok: true, result: result ?? null })
  } catch (err) {
    console.error(err)
    emit({ ok: false, error: String(err && err.message ? err.message : err) })
    process.exitCode = 1
  }
}
`
