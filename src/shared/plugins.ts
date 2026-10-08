// Types shared by the plugin host (main process) and the Settings UI.
// The manifest format itself is documented in docs/plugins/MANIFEST.md.

export const PLUGIN_API_VERSION = 1
export const SUPPORTED_API_VERSIONS = [1]

export type JsonSchema = {
  type?: 'object' | 'string' | 'integer' | 'number' | 'boolean' | 'array'
  description?: string
  properties?: Record<string, JsonSchema>
  required?: string[]
  additionalProperties?: boolean
  items?: JsonSchema
  enum?: (string | number)[]
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  pattern?: string
  minItems?: number
  maxItems?: number
}

export type ConfigField = {
  type: 'string' | 'number' | 'boolean'
  title: string
  description?: string
  enum?: string[]
  pattern?: string
  minimum?: number
  maximum?: number
  default?: string | number | boolean
  required?: boolean
  // Secret fields go to OS secure storage and are never given to plugin code.
  secret?: boolean
}

export type ToolSpec = {
  name: string
  description: string
  inputSchema: JsonSchema
  // "write" tools change something outside Custard; the user is asked before each call.
  effect: 'read' | 'write'
  // Shown in the chat, with {field} replaced by that input value.
  label?: string
  timeoutMs?: number
}

export type OAuthSpec = {
  type: 'oauth-pkce'
  authorizeUrl: string
  tokenUrl: string
  redirectPort: number
  redirectPath: string
  scopes: string[]
  clientIdConfigKey: string
  // The host adds the access token only to requests for these hosts.
  apiHosts: string[]
}

export type PluginManifest = {
  manifestVersion: 1
  id: string
  name: string
  description: string
  version: string
  apiVersion: number
  entry: string
  permissions: {
    network: string[]
    openExternal: string[]
    storage: boolean
  }
  tools: ToolSpec[]
  config: Record<string, ConfigField>
  auth?: OAuthSpec
  instructions?: string
}

export type BuildInfo = { buildId: string; version: string; builtAt: number }

export type PluginState = 'not-activated' | 'enabled' | 'disabled'

export type PluginStatus = {
  id: string
  dir: string
  name: string
  description: string
  version: string
  // Problems with the source in plugin/<id>; the active build may still be fine.
  sourceErrors: string[]
  state: PluginState
  running: boolean
  active: BuildInfo | null
  previous: BuildInfo | null
  sourceChanged: boolean
  requested: string[]
  granted: string[]
  config: {
    fields: Record<string, ConfigField>
    values: Record<string, string | number | boolean>
    secretsSet: string[]
  }
  auth: { connected: boolean } | null
  // Saved secrets exist but can't be decrypted now. They're kept untouched;
  // changing them waits until they can be read or the user resets them.
  secretsLocked?: boolean
  tools: { name: string; fullName: string; effect: 'read' | 'write'; askEveryTime: boolean }[]
  errors: { at: number; message: string }[]
  log: string[]
}

export type FileChange = { path: string; change: 'added' | 'removed' | 'changed'; diff?: string }

export type PluginReview = {
  id: string
  ok: boolean
  errors: string[]
  warnings: string[]
  manifest: PluginManifest | null
  version: { from: string | null; to: string | null }
  newPermissions: string[]
  removedPermissions: string[]
  files: FileChange[]
  buildId: string | null
}

export type TestReport = {
  ok: boolean
  results: { name: string; ok: boolean; error?: string }[]
  error?: string
}

// Code-mode workspaces, stored on the conversation.
export type Workspace =
  { kind: 'internal'; pluginId: string } | { kind: 'general'; root: string; coreAccess?: boolean }

// "Ask every time" is the default for write tools unless the user changes it.
export type SecurityDefaults = { askBeforeWriteTools: boolean }

// Plain-language versions of permission strings, for the review screen.
export function describePermission(p: string): string {
  const [kind, ...rest] = p.split(':')
  const v = rest.join(':')
  switch (kind) {
    case 'network':
      return v === '*' ? 'Connect to any public website' : `Connect to ${v}`
    case 'open':
      return `Open ${v} links on this computer`
    case 'storage':
      return 'Store its own data in Custard'
    case 'account':
      return `Sign in to your account at ${v}`
    case 'account-token':
      return `Send your account's sign-in codes and refresh token to ${v}`
    case 'account-api':
      return `Send your account's access token to ${v}`
    case 'account-scope':
      return `Account access: ${v}`
    case 'action':
      return `Run the "${v}" action (asks you first unless you turn that off)`
    default:
      return p
  }
}
