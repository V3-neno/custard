# Plugin API (version 1)

A Custard plugin is a folder in `plugin/<id>/` with a manifest (`plugin.json`, see [MANIFEST.md](MANIFEST.md)), TypeScript source and tests. Plugins add **tools** the assistant can call, in every mode and with either provider (Claude or OpenAI).

```ts
// plugin/hello/src/index.ts
import { definePlugin, PluginError } from 'custard-plugin-sdk'

export default definePlugin({
  tools: {
    // One handler per tool in plugin.json, by its short name.
    greet: async ({ name }: { name: string }, ctx) => {
      const res = await ctx.fetch(`https://api.example.com/hello?name=${encodeURIComponent(name)}`)
      if (!res.ok) throw new PluginError(`The greeting service answered ${res.status}.`)
      return (await res.json<{ text: string }>()).text
    }
  }
})
```

## Where plugin code runs

Each enabled plugin runs in its own hidden, sandboxed Chromium window:

- There is no Node.js (`require`, `process`, `fs` don't exist) and no Electron.
- It has no direct network. `fetch`, XHR, WebSocket, images, iframes, beacons and navigation are blocked in three independent ways.
- Everything else goes through `ctx`. The host checks every call against the permissions the user approved.
- A plugin only runs inside a tool call. There are no background tasks. Capability calls made outside an active call are refused.
- Inputs are validated against the tool's `inputSchema` before your handler runs.

## Handlers

```ts
type ToolHandler<I> = (input: I, ctx: PluginContext) => ToolResult | Promise<ToolResult>
type ToolResult = string | { content: string; isError?: boolean; data?: unknown }
```

- Return a string for success, or `{ content, isError: true }` for a failure the model should see.
- `data` is for the plugin's own widgets only (see [WIDGETS.md](WIDGETS.md)). The model and the chat get `content`, never `data`.
- Throw `PluginError` for an expected failure; its message reaches the model as written. Any other thrown error is reported as "The plugin failed: …".
- Results are capped at 50,000 characters and redacted: known secrets, `Bearer …` values and token-looking fields are replaced with `[redacted]`.
- Each call has a timeout: the tool's `timeoutMs`, or 20 seconds by default and 60 seconds at most. On timeout or cancel, `ctx.signal` is aborted. If the plugin doesn't respond within 2 seconds after that (for example, a busy loop), its window is killed and restarted on the next call.

## `ctx`

| Member                                           | What it does                                                                            | Needs                                                                                                                                                  |
| ------------------------------------------------ | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ctx.signal`                                     | `AbortSignal`, aborted on timeout, Stop, or disable                                     | —                                                                                                                                                      |
| `ctx.caller`                                     | Who started the call: `assistant`, `widget`, `automation` or `design` (see below)       | —                                                                                                                                                      |
| `ctx.fetch(url, init?)`                          | HTTPS request through the host. Returns `{ status, ok, headers.get(), text(), json() }` | `permissions.network` lists the host                                                                                                                   |
| `ctx.fetch(url, { auth: true })`                 | Same, and the host adds `Authorization: Bearer <token>` for the signed-in account       | `auth` in the manifest; only for `auth.apiHosts`                                                                                                       |
| `ctx.events.enabled`, `ctx.events.append(entry)` | Adds an entry to the plugin's event log in the user's vault (see below)                 | `permissions.events: true`, and the user turned the log on                                                                                             |
| `ctx.storage.get/set/delete(key)`                | Plugin-scoped JSON storage, 1 MB in total                                               | `permissions.storage: true`                                                                                                                            |
| `ctx.config`                                     | The user's non-secret configuration values, with defaults                               | —                                                                                                                                                      |
| `ctx.openExternal(url)`                          | Asks the OS to open a link                                                              | URL starts with a prefix in `permissions.openExternal` and uses only plain URL characters (no spaces, quotes, backslashes or non-ASCII; use %-escapes) |
| `ctx.log(message)`                               | A line in the plugin's log in Settings (redacted, last 50 kept)                         | —                                                                                                                                                      |

### `ctx.caller`

Custard sets it from where the call came in. The model, a widget's input and the plugin can't choose it.

| Value        | The call came from                                                                                                                                           |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `assistant`  | A tool call in a model's reply, in any mode                                                                                                                  |
| `widget`     | The plugin's own widget. For a write tool this also means the user pressed something in it: Custard refuses a widget write without a real click or key press |
| `automation` | A scheduled skill run (read tools only; writes are declined there)                                                                                           |
| `design`     | Design's media jobs                                                                                                                                          |

Use it to tell the user's own presses apart from the assistant's actions, for example in a log. It says where the call came from, not that the plugin's code is honest about it afterwards. In tests, `createContext({ caller: 'widget' })`; the default is `assistant`.

### `ctx.events`

An append-only log of things that happened, kept in the user's Obsidian vault so the user (and later skills) can read it. One note per day:

```
Custard/Plugins/<plugin folder>/Events/2026-10/2026-10-20.md
```

```ts
if (ctx.events.enabled)
  await ctx.events.append({
    at: new Date().toISOString(), // picks the day, in the plugin's timeZone setting or the system's
    record: { type: 'skip', source: ctx.caller, title: track.name }
  })
```

