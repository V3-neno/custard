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
