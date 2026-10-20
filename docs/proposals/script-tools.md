# Script tools: Python and JavaScript scripts the assistant can call (Step 1, design only)

Status: approved by Neno on 2026-10-20 ("Build with all recommendations",
D1 to D7 as recommended). Step 1 is built; see **Step 1 as built** at the end,
which also lists where the built shape differs from this note.
Based on `main` at ce979a0 (version 0.1.2). Asked for on 2026-10-20, before
0.2.0: "i want to make it so that we can utilize python/js scripts. If i want
to create a scraper based on some github called scrapling then i want to be
able to recreate it and let Ai use it for me ... we will have to make it so
that we have a security and the rest is upto the user".

## 1. Short answer

This is the first feature in Custard that runs code **outside a sandbox Custard
controls**. Plugins run in a sandboxed Chromium window with no Node.js, no
files and no direct network (`docs/plugins/SECURITY.md`). Code mode has no
shell and no subprocess tool ("No shell anywhere", same file). There is no
`child_process` use anywhere in `src/` today (checked with grep).

Scrapling, the example you named, can't run inside any sandbox Custard has.
Its fetchers need native Python packages (`curl_cffi`, `lxml`) and a real
browser (Playwright / Patchright Chromium, downloaded by `scrapling install`).
So a useful version of this feature means running a real Python or Node
process **as your Windows user**. Custard can control _whether, when, with
what input, for how long and how much output_, but on Windows it can't
reliably stop an approved script from reading your files, using the network or
deleting things. Section 4 shows the options, including real containment, and
what each costs.

**Recommendation:** a "Scripts" feature, off by default, where every script is
reviewed and approved by content hash (like plugin activation), runs as a
plain subprocess with a scrubbed environment, a working folder, a timeout, an
output cap and a Stop that kills the whole process tree, and **asks before
every call** by default. Its output is treated as hostile text, exactly like a
web page. What an approved script then does on your computer is your risk, and
the UI says so plainly. Real containment (Docker/WSL) is a possible later step,
not v1.

## 2. What Scrapling actually needs (checked 2026-10-20)

From the Scrapling README (github.com/D4Vinci/Scrapling) and PyPI metadata
(`scrapling` 0.5, BSD-3-Clause):

| Need               | Detail                                                                                                                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Python             | 3.10 or newer.                                                                                                                                                                                    |
| Parser only        | `pip install scrapling`: `lxml`, `cssselect`, `orjson`, `tld`, `w3lib`. Native wheels (`lxml`, `orjson`).                                                                                         |
| Fetchers           | `pip install "scrapling[fetchers]"` adds `curl_cffi` (browser TLS impersonation, native), `playwright`, `patchright`, `browserforge`, `msgspec`, `anyio`, `protego` and more.                     |
| Browsers           | `scrapling install` "downloads all browsers, along with their system dependencies and fingerprint manipulation dependencies". Needed only for the browser fetchers (`StealthyFetcher`, sessions). |
| HTTP-only fetching | `Fetcher` / `FetcherSession` need no browser.                                                                                                                                                     |
| MCP server         | `pip install "scrapling[ai]"` ships an MCP server for AI clients. Custard has no MCP client today.                                                                                                |
| Docker             | `pyd4vinci/scrapling` / `ghcr.io/d4vinci/scrapling` with all extras and browsers.                                                                                                                 |

What that means here:

- **WASM/Pyodide can't run the useful part.** Pyodide has no raw sockets and
  can't load `curl_cffi` or drive a browser. At most the parser would work.
- **Installs run third-party code.** `pip install` can build from source
  (running `setup.py`), and `scrapling install` downloads browser binaries.
  Both are code you are choosing to trust.
- **Browser fetchers spawn child processes** (Chromium). Stop must kill the
  whole tree, not just Python.
- **"Stealth" scraping** (anti-bot bypass, fingerprint spoofing) can break
  sites' terms of service. That is a use decision that stays yours; Custard
  doesn't police targets.

Custard already has `web_fetch`/`web_read` tools (`src/main/web/`). Simple
page reading is covered; Scrapling adds JS-rendered pages, sessions and
anti-bot handling.

## 3. Where scripts live

