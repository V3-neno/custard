# Plugins

Plugins add tools to Custard's assistant. They are developed in **Plugins** mode, reviewed and activated with **Manage** on the plugin's card in Plugins mode, and run in sandboxes the host controls. Spotify is the first plugin, in `plugin/spotify`.

- [API.md](API.md): the plugin API (`custard-plugin-sdk`), where plugin code runs, and testing
- [MANIFEST.md](MANIFEST.md): `plugin.json`
- [SECURITY.md](SECURITY.md): what is enforced, how, and what isn't
- [WIDGETS.md](WIDGETS.md): plugin widgets, UI a plugin draws next to the message box
- [TESTING.md](TESTING.md): automated tests, the manual checklist and the demo walkthrough

## Lifecycle

**Create → Edit → Validate → Test → Review → Activate**, then optionally **Disable**, **Roll back** or **Uninstall**.

1. **Create.** In Plugins mode, click **New plugin**. Custard writes `plugin/<id>/` with a manifest, a working sample tool, a test and instructions. Or choose an existing plugin.
2. **Edit.** The assistant edits files only in `plugin/<id>`. It can read the docs, the SDK source and the Spotify example, read-only.
3. **Validate.** `plugin_validate` checks the manifest and bundles the code into a staged build, stored in Custard's data folder.
4. **Test.** `plugin_test` runs `tests/*.test.ts` and a load check in a sandbox.
5. **Review.** With **Manage** on its card in Plugins mode, **Review and activate** (or **Review update**) validates again and shows:
   - errors and warnings
   - the version change
   - a per-file diff against the active build
   - every new permission, each with a checkbox
   - **Run tests**
6. **Activate.** Needs every new permission ticked. Custard starts the new build. If it fails to load or lacks a handler for a declared tool, the previous version keeps running (automatic rollback) and the error is shown.

Editing files never changes the running plugin. Only activation does, so development changes stay separate from the active build. The assistant can't activate, enable or install anything.

### Disable, disconnect, uninstall, roll back

| Action                   | Effect                                                                                                                                                                                                                                                                      |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Disable**              | Tools are removed from the next request. New calls are refused, including stale calls the model makes from an older tool list. The sandbox is destroyed, so running calls end at once. Config, data, sign-in and builds are kept. **Enable** starts the active build again. |
| **Disconnect** (account) | Deletes the account tokens on this computer. The plugin stays enabled; calls that need the account fail with "not signed in". Providers without a revocation endpoint (Spotify) may still list the app until you remove it on their site.                                   |
| **Uninstall**            | Disables, then deletes everything Custard stores for the plugin: builds, state, granted permissions, config, data and secrets. The source in `plugin/<id>` is kept, so it shows as "Not activated" and can be activated again.                                              |
| **Roll back**            | Activates the previous build. Only one previous build is kept. If it needs a permission the current version dropped, you're asked again.                                                                                                                                    |

## Where things are stored

| What                        | Where                                                                                                                                                                                                                   |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source                      | `plugin/<id>/` in the repo (development). Packaged builds read `resources/plugin`, or `CUSTARD_PLUGIN_DIR`.                                                                                                             |
| State, builds, config, data | `<app data>/plugins/<id>/` (`state.json`, `builds/<buildId>/`, `config.json`, `data.json`)                                                                                                                              |
| Secrets and account tokens  | `<app data>/plugins/<id>/secrets.bin`, encrypted with Electron `safeStorage` (Windows DPAPI). Only Windows is supported; see [Credential storage on other systems](../../README.md#credential-storage-on-other-systems) |

- Tokens are never stored in manifests, Obsidian notes, model context or logs.
- Updates and rollbacks never touch config, data or secrets.
- Changing a plugin's Client ID setting signs its account out.

## How it fits into Custard

| Piece                                                                          | File                                                                  |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| Manifest checks, permissions, tool naming                                      | `src/main/plugins/manifest.ts`, `schema.ts`                           |
| Builds (esbuild, imports limited to the folder and SDK)                        | `src/main/plugins/build.ts`                                           |
| Host: discovery, review, activation, rollback, capabilities, invocation checks | `src/main/plugins/host.ts`                                            |
| Sandboxed runtime and IPC                                                      | `src/main/plugins/runtime.ts`, `src/preload/plugin.ts`                |
| Network policy                                                                 | `src/main/plugins/net.ts`                                             |
| OAuth PKCE                                                                     | `src/main/plugins/oauth.ts`                                           |
| State and secrets                                                              | `src/main/plugins/store.ts`                                           |
| Spotify settings migration                                                     | `src/main/plugins/migrate.ts`                                         |
| Electron wiring, IPC, workspace checks                                         | `src/main/plugins/index.ts`                                           |
| SDK, runtime and test helpers                                                  | `src/plugin-sdk/`                                                     |
| Workspace file tools and path checks                                           | `src/main/workspace/`                                                 |
| Chat integration (tools for both providers, approvals, stale history)          | `src/main/chat.ts`, `src/main/history.ts`                             |
| Plugins hub, Manage panel, review screen                                       | `src/renderer/src/components/hubs/PluginsHub.tsx`, `PluginDetail.tsx` |
| Code-mode workspace picker, approval cards                                     | `src/renderer/src/components/chat/WorkspaceBar.tsx`, `Working.tsx`    |

Plugin tools join the same `BetaTool[]` list as the vault tools, which `openai.ts` converts for OpenAI, so plugins work with both providers. When a tool from an earlier message isn't offered any more (plugin disabled, removed, or from another mode), that call is sent to the model as text, so the API doesn't need a definition for it.
