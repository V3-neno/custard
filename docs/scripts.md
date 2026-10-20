# Scripts

Python and JavaScript scripts you approve can be offered to the assistant as
tools in Chat. The design, and the decisions behind it, are in
[proposals/script-tools.md](proposals/script-tools.md).

**Scripts run on this computer as you, outside Custard's sandbox.** An
approved script can read and change your files, use the internet, and read
data Custard stores, including API keys. Custard checks that only the version
you approved runs, asks before each run, limits time and output, and can stop
it. It can't make a harmful script safe. Only approve code you have read or
trust.

Status (2026-10-20): steps 1 and 2 are built. Scripts can't yet be created,
approved or given packages from the app (step 3, Plugins mode). Nothing here
has been tried on Windows or macOS.

## Settings → Scripts

| Setting                       | What it does                                                                                                                                                                                                               |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Let the assistant run scripts | The one switch, off by default. Off: no script tool is offered, a call to one runs nothing, and running scripts are stopped.                                                                                               |
| Python, Node.js               | **Find** lists the interpreters on this computer with their versions (Windows: the `py` launcher and PATH, skipping the Microsoft Store shortcut). **Use** picks one; **Browse** picks a file. Custard never installs one. |
| Running: … / Stop all         | Shown while a script runs.                                                                                                                                                                                                 |
| The list                      | Each script, the approved version, whether it is in Chat, and any problem (for example an approved copy that changed).                                                                                                     |

## In a chat

- Only **Chat** mode offers script tools, and only scripts that are approved,
  turned on and allowed in Chat. Design, Skills, Plugins and automations
  never do.
- Tool names are `script_<script>__<tool>`.
- **Every call shows a card** first: the script, its version, the tool,
  what the script declares about the internet and files (not enforced), and
  the whole input. Read tools offer **Allow for this chat**; write tools ask
  every time. Approving the script again (a new version) asks again.
- A call is refused without running when Scripts was turned off, the script
  was taken out of Chat, or it was approved again after the reply started.
- **Stop** in the chat ends the script and every process it started.
- What a script returns goes to the model inside
  `<tool_result source="script:<id>" trust="data">`, with markup escaped and
  cut at 12,000 characters. Like web pages and plugin results, it counts as
  outside text, so changes to notes in the chat ask first.

## Where scripts live

`<app data>/scripts/<id>/`:

| Folder or file  | What                                                                                          |
| --------------- | --------------------------------------------------------------------------------------------- |
| `src/`          | The source: `script.json`, the entry file, helpers.                                           |
| `approved/`     | The copy taken when you approved it. Only this runs, and it is hashed again before every run. |
| `env/`          | A Python script's own packages (a venv), made only when you ask for it.                       |
| `node_modules/` | A Node script's own packages, same.                                                           |
| `work/`         | The script's current folder when it runs.                                                     |
| `runs/`         | The last 50 runs: input, how it ended, time, the end of its output and error output.          |
| `state.json`    | On or off, in Chat or not, and the approval (version and hashes).                             |

## `script.json`

```json
{
  "name": "Scraper",
  "version": "1.0.0",
  "runtime": "python",
  "minVersion": "3.10",
  "entry": "main.py",
  "setup": [["python", "-m", "scrapling", "install"]],
  "tools": [
    {
      "name": "fetch_page",
      "description": "Fetch a page and return the text of elements matching a CSS selector.",
      "inputSchema": {
        "type": "object",
        "properties": { "url": { "type": "string" }, "selector": { "type": "string" } },
        "required": ["url"]
      },
      "effect": "read",
      "timeoutMs": 60000
    }
  ],
  "declares": { "network": true, "files": "work" }
}
```

- `runtime` is `python` or `node`; `entry` is a `.py`, or `.mjs` / `.cjs` /
  `.js`, file inside the folder.
- Tools follow the plugin rules (1 to 32 tools, lowercase names, a JSON
  schema for input, `effect` `read` or `write`), with a timeout from 1 second
  to 10 minutes (default 60 seconds).
- `setup` commands are lists of plain words starting with the runtime. They
  run with the script's own interpreter, never a shell, and only when you ask.
- `declares` is shown to you and not enforced.

## How a script runs

- Custard starts the approved entry with the tool name as its one argument
  and `{"tool": ..., "input": ...}` as JSON on stdin. Nothing from the model
  is put on the command line, and there is no shell.
- The script answers with one line: `@custard-result ` followed by
  `{"ok": true, "result": ...}` or `{"ok": false, "error": "..."}`. The helper
  files (`custard_script.py`, `custard-script.mjs`) do this for you.
- The environment is an allowlist: system folders and `PATH`, never
  Custard's keys, `NODE_OPTIONS`, `PYTHON*`, loader or proxy variables.
- Python runs with `-E -s -B` and a bytecode cache folder that never exists,
  so no `.pyc` is written to or read from the approved copy.
- Limits: the tool's timeout, 2 MB of output, one script at a time.

## Tests

`src/main/scripts/*.test.ts` (real Python and Node) and
`test/e2e/scripts.mjs` (the built app against the mock provider, with a
sample approved Python script).
