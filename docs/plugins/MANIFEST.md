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

| Field                      | Rules                                                                                                                                                                                                                                                                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `manifestVersion`          | `1`                                                                                                                                                                                                                                                                                                                                  |
| `id`                       | 2 to 31 characters: lowercase letters, digits, `-`; starts with a letter; equals the folder name. `vault`, `fs`, `reference`, `plugin`, `custard` and `core` are reserved.                                                                                                                                                           |
| `name`, `description`      | 1–60 and 1–300 characters                                                                                                                                                                                                                                                                                                            |
| `version`                  | Semver, like `1.2.0`. Shown in review and rollback.                                                                                                                                                                                                                                                                                  |
| `apiVersion`               | The SDK version the plugin targets. This Custard supports `1`; others are refused with a clear message.                                                                                                                                                                                                                              |
| `entry`                    | Relative `.ts` or `.js` file inside the folder                                                                                                                                                                                                                                                                                       |
| `instructions`             | Optional relative `.md` file of up to 8,000 characters, added to the system prompt while the plugin is enabled. Say when to use the tools and any rules.                                                                                                                                                                             |
| `permissions.network`      | Exact host names, `*.example.com`, or `"*"` for any public host. No IPs or local names.                                                                                                                                                                                                                                              |
| `permissions.openExternal` | Link prefixes the plugin may open: a custom scheme like `"spotify:"`, or an https prefix ending in `/`. `file:`, `javascript:`, `http:`, `ms-*`, `search:`, `its:`, `vscode:` and similar schemes are refused. This is a list of known risky schemes, so it can't be complete: the user approves each scheme on the review screen.   |
| `permissions.storage`      | `true` to use `ctx.storage`                                                                                                                                                                                                                                                                                                          |
| `config`                   | Settings fields for the form in Settings → Plugins. `type` is `string`, `number` or `boolean`, and `title` is required. Optional: `description`, `enum` (strings), `pattern`, `minimum`, `maximum`, `default`, `required`. `secret: true` (strings only) stores the value in OS secure storage; plugins never receive secret values. |
| `auth`                     | Optional account sign-in (see below)                                                                                                                                                                                                                                                                                                 |
| `tools`                    | 1 to 32 tools (see below)                                                                                                                                                                                                                                                                                                            |

## Tools

| Field         | Rules                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`        | Lowercase letters, digits and `_`, up to 41 characters. The model sees `<id>__<name>`, which must fit in 64 characters.                                                                                                                                                                                                                                                                      |
| `description` | 1–1,024 characters. Say what it does and when to use it.                                                                                                                                                                                                                                                                                                                                     |
| `effect`      | `"read"` or `"write"`. Write tools change something outside Custard. Custard asks the user before each call, unless the user turned that off for that tool. Each write tool is also a permission (`action:<name>`), so adding one needs approval.                                                                                                                                            |
| `inputSchema` | JSON Schema subset, checked by the host before every call. The top level must be `"type": "object"`. Supported keywords: `type` (object, string, integer, number, boolean, array), `description`, `properties`, `required`, `additionalProperties`, `items`, `enum`, `minimum`, `maximum`, `minLength`, `maxLength`, `pattern`, `minItems`, `maxItems`. Anything else is a validation error. |
| `label`       | Optional chat label with `{field}` placeholders. An array placeholder shows its length.                                                                                                                                                                                                                                                                                                      |
| `timeoutMs`   | 1,000–60,000. The default is 20,000.                                                                                                                                                                                                                                                                                                                                                         |

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

## Permissions as the user sees them

Activation shows each requested permission in plain words, and the user ticks every new one:

| String                                       | Meaning                                           |
| -------------------------------------------- | ------------------------------------------------- |
| `network:<host>`                             | Connect to a host                                 |
| `open:<prefix>`                              | Open links with that prefix                       |
| `storage`                                    | Store its own data                                |
| `account:<host>` and `account-scope:<scope>` | Sign in to an account, and each scope it asks for |
| `action:<tool>`                              | Run a write tool                                  |

Grants are stored per plugin and shrink to what the active version asks for. An update that asks for anything new must be approved again. Rolling back to a version that needs a permission since dropped also asks again.