| Option                                                   | Good                                                                | Bad                                                                                                                                                                                                                   |
| -------------------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. App data** `<app data>/scripts/<id>/` (recommended) | Same place as plugin state. Not synced. Vault tools can't reach it. | Not visible in Obsidian; backup is yours.                                                                                                                                                                             |
| B. Vault `Custard/Scripts/<id>/`                         | Visible and versioned with your notes; syncs to other devices.      | Anything that can write the vault (the assistant's vault tools, automations, Obsidian plugins, a sync conflict, another device) could change code that runs as you. Sync can also deliver code from another computer. |
| C. Repo `scripts/<id>/` like `plugin/<id>`               | Matches plugin development.                                         | Packaged builds read plugins from `resources/`; user scripts don't belong in the app's install folder.                                                                                                                |

Recommended layout (A):

```
<app data>/scripts/<id>/
  src/            source: script.json, main.py or main.mjs, requirements.txt or package.json, tests/
  approved/       snapshot of src at approval + sha256 of every file
  env/            Python venv or node_modules, created only by "Install dependencies"
  work/           the script's working folder (current directory when it runs)
  runs/           run records: input, exit code, duration, capped stdout/stderr
```

Only `approved/` ever runs. Editing `src/` changes nothing until you review
the diff and approve again, the same rule as plugin activation.

## 4. How scripts run (the main security decision)

| Option                                                                 | Stops file access? | Stops network?       | Runs Scrapling fetchers?                   | Cost                                                                                                                   |
| ---------------------------------------------------------------------- | ------------------ | -------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| **A. Plain subprocess with gates** (recommended for v1)                | No                 | No                   | Yes, incl. browsers                        | Small. Uses your installed Python / Node.                                                                              |
| B. WASM only: Pyodide for Python, Node or Deno permission flags for JS | Yes for Pyodide    | Yes for Pyodide      | No (parser only)                           | Medium. Ships Pyodide (~tens of MB). Node's permission model says itself it "does not protect against malicious code". |
| C. Container: Docker Desktop or WSL2                                   | Yes (mounts only)  | Yes (network on/off) | Yes (Scrapling has an image)               | Large. You install Docker Desktop or WSL; first run is slow; Windows-specific setup we can't test from the cloud.      |
| D. Windows AppContainer via a native helper                            | Yes                | Yes (capability)     | Doubtful (Chromium inside an AppContainer) | Large. Native C++/Rust helper, Windows-only, untestable here.                                                          |

Details for A:

- `spawn` with `shell: false`, arguments as an array, `windowsHide: true`.
- **Environment scrubbed** to an allowlist (`PATH`, `SYSTEMROOT`, `TEMP`,
  `TMP`, `USERPROFILE`, `LOCALAPPDATA`, `APPDATA`, the venv variables, plus
  per-script config values you typed). Nothing named like a key, no
  `ANTHROPIC_*`, `OPENAI_*`, `NODE_OPTIONS`, `PYTHONSTARTUP`, `PYTHONPATH`.
  Python runs with `-I` (isolated: ignores `PYTHON*` variables and user
  site-packages), Node without inherited `NODE_OPTIONS`.
- Current directory is `work/`; input arrives as JSON on stdin; nothing from
  the model goes on the command line.
- **Stop kills the tree.** On Windows `taskkill /PID <pid> /T /F` (or a job
  object); on macOS/Linux a process group with `detached: true` and
  `kill(-pid)`. Needed because Playwright starts Chromium.
- One script run at a time by default (setting up to 3).

What A **can't** do, said plainly: an approved script runs as you. It can read
any file you can (including Custard's own data folder, and on Windows it can
ask DPAPI to decrypt Custard's stored API keys, because DPAPI protection is per
Windows user), use any network, and delete things. The gates make sure that
only code you approved runs, only when you allow it, with input you saw, and
that it stops. They don't make bad code safe.

C is the only option that gives real containment _and_ runs Scrapling. It
could be added later as a per-script "Run in container" choice using the same
manifest and tool contract, so v1 doesn't block it.

## 5. Interpreter discovery and dependency installs

- **Python** (Settings → Scripts, auto-detect plus a "Browse" override):
  Windows: `py -0p` (the Python launcher's list), then `python.exe` on `PATH`,
  **skipping** the Microsoft Store alias stub in
  `%LOCALAPPDATA%\Microsoft\WindowsApps` (it opens the Store instead of
  running). macOS/Linux: `python3` on `PATH`, then common Homebrew paths.
  Check with `python -I -c "import sys; print(sys.version_info[:3])"`; a
  script can declare `"python": ">=3.10"`.
- **Node:** the system `node` on `PATH` (you already have it for Next.js),
  same check. Custard's own Electron can't stand in: release builds turn off
  the `runAsNode` fuse (`electron-builder.yml`), and that should stay off.
  (`utilityProcess` would avoid a Node install but runs inside Custard's own
  app identity; not recommended.)
- **Installs only on your click.** "Install dependencies" shows the exact
  command and the requirement list first, then runs it into that script's
  own `env/`:
  - Python: `python -I -m venv env`, then
    `env\Scripts\python -I -m pip install --require-virtualenv -r requirements.txt`.
  - Node: `npm ci --ignore-scripts` when there is a lockfile
    (`--ignore-scripts` blocks install hooks; packages that need them, like
    Playwright for Node, then need an explicit setup step).
  - Extra setup commands (like `python -m scrapling install`) are declared in
    `script.json` as `setup` and shown word for word before running.
  - The assistant can never install anything; it can only suggest it.
- Optional later: use `uv` if installed (faster, can fetch a Python itself).
  Not needed for v1.

## 6. Manifest and how the assistant calls a script

`script.json` (shape, not final):

```json
{
  "name": "Scraper",
  "version": "0.1.0",
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

- **Contract:** Custard starts the entry with the tool name as the only
  argument and `{ "tool": ..., "input": ... }` as JSON on stdin. The script
  prints one line `@custard-result ` followed by `{ "ok": true, "result": ... }`
  or `{ "ok": false, "error": "..." }`; the last such line counts. A small helper (`custard_script.py` /
  `custard-script.mjs`) does this for you. stderr goes to the run record only.
- **Tool names** `script_<id>__<tool>`, so they never collide with plugin tools
  (`<id>__<tool>`). Same schema checks and length limits as plugins.
- **Offered only** when Scripts is on, the script is approved and enabled, and
  you turned on "Use in Chat" for it. Same stale-call rule as plugins: a call
  from an older tool list or for a changed hash is refused.
- **Asking:** see decision D3. Recommended: every call shows a card with the
  script, tool and whole input (Allow / Allow for this chat / Don't allow);
  `effect: "write"` tools never get "Allow for this chat".
- **Declarations are shown, not enforced** under runner A. `network` and
  `writesFiles` appear on the review screen and card so you know what the
  author claims. The UI must not suggest they are enforced.
- **Limits:** timeout default 60 s, max 10 min; stdout read up to 2 MB then
  the process is killed; the result shown to the model capped like plugin
  results (12,000 characters, `RESULT_CAPS.plugin`).
- **Not in v1:** automations, Design, background sync, scripts calling other
  scripts or plugins, files passed in from the vault. Each can be added later
  with its own decision.

## 7. Folder access

Under runner A a script can reach any folder anyway, so "granting" a folder
would be a promise Custard can't keep. Recommended for v1: no folder grants.
A script works in its own `work/` folder; if you want it to read a vault
folder, you give it the path as config and accept that it's your choice.
Writing into the vault from a script is not offered as a feature. With runner
C later, folder grants become real (only mounted folders exist inside the
container) and would reuse the Editable folders levels.

## 8. Authoring and testing in Plugins mode

- The Plugins hub gets a **Scripts** section beside plugins with **Add a
  script** (Python or JavaScript). The workspace is `<app data>/scripts/<id>/src`
  with the same file tools and path checks as the Plugins workspace
  (`src/main/workspace/`): no `..`, links, `.env*`, key files, `env/` or
  `node_modules`.
- **Running is never silent, even in development.** A `script_test` tool runs
  `tests/` or a sample call against the _source_ (not the approved snapshot)
  and **asks every time**, showing that it will run unapproved code as you.
  There's no "Allow for this chat" for test runs, because the assistant just
  wrote the code.
- "Recreate Scrapling" in practice: the assistant writes a small wrapper
  (`main.py` calling `scrapling.fetchers.Fetcher` / `StealthyFetcher`) and a
  `requirements.txt` with `scrapling[fetchers]==<version>`. You click Install
  dependencies and the setup step. Copying Scrapling's own source in is
  neither needed nor recommended.
- **Review and approve**: per-file diff against the approved snapshot, the
  requirement list and setup commands, the declarations, the tool list, and
  the risk sentence (section 10). Approving records the hashes.

## 9. Hostile text in output

A scraper returns web pages, which are the main source of prompt injection.

- Every result goes through the existing fence (`fenceResult` in
  `src/main/automations/untrusted.ts`): control and bidi characters removed,
  markup escaped, `<tool_result source="script:<id>" trust="data">`, capped.
- Links in script output count as "page" origin for `web_fetch`
  (`src/main/web/provenance.ts`), so following one asks first.
- Script output never counts as approval for anything, and a call whose input
  carries a URL or path from earlier tool output is still a normal card (with
  default asking, every call is a card anyway).
- stderr and tracebacks go to the run record and a short error line, never
  the raw text to the model.

## 10. What is your own risk (shown in the UI)

Suggested wording on the Scripts switch and the review screen:

> Scripts run on this computer as you, outside Custard's sandbox. An approved
> script can read and change your files, use the internet, and read data
> Custard stores, including API keys. Custard checks that only the version you
> approved runs, asks before each run, limits time and output, and can stop
> it. It can't make a harmful script safe. Only approve code you have read
> or trust.

Explicitly yours: what the code does once it runs; packages and browsers you
install; sites you scrape and their terms; anything you approve with "Allow
for this chat"; scripts you copy from elsewhere.

## 11. Off switch and kill switch

- Settings → Scripts: one switch, **off by default**. Off removes all script
  tools, refuses calls and kills running scripts.
- Per script: Enable, Use in Chat, Uninstall (deletes `approved/`, `env/`,
  `runs/`; keeps `src/`).
- The working card has **Stop** (kills the tree). Chat Stop also stops a
  running script.
- Tray and notifications from #78 aren't involved, since scripts don't run in
  the background in v1.

## 12. Decisions for Neno

| #   | Question                                 | Options                                                              | Recommended                                                                                    |
| --- | ---------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| D1  | How scripts run                          | A subprocess with gates / B WASM only / C container / D AppContainer | **A** for v1 (it's the only cheap option that runs Scrapling), C considered later as an add-on |
| D2  | Where they live                          | App data / vault / repo                                              | **App data**                                                                                   |
| D3  | When a call asks you                     | Every call / per chat for read tools / never after approval          | **Every call**, "Allow for this chat" only for `read` tools; no permanent "don't ask" in v1    |
| D4  | Can the assistant write and test scripts | Yes with a card per test run / write only / no                       | **Yes**, every test run asks; installs only by your click                                      |
| D5  | Folder grants                            | None in v1 / cooperative paths / wait for containers                 | **None in v1**                                                                                 |
| D6  | Scripts in automations                   | No / read tools only                                                 | **No** in v1 (nobody is there to answer the card)                                              |
| D7  | Accept the risk statement in section 10  | Yes / change it                                                      | **Yes**                                                                                        |

## 13. Build steps if approved (one at a time, review stop after each)

1. Runner and store: `src/main/scripts/` (manifest, hashes, approved snapshot,
   interpreter discovery, scrubbed spawn, tree kill, limits, run records),
   unit tests with real Python and Node in the container.
2. Chat integration: tool list, cards, stale-call checks, fencing, Stop;
   e2e against the mock provider with a sample script.
3. Plugins-mode authoring: Scripts section, workspace, `script_test`,
   review/approve screen, Install dependencies and setup.
4. A Scrapling example script and docs (`docs/scripts.md`), tested here for
   the HTTP `Fetcher` only if the cloud network allows; the browser fetcher
   and Windows remain unverified until you run it.

Not verified by this note: anything on Windows (the launcher, the Store alias,
`taskkill`, DPAPI behaviour) and Scrapling itself. Those are from documentation.

## Step 1 as built

Branch `script-tools`. Runner and store only: nothing is wired into Electron,
the chat, settings or the UI yet, so the app behaves exactly as before.

| File                               | What it does                                                                                                                                                                                                                                                     |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/scripts/manifest.ts`     | `script.json` checks (same tool rules as plugins, timeout 1 s to 10 min), `script_<id>__<tool>` names, setup commands as plain argument lists that must start with the runtime.                                                                                  |
| `src/main/scripts/store.ts`        | `<app data>/scripts/<id>/` layout, hashing (no links, secret-looking names, dependency folders, 500 files / 20 MB), approval bound to the digest the user reviewed, re-hash of `approved/` before every run, run records (last 50), uninstall that keeps `src/`. |
| `src/main/scripts/interpreters.ts` | Python and Node discovery (`py -0p`, PATH, Store alias skipped, Program Files / Homebrew), version probe, check for a path picked with Browse, venv Python path.                                                                                                 |
| `src/main/scripts/env.ts`          | Allowlisted environment per OS; script config values can't set `PATH`, `NODE_*`, `PYTHON*`, `LD_*`, `DYLD_*`, `ELECTRON_*`, proxies or CA variables.                                                                                                             |
| `src/main/scripts/runner.ts`       | Spawn without a shell, JSON on stdin, timeout, 2 MB stdout cap, stderr tail, tree kill (process group on macOS/Linux, `taskkill /T /F` on Windows), result line parsing.                                                                                         |
| `src/main/scripts/host.ts`         | All checks before a run (Scripts on, script on, approved copy unchanged, tool declared, input valid, interpreter new enough, one run at a time by default, up to 3), Stop for one or all scripts, run records.                                                   |
| `src/main/scripts/helpers.ts`      | `custard_script.py` and `custard-script.mjs`, written into new scripts in step 3.                                                                                                                                                                                |

Differences from the note above, found while building:

- **Python flags are `-E -s -B -X utf8 -X pycache_prefix=<a folder that never exists>`, not `-I`.** `-I` also removes the script's own folder from the import path, so a script couldn't import its helper or its own modules. `-E` and `-s` keep the rest of what `-I` gave.
- **No bytecode in the approved copy.** `-B` plus the never-existing cache prefix means Python neither writes nor reads `.pyc` files there, and the hash check refuses any `__pycache__` or `.pyc` found in `approved/`, since a planted one could run code nobody reviewed.
- **Node packages go in `scripts/<id>/node_modules/`**, next to `approved/`, because Node looks for packages in the folders above the entry file. Python's venv stays in `env/`.
- **The result line has a marker** (`@custard-result `), so a script's own printing can't be mistaken for its answer.

Tests: 35 new unit tests in `src/main/scripts/` using the real Python 3.13 and
Node 22 in the container (approval and tamper checks, a planted `.pyc`,
environment scrubbing, shell characters in input, timeout, Stop, output cap,
the whole process tree being killed, one run at a time, venv preference, Node
scripts). The tree-kill test fails if only the interpreter is killed (checked
by temporarily changing the code). Full unit suite: 1,640 passed, 2 skipped.

Not verified: Windows (the launcher list, the Store alias, `taskkill`) and
macOS. The Windows discovery paths are tested with a simulated file system only.

## Step 2 as built

Script tools in Chat, Settings → Scripts. User doc: `docs/scripts.md`.

- **Settings → Scripts** (General tab, under Memory): the switch (off), the
  risk statement, Python and Node.js with Find (lists what is installed,
  with versions) / Use / Browse / Clear, Stop all while a script runs, and a
  list of scripts with their approval and any problem. Stored in
  settings.json under `scripts`. Turning it off stops running scripts.
- **Chat only.** A new tool kind `script` in `modes/policy.ts`, allowed in
  Chat mode only, so Design, Skills, Plugins and automations never offer or
  run one.
- **Offered** (`scripts/tools.ts`) only while the switch is on, for scripts
  that are approved, on and in Chat, tied to the approval's digest.
- **Every call asks** with the script's own card: that it runs as you,
  name, version, runtime, tool, the declarations marked "not enforced", and
  the whole input. Read tools offer Allow for this chat (keyed to the
  approval); write tools never do. A repeat of a write whose outcome is
  unknown carries the warning on the same card.
- **Stale calls** are refused before the card and again at the run (the
  digest is checked against the approved copy's hash in one step).
- **Results** are fenced with `fenceResult` (source `script:<id>`, 12,000
  characters) and count as outside text. A write cut short or ended without
  answering is "outcome unknown"; one that answered with an error is
  "failed".
- **Stop** in the chat aborts the run, which kills the process tree.
- `docs/plugins/SECURITY.md` now says plugins still can't start a process
  and scripts are the separate, user-approved exception.

Not in step 2: creating, editing, testing and approving scripts, the "Use in
Chat" switch, and installing packages. Those are step 3 (Plugins mode).
Until then a script can only be set up by hand on disk.

Tests: unit 1,647 passed, 2 skipped (7 new for the chat tools and mode policy). New e2e `test/e2e/scripts.mjs` with
`test/e2e/mocks/s-scripts.mjs`: 25 checks, 0 failed (off by default, risk
shown, Find/Use the real Python, nothing offered or run while off, the card
and its options, the fenced result, a declined write runs nothing, Stop kills
the process, Design offers nothing, off again). Re-run to check nothing else
changed: interrupt 29/0, hardening 32/0, modes 34/0 (34 before too),
provider-requests 51/0.
