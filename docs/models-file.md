# The models file (models.json)

Custard's built-in models are in `src/shared/models.ts`. You can add models for the built-in providers (Claude, OpenAI, DeepSeek), or change a built-in model, in **models.json** in Custard's data folder. That is the folder `settings.json` is in: Electron's `userData`, which is `%APPDATA%\Custard` on Windows. Settings → General → Models file shows the exact path.

- **When it's read:** Custard reads the file at startup and when you press **Reload** under Settings → Models file. It never watches the file and never reads it in the background.
- **What it can't do:** add a provider, an address, a key or code. A model from the file is reached through its provider's own adapter, saved key and pinned address, exactly like a built-in model of that provider.
- **While something is running:** Reload waits while a chat is answering or being continued, or while an automation runs. That way no running turn sees its model change.

## Format

```json
{
  "version": 1,
  "models": [
    {
      "id": "deepseek-v5-preview",
      "provider": "deepseek",
      "label": "DeepSeek V5 Preview",
      "limits": { "window": 1000000, "maxOutput": 384000 },
      "prices": { "input": 1.5, "cacheWrite": 1.5, "cacheRead": 0.05, "output": 4.5 },
      "effort": true,
      "files": { "images": true }
    },
    {
      "id": "claude-haiku-4-5",
      "provider": "claude",
      "label": "Haiku 4.5 (cheap notes)",
      "limits": { "maxOutput": 32000 }
    }
  ]
}
```

The first entry adds a model. The second customises the built-in Haiku 4.5: only the fields it gives change, and Settings marks it **customised**.

### Fields

| Field        | Required             | What it is                                                                                                                                                                                                   | If left out (new model)                                |
| ------------ | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| `id`         | yes                  | The id the provider uses: 1 to 80 characters of `a-z 0-9 . _ : / -`                                                                                                                                          |                                                        |
| `provider`   | yes                  | `claude`, `openai` or `deepseek`                                                                                                                                                                             |                                                        |
| `label`      | yes, for a new model | The name in the picker, 1 to 60 characters                                                                                                                                                                   |                                                        |
| `limits`     | yes, for a new model | `window`: input and output together, 1,000 to 10,000,000 tokens. `maxOutput`: 1 up to the window                                                                                                             |                                                        |
| `prices`     | no                   | Dollars per million tokens, each 0 to 1,000: `input`, `cacheWrite`, `cacheRead`, `output`, and optionally `long` (the same four plus `over`, the input tokens above which they apply). `null` means unpriced | unpriced: the meter counts its calls as unpriced       |
| `effort`     | no                   | `true`: the provider's own effort levels. `false`: none. An object `{ levels, otherwise }` is accepted when it is the same as the provider's levels                                                          | none: no effort is sent and the buttons are greyed out |
| `files`      | no                   | `images`, `pdf` (true or false) and `imageTokens` (`claude` or `claude-small` for Claude; `patches` for OpenAI and DeepSeek)                                                                                 | text only                                              |
| `search`     | no                   | Claude: `claude-20260209` or `claude-20250305`. OpenAI and DeepSeek: `responses`. Or `false`                                                                                                                 | no search                                              |
| `compaction` | no                   | Server-side compaction of long chats                                                                                                                                                                         | off                                                    |
| `thinking`   | no                   | Claude's adaptive thinking. OpenAI and DeepSeek models always reason, so it changes nothing there                                                                                                            | off                                                    |
| `fallbacks`  | no                   | Claude's server-side fallback. Claude only                                                                                                                                                                   | off                                                    |

**Haiku 4.5 takes no effort.** A customisation of `claude-haiku-4-5` that gives it `effort` is rejected: Anthropic's API refuses an effort on that model, and Claude summaries and automation steps would send one. It is known by its id only; the same model added under another id can't be told apart.

**Effort names.** Effort levels use only Custard's five names: `low`, `medium`, `high`, `xhigh` and `max`, both as stored and as sent. The file can't add other names (Qwen's `none`, say). The picker shows one set of effort buttons per provider, so a model's levels must be its provider's.

## What is checked

- **Every field:** any field not in the table above rejects the entry, at any depth. That includes a typo such as `contextWindo`, and an `apiKey` or `baseURL`. So does `live`: only tests Custard ran itself mark a capability live.
- **Duplicates:** an id that appears twice in the file rejects every entry with it.
- **Other providers' models:** an id that is another provider's built-in model is rejected.
- **Customisations:** an id that is the same provider's built-in model is a customisation. Its fields are laid over the built-in model, and `limits`, `files` and `prices` are merged field by field. The result is then checked as a whole, like a new model.

## What happens when something is wrong

| Case                                                                                                                                                  | Result                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| No file, or an empty one                                                                                                                              | Nothing is loaded. The built-in models are used.                                                                            |
| Not JSON, not an object, a version other than 1, an unknown top-level field, `models` not a list, more than 200 models, more than 1 MB, or unreadable | **No entry is loaded.** Settings shows why. The built-in models are unaffected.                                             |
| A bad entry                                                                                                                                           | That entry is skipped and listed under "Not loaded" with the reason. The others load. An entry is used whole or not at all. |
| A customisation that breaks a rule                                                                                                                    | It is rejected, and the built-in model stays as it was.                                                                     |
| After Reload, a chat's model is no longer in the file                                                                                                 | The chat says "_id_ can't be used right now. Its profile is missing." and nothing is sent until another model is picked.    |

## Capabilities

Settings → Capabilities marks what the file decides as `docs`, noted "From your models file". That is every capability of a model the file adds. For a customised built-in model, it is the capabilities decided by the fields the file changed: `files` for images and PDFs, `thinking`, `effort`, `search`, `compaction` and `fallbacks`. A built-in model's `live` evidence stays for everything else. Changing only the label, the limits or the prices keeps all of it.
