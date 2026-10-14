# plugin.json (manifest version 1)

```json
{
  "manifestVersion": 1,
  "id": "weather",
  "name": "Weather",
  "description": "Current weather for a city.",
  "version": "1.0.0",
  "apiVersion": 1,
  "entry": "src/index.ts",
  "instructions": "instructions.md",
  "permissions": {
    "network": ["api.weather.example"],
    "openExternal": [],
    "storage": false
  },
  "config": {
    "units": {
      "type": "string",
      "title": "Units",
      "enum": ["metric", "imperial"],
      "default": "metric"
    },
    "apiKey": { "type": "string", "title": "API key", "secret": true }
  },
  "tools": [
    {
      "name": "current",
      "description": "Current weather for a city. Use when the user asks about the weather now.",
      "effect": "read",
      "label": "Checked the weather in {city}",
      "timeoutMs": 15000,
      "inputSchema": {
        "type": "object",
        "properties": { "city": { "type": "string", "minLength": 1, "maxLength": 100 } },
        "required": ["city"],
        "additionalProperties": false
      }
    }
  ]
}
```

Unknown fields are errors, so a typo can't silently drop a restriction.

| Field                      | Rules                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `manifestVersion`          | `1`                                                                                                                                                                                                                                                                                                                                                              |
| `id`                       | 2 to 31 characters: lowercase letters, digits, `-`; starts with a letter; equals the folder name. `vault`, `fs`, `reference`, `plugin`, `custard` and `core` are reserved.                                                                                                                                                                                       |
| `name`, `description`      | 1–60 and 1–300 characters                                                                                                                                                                                                                                                                                                                                        |
| `version`                  | Semver, like `1.2.0`. Shown in review and rollback.                                                                                                                                                                                                                                                                                                              |
| `apiVersion`               | The SDK version the plugin targets. This Custard supports `1`; others are refused with a clear message.                                                                                                                                                                                                                                                          |
| `entry`                    | Relative `.ts` or `.js` file inside the folder                                                                                                                                                                                                                                                                                                                   |
| `instructions`             | Optional relative `.md` file of up to 8,000 characters, added to the system prompt while the plugin is enabled. Say when to use the tools and any rules.                                                                                                                                                                                                         |
| `permissions.network`      | Exact host names, `*.example.com`, or `"*"` for any public host. No IPs or local names.                                                                                                                                                                                                                                                                          |
| `permissions.openExternal` | Link prefixes the plugin may open: an https prefix ending in `/`, or a custom scheme Custard has vetted (today only `"spotify:"`). Any other scheme is a manifest error. Only write tools (actions) can open links.                                                                                                                                              |
| `permissions.storage`      | `true` to use `ctx.storage`                                                                                                                                                                                                                                                                                                                                      |
| `config`                   | Settings fields for the form in Plugins mode (**Manage** on the plugin's card). `type` is `string`, `number` or `boolean`, and `title` is required. Optional: `description`, `enum` (strings), `pattern`, `minimum`, `maximum`, `default`, `required`. `secret: true` (strings only) stores the value in OS secure storage; plugins never receive secret values. |
| `auth`                     | Optional account sign-in (see below)                                                                                                                                                                                                                                                                                                                             |
| `tools`                    | 1 to 32 tools (see below)                                                                                                                                                                                                                                                                                                                                        |

## Tools

| Field         | Rules                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`        | Lowercase letters, digits and `_`, up to 41 characters. The model sees `<id>__<name>`, which must fit in 64 characters.                                                                                                                                                                                                                                                                                                                                                                                                      |
| `description` | 1–1,024 characters. Say what it does and when to use it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `effect`      | `"read"` or `"write"`. Write tools change something outside Custard. Custard asks the user before each call, unless the user turned that off for that tool. Each write tool is also a permission (`action:<name>`), so adding one needs approval. A `read` tool may only GET or HEAD (no body) through `ctx.fetch`, in every mode; declare a tool that POSTs, PUTs, PATCHes or DELETEs as `write`. Chat, Design and Skills run a plugin only after the user turns on "Use in Chat and Design" for it.                        |
| `inputSchema` | JSON Schema subset, checked by the host before every call. The top level must be `"type": "object"`. Supported keywords: `type` (object, string, integer, number, boolean, array), `description`, `properties`, `required`, `additionalProperties`, `items`, `enum`, `minimum`, `maximum`, `minLength`, `maxLength`, `pattern`, `minItems`, `maxItems`. Anything else is a validation error. A `pattern` that takes over 100 ms on one value is refused for the rest of the session, and values it would check are rejected. |
| `label`       | Optional chat label with `{field}` placeholders. An array placeholder shows its length.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `timeoutMs`   | 1,000–60,000. The default is 20,000.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

## Accounts

```json
"auth": {
  "type": "oauth-pkce",
  "authorizeUrl": "https://accounts.example.com/authorize",
  "tokenUrl": "https://accounts.example.com/api/token",
  "redirectPort": 43821,
  "redirectPath": "/callback",
  "scopes": ["read"],
  "clientIdConfigKey": "clientId",
  "apiHosts": ["api.example.com"]
}
```

- Both URLs must be https.
- The `tokenUrl` host must be in `permissions.network`.
- `clientIdConfigKey` must name a non-secret string config field.
- `apiHosts` lists the exact hosts that receive the token, and each must also be in `permissions.network`.
- The redirect URI to register with the provider is `http://127.0.0.1:<redirectPort><redirectPath>`.

## Widgets

`widgets` (optional) declares UI the plugin draws next to the message box. Each widget needs its own permission, `widget:<id>`. The fields, the widget API and its rules are in [WIDGETS.md](WIDGETS.md).

## Media

`media` (optional) offers image or video generation to Design. Manifests without it are unchanged. Each entry is one provider:

```json
"media": [
  {
    "id": "video",
    "name": "Example video",
    "capabilities": [
      {
        "operation": "video.text-to-video",
        "formats": ["video/mp4"],
        "durations": { "min": 2, "max": 10 },
        "progress": true,
        "cancel": true,
        "idempotency": false,
        "minPollSeconds": 5,
        "pricing": { "text": "$0.10 per second", "source": "example.com/pricing" },
        "tools": { "submit": "submit", "status": "status", "result": "result", "cancel": "cancel" }
      }
    ]
  }
]
```

- At most 4 providers. `id` is lowercase letters, digits or hyphens; `name` is 1 to 60 characters.
- Each capability is checked by Design's rules (operations, output types, references, sizes, durations, pricing with its source); see [docs/design/CONTRACTS.md](../design/CONTRACTS.md).
- `tools.submit` must be a `write` tool. `tools.status` and `tools.result` must be `read` tools. `tools.cancel` must be a `write` tool (cancelling changes the job at the provider), required exactly when `cancel` is true. Custard calls it only on the user's explicit go-ahead for that job.
- The submit tool's `inputSchema` must declare `operation`, `prompt` and `idempotencyKey`, plus `references`, `size`, `durationSeconds` and `format` when the capability takes them (`format` only when it lists more than one). Status, result and cancel tools must require `remoteId`.
- None of these tools may also be a widget's tool.
- Each provider needs its own permission, `media:<id>`.
- These tools are not offered to the assistant as plain tools. Only Design's job flow calls them, through the plugin host's usual checks.

What the tools receive and return, and how Design approves and tracks jobs, is in [docs/design/MEDIA-PLUGINS.md](../design/MEDIA-PLUGINS.md).

## Fills

`fills` (optional) says which capability gaps one of the plugin's tools fills for a model that lacks them. Settings → Capabilities then recommends the plugin for those gaps. Manifests without it are unchanged.

> `fills` is a declaration that your plugin's tool actually fills this capability gap. Don't guess.
> For example, if your plugin has a `search` tool that calls Serper, declare `fills: [{ capability: "web_search", tool: "search" }]`.
> If your plugin can't fill a capability, don't declare it. Custard trusts this claim and shows it to users.

```json
"fills": [{ "capability": "web_search", "tool": "search" }]
```

- `capability` is one of `web_search`, `pdf` or `vision`. Other capabilities are part of the model, and a manifest that names one is refused.
- `tool` must name one of the plugin's own tools, and not a media tool (chats never get those).
- The same capability and tool may be listed once. At most 6 entries.
- It asks for no permission and changes nothing a chat can do. It only changes what Settings → Capabilities says.

### How Custard recommends a plugin

Settings → Capabilities works out each provider's capabilities from Custard's own rules (see [providers.md](../providers.md#capabilities-in-settings)). For each capability that some of a provider's models lack, it writes one recommendation:

| The gap                                                                  | What Settings says                                                                                                                      |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| An installed plugin declares `fills` for it, and is on                   | "DeepSeek lacks web search. The Serper plugin can fill this gap with its search tool. It is on."                                        |
| An installed plugin declares `fills` for it, and is off or not activated | "DeepSeek lacks web search. The Serper plugin can fill this gap with its search tool. Turn it on in Plugins to use it."                 |
| No installed plugin declares it                                          | "DeepSeek lacks web search. No plugin available yet. One could be built with a web search tool (a Serper or Brave Search plugin, say)." |
| A capability no plugin can fill                                          | "OpenAI lacks fallback on decline. No plugin can add this: it is part of the model."                                                    |

When only some of a provider's models lack it, the sentence names them: "DeepSeek V4 Pro lacks image input (DeepSeek Flash has it)."

What "One could be built with…" says for each fillable capability:

| `capability` | Gap                            | A plugin that fills it                                   |
| ------------ | ------------------------------ | -------------------------------------------------------- |
| `web_search` | The model can't search the web | a web search tool (a Serper or Brave Search plugin, say) |
| `pdf`        | The model can't read PDFs      | a tool that turns a PDF into text                        |
| `vision`     | The model can't see images     | a tool that describes an image                           |

Rules the recommendation follows:

- **Only declarations count.** Custard has no built-in list of plugins for a gap. The candidates are the installed plugins whose manifest declares `fills`. Custard never guesses from a tool's name: Spotify has a tool called `search`, and it is never recommended for web search.
- **Installed, on or off.** A plugin is recommended whether or not it is on; turning it on or off changes only the last sentence.
- **One plugin per gap.** If several installed plugins declare the same gap, the first by plugin id is named.
- **Never acts.** Recommending doesn't install, activate, turn on or configure a plugin, and doesn't grant a permission. The user turns it on in Plugins mode as usual, with the usual permission review.
- **Local only.** The scan reads the manifests on this computer. It calls no provider, no model and no plugin tool.

Next to a gap with no plugin, Settings → Capabilities offers **Start building**. It makes a new plugin like New plugin does and opens its workspace with a starter prompt from the `plugin-discovery` skill, for any gap, including the ones `fills` can't name. The result is an ordinary plugin: once it declares `fills` for a gap it really fills, Refresh shows it there.

### Declaring `fills`: examples

A web search plugin whose `search` tool calls Serper:

```json
{
  "id": "serper",
  "name": "Serper",
  "permissions": { "network": ["google.serper.dev"], "openExternal": [], "storage": false },
  "tools": [
    {
      "name": "search",
      "description": "Search the web. Returns titles, links and snippets.",
      "effect": "read",
      "label": "Searched the web for \"{query}\"",
      "inputSchema": {
        "type": "object",
        "properties": { "query": { "type": "string", "maxLength": 200 } },
        "required": ["query"]
      }
    }
  ],
  "fills": [{ "capability": "web_search", "tool": "search" }]
}
```

An image description plugin, whose `describe_image` tool sends an image to a vision service and returns text:

```json
"fills": [{ "capability": "vision", "tool": "describe_image" }]
```

A PDF parser, whose `pdf_text` tool returns the text of a PDF:

```json
"fills": [{ "capability": "pdf", "tool": "pdf_text" }]
```

One plugin can fill more than one gap, each with its own tool:

```json
"fills": [
  { "capability": "pdf", "tool": "pdf_text" },
  { "capability": "vision", "tool": "describe_image" }
]
```

(The other manifest fields are left out of the last three examples.)

Before you declare a gap, check that your tool really covers it for a model that lacks the capability:

- **`web_search`:** the tool takes a query and returns current results from the web, not from one site's catalogue. A music or shop search doesn't count.
- **`pdf`:** the tool takes a PDF the user has and returns its text.
- **`vision`:** the tool takes an image and returns a description the model can read.

If your tool does only part of this, don't declare it. Users see the claim in Settings and will turn your plugin on because of it.

All capabilities are listed in `src/shared/adapter.ts` (`capabilities`, with their names in `capabilityLabels`). Only the three above can go in `fills`.

## Permissions as the user sees them

Activation shows each requested permission in plain words, and the user ticks every new one:

| String                                       | Meaning                                           |
| -------------------------------------------- | ------------------------------------------------- |
| `network:<host>`                             | Connect to a host                                 |
| `open:<prefix>`                              | Open links with that prefix                       |
| `storage`                                    | Store its own data                                |
| `account:<host>` and `account-scope:<scope>` | Sign in to an account, and each scope it asks for |
| `action:<tool>`                              | Run a write tool                                  |
| `widget:<id>`                                | Show that widget in chats                         |
| `media:<id>`                                 | Offer that image or video provider to Design      |

Grants are stored per plugin and shrink to what the active version asks for. An update that asks for anything new must be approved again. Rolling back to a version that needs a permission since dropped also asks again.