- **Two gates, both the user's.** The manifest asks for `permissions.events`, which the user approves at review. Then the user turns the log on in the plugin's **Manage** panel. It is off by default. While it is off, `enabled` is `false` and `append` throws.
- **Only adds.** A plugin can't name a path, read the log, or change or delete anything. Custard picks the note from `at`, which must be within the last 24 hours. It makes the note with a short header the first time, and after that only adds to the end.
- **Custard writes the text.** Each record becomes one line of JSON inside its own fenced block with the language `custard-event`. Obsidian shows it as plain text, so a title holding `[[...]]`, `#tags`, links or HTML stays inert.
- **Limits.** A record can be at most 4 KB of JSON, nested at most 4 levels, and hold at most 40 fields per object and 50 items per list. Field names are letters, digits and `_`. Strings are cut to 300 characters, with control characters removed.
- **Rates.** At most 20 entries per tool call and 600 per hour. A day's note stops taking entries at 1 MB.
- **Secrets are refused.** A record holding one of the plugin's secrets, or anything shaped like a token (`Bearer …`, `access_token`, …), is refused and not written.
- **Any tool may log, read tools too.** The log isn't an action outside Custard, so it asks for no approval.
- **Don't let the log change your result.** Catch errors from `append`. A tool's outcome shouldn't depend on whether the log worked.
- **The assistant can't edit the log.** The `Events` folder can't be added to Editable folders. A chat that reads a log note counts as having outside text.

Manage shows whether logging is on, how many entries today's note holds, and the last failure. In tests, use `createContext({ events: true })` and read `ctx.events.entries`.

### `ctx.fetch` rules (enforced by the host)

- Only `https:` on the default port, with no credentials in the URL.
- The host must match `permissions.network` exactly, or by `*.example.com`, or `"*"` (any public host).
- IP addresses, `localhost`, `*.local` and `*.localhost` are refused.
- Every address a host name resolves to is checked when connecting. Loopback, private ranges, link-local (including cloud metadata `169.254.169.254`), CGNAT, multicast, unique-local IPv6, IPv4-mapped IPv6 and NAT64 are refused, so DNS can't be used to reach local machines.
- Redirects are followed by the host, up to 5, and each hop is checked the same way. The auth token is added per hop, only for `auth.apiHosts`, so it never follows a redirect elsewhere.
- Methods: GET, POST, PUT, PATCH, DELETE, HEAD. Bodies are strings of 1 MB at most, and responses are limited to 5 MB. Requests time out after 20 seconds.
- `Host`, `Cookie`, `Connection`, `Content-Length` and similar headers set by the plugin are dropped. There is no cookie jar.
- If a request with `auth: true` gets a 401, the host refreshes the token once and retries. The retry is safe because a rejected token means nothing was done.

## Accounts (OAuth)

If the manifest has an `auth` block, Plugins mode (**Manage** on the plugin's card) shows **Connect**, and the host runs Authorization Code with PKCE:

1. It opens the provider's consent page in the browser.
2. It receives the redirect on `http://127.0.0.1:<redirectPort><redirectPath>`, checks `state`, and exchanges the code.
3. It stores the tokens in OS secure storage (`safeStorage`).

Tokens never enter plugin code, the model's context, the vault or logs. **Disconnect** deletes them on this computer. Changing the Client ID setting also signs out.

## What API v1 does not have

- No vault or file access, except adding to its own event log (`ctx.events`).
- No UI in tool code. A plugin can draw UI only in a widget (see [WIDGETS.md](WIDGETS.md)).
- No background work or timers outside a call.
- No npm packages or Node modules.
- No raw sockets.
- No access to other plugins or to Custard's settings.

If a plugin needs one of these, it needs a core change to the host and SDK, proposed and reviewed on its own.

## Tool names

The model sees `<plugin id>__<tool>`, e.g. `spotify__search`. Both providers require `^[a-zA-Z0-9_-]{1,64}$`, so the dotted form `spotify.search` can't be used. Plugin ids can't contain `_`, so the split is unambiguous.

## Tests

Put tests in `tests/*.test.ts`:

```ts
import { assert, createContext, response, test } from 'custard-plugin-sdk/testing'
import plugin from '../src/index'

test('greets', async () => {
  const ctx = createContext({ fetch: () => response(200, { text: 'Hello, Neno' }) })
  assert.equal(await plugin.tools.greet({ name: 'Neno' }, ctx), 'Hello, Neno')
  assert.equal(ctx.calls.length, 1)
})
```

- `createContext({ fetch, config })` returns a fake `ctx`. It records `calls`, `opened` and `logs`, and keeps storage in memory.
- `response(status, body, headers)` builds a fake response.
- `assert(cond)`, `assert.equal`, `assert.deepEqual`, `assert.match` and `assert.notMatch` are available.

Tests run in two places:

- **In Custard:** the Plugins workspace's `plugin_test` tool, or **Run tests** on the review screen. Each run uses a fresh sandbox with no network and no host capabilities.
- **In this repo:** `npm test`, under vitest, via `src/plugin-sdk/plugin-tests.test.ts`.
