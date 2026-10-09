import {
  SUPPORTED_API_VERSIONS,
  type ConfigField,
  type OAuthSpec,
  type PluginManifest,
  type ToolSpec
} from '../../shared/plugins'
import { checkSchema } from './schema'
import type { PluginMediaSpec } from '../../shared/design'
import { validateCapabilities } from '../design/media'
import {
  SUPPORTED_WIDGET_API_VERSIONS,
  WIDGET_LIMITS,
  type WidgetPresentation,
  type WidgetSpec
} from '../../shared/widgets'

// Mechanical checks on plugin.json. Passing them means the manifest is well
// formed and internally consistent, not that the plugin's code is safe or
// does what its descriptions say.

export const PLUGIN_ID = /^[a-z][a-z0-9-]{1,30}$/
const TOOL_NAME = /^[a-z][a-z0-9_]{0,40}$/
const CONFIG_KEY = /^[a-zA-Z][a-zA-Z0-9_]{0,40}$/
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const HOST = /^(\*\.)?([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/
// Schemes a plugin may never hand to the OS, even if declared.
const BLOCKED_SCHEMES = new Set([
  'file',
  'javascript',
  'data',
  'vbscript',
  'about',
  'blob',
  'chrome',
  'devtools',
  'http',
  'ftp',
  'smb',
  'jar',
  'search-ms',
  'search',
  'ms-msdt',
  'ms-settings',
  'shell',
  // Windows help, archive and remote-content handlers.
  'its',
  'mk',
  'hcp',
  'res',
  'mhtml',
  'jnlp',
  // Remote shares and logins.
  'ldap',
  'ssh',
  'telnet',
  'nfs',
  'dav',
  'webdav',
  'cifs',
  // Editors whose links can open terminals or install extensions.
  'vscode',
  'vscode-insiders',
  'cursor'
])

// What ctx.openExternal may pass on: unreserved and reserved URL characters
// (RFC 3986) and %-escapes, without "'". No spaces, quotes, backslashes or
// other characters an app's command line could read as more arguments.
export const PLAIN_URL =
  /^[A-Za-z0-9\-._~:/?#[\]@!$&()*+,;=]*(%[0-9A-Fa-f]{2}[A-Za-z0-9\-._~:/?#[\]@!$&()*+,;=]*)*$/

// Tool names as the model sees them. Both Claude and OpenAI require
// ^[a-zA-Z0-9_-]{1,64}$, so "spotify.search" becomes "spotify__search".
// Plugin ids can't contain "_", so the split is unambiguous.
export const SEP = '__'
export const fullToolName = (pluginId: string, tool: string): string => `${pluginId}${SEP}${tool}`
export function splitToolName(name: string): { pluginId: string; tool: string } | null {
  const i = name.indexOf(SEP)
  if (i <= 0) return null
  return { pluginId: name.slice(0, i), tool: name.slice(i + SEP.length) }
}

const isRelativePath = (p: unknown): p is string =>
  typeof p === 'string' &&
  p.length > 0 &&
  p.length < 200 &&
  !/^([a-zA-Z]:|[\\/])/.test(p) &&
  !p.split(/[\\/]/).some((s) => s === '..' || s === '' || s.startsWith('.')) &&
  !/[:\0]/.test(p)

// Custom schemes a plugin may open: an allowlist, because any app can
// register a scheme and some can write files (obsidian://new), start tools
// or run automations. Add one only after checking what its handler does.
export const VETTED_SCHEMES = new Set(['spotify'])

export function validOpenPrefix(p: unknown): p is string {
  if (typeof p !== 'string' || p.length > 200) return false
  const scheme = /^([a-z][a-z0-9+.-]*):/.exec(p)?.[1]
  if (!scheme || BLOCKED_SCHEMES.has(scheme) || scheme.startsWith('ms-')) return false
  if (scheme === 'https') {
    try {
      const u = new URL(p)
      return HOST.test(u.hostname) && !u.hostname.startsWith('*') && p.startsWith(`${u.origin}/`)
    } catch {
      return false
    }
  }
  return VETTED_SCHEMES.has(scheme) && p === `${scheme}:`
}

const httpsUrl = (u: unknown): boolean => {
  try {
    const url = new URL(String(u))
    return url.protocol === 'https:' && HOST.test(url.hostname) && !url.username && !url.password
  } catch {
    return false
  }
}

export function hostAllowed(patterns: string[], host: string): boolean {
  const h = host.toLowerCase()
  return patterns.some((p) =>
    p === '*' ? true : p.startsWith('*.') ? h.endsWith(p.slice(1)) : p === h
  )
}

function checkConfig(config: unknown, errors: string[]): Record<string, ConfigField> {
  if (config === undefined) return {}
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    errors.push('config must be an object of fields')
    return {}
  }
  const out: Record<string, ConfigField> = {}
  for (const [key, raw] of Object.entries(config as Record<string, unknown>)) {
    const at = `config.${key}`
    if (!CONFIG_KEY.test(key)) errors.push(`${at}: invalid key`)
    const f = raw as Partial<ConfigField> & Record<string, unknown>
    if (!f || typeof f !== 'object') {
      errors.push(`${at}: must be an object`)
      continue
    }
    const allowed = new Set([
      'type',
      'title',
      'description',
      'enum',
      'pattern',
      'minimum',
      'maximum',
      'default',
      'required',
      'secret'
    ])
    for (const k of Object.keys(f))
      if (!allowed.has(k)) errors.push(`${at}: "${k}" is not supported`)
    if (!['string', 'number', 'boolean'].includes(f.type as string))
      errors.push(`${at}: type must be string, number or boolean`)
    if (typeof f.title !== 'string' || !f.title) errors.push(`${at}: title is required`)
    if (f.secret && f.type !== 'string') errors.push(`${at}: only string fields can be secret`)
    if (f.secret && f.default !== undefined)
      errors.push(`${at}: secret fields can't have a default`)
    if (f.default !== undefined && typeof f.default !== f.type)
      errors.push(`${at}: default must be a ${f.type}`)
    if (f.enum !== undefined && (!Array.isArray(f.enum) || f.type !== 'string'))
      errors.push(`${at}: enum must be a list of strings on a string field`)
    if (f.pattern !== undefined)
      try {
        new RegExp(String(f.pattern), 'u')
      } catch {
        errors.push(`${at}: invalid pattern`)
      }
    out[key] = f as ConfigField
  }
  return out
}

function checkTools(id: string, tools: unknown, errors: string[]): ToolSpec[] {
  if (!Array.isArray(tools) || tools.length === 0 || tools.length > 32) {
    errors.push('tools must list 1 to 32 tools')
    return []
  }
  const names = new Set<string>()
  for (const [i, t] of (tools as Partial<ToolSpec>[]).entries()) {
    const at = `tools[${i}]${t?.name ? ` (${t.name})` : ''}`
    if (!t || typeof t !== 'object') {
      errors.push(`${at}: must be an object`)
      continue
    }
    const allowed = new Set(['name', 'description', 'inputSchema', 'effect', 'label', 'timeoutMs'])
    for (const k of Object.keys(t))
      if (!allowed.has(k)) errors.push(`${at}: "${k}" is not supported`)
    if (typeof t.name !== 'string' || !TOOL_NAME.test(t.name))
      errors.push(`${at}: name must be lowercase letters, digits and _ (start with a letter)`)
    else if (names.has(t.name)) errors.push(`${at}: duplicate tool name`)
    else if (fullToolName(id, t.name).length > 64)
      errors.push(`${at}: "${fullToolName(id, t.name)}" is longer than 64 characters`)
    if (typeof t.name === 'string') names.add(t.name)
    if (typeof t.description !== 'string' || !t.description || t.description.length > 1024)
      errors.push(`${at}: description must be 1 to 1024 characters`)
    if (t.effect !== 'read' && t.effect !== 'write')
      errors.push(`${at}: effect must be "read" or "write"`)
    const schemaErrors = checkSchema(t.inputSchema, `${at}.inputSchema`)
    errors.push(...schemaErrors)
    if (!schemaErrors.length && t.inputSchema?.type !== 'object')
      errors.push(`${at}.inputSchema: type must be "object"`)
    if (t.label !== undefined && (typeof t.label !== 'string' || t.label.length > 120))
      errors.push(`${at}: label must be a short string`)
    if (
      t.timeoutMs !== undefined &&
      (typeof t.timeoutMs !== 'number' || t.timeoutMs < 1000 || t.timeoutMs > 60_000)
    )
      errors.push(`${at}: timeoutMs must be between 1000 and 60000`)
  }
  return tools as ToolSpec[]
}

function checkAuth(
  auth: unknown,
  network: string[],
  config: Record<string, ConfigField>,
  errors: string[]
): OAuthSpec | undefined {
  if (auth === undefined) return undefined
  const a = auth as Partial<OAuthSpec>
  if (!a || a.type !== 'oauth-pkce') {
    errors.push('auth.type must be "oauth-pkce" (the only supported kind)')
    return undefined
  }
  if (!httpsUrl(a.authorizeUrl)) errors.push('auth.authorizeUrl must be an https URL')
  if (!httpsUrl(a.tokenUrl)) errors.push('auth.tokenUrl must be an https URL')
  else if (
    !hostAllowed(
      network.filter((n) => n !== '*'),
      new URL(a.tokenUrl!).hostname
    )
  )
    errors.push('auth.tokenUrl host must be listed in permissions.network')
  if (!Number.isInteger(a.redirectPort) || a.redirectPort! < 1024 || a.redirectPort! > 65535)
    errors.push('auth.redirectPort must be a port from 1024 to 65535')
  if (typeof a.redirectPath !== 'string' || !/^\/[\w/-]*$/.test(a.redirectPath))
    errors.push('auth.redirectPath must start with /')
  if (
    !Array.isArray(a.scopes) ||
    a.scopes.some((s) => typeof s !== 'string' || !/^[\w:.-]+$/.test(s))
  )
    errors.push('auth.scopes must be a list of scope names')
  const key = a.clientIdConfigKey
  if (
    typeof key !== 'string' ||
    !config[key] ||
    config[key].secret ||
    config[key].type !== 'string'
  )
    errors.push('auth.clientIdConfigKey must name a non-secret string config field')
  if (!Array.isArray(a.apiHosts) || a.apiHosts.length === 0)
    errors.push('auth.apiHosts must list the hosts that receive the access token')
  else
    for (const h of a.apiHosts)
      if (typeof h !== 'string' || !HOST.test(h) || h.startsWith('*') || !network.includes(h))
        errors.push(`auth.apiHosts: ${h} must be an exact host also listed in permissions.network`)
  return a as OAuthSpec
}

export const WIDGET_ID = /^[a-z][a-z0-9-]{0,30}$/

function checkWidgets(widgets: unknown, tools: ToolSpec[], errors: string[]): WidgetSpec[] {
  if (widgets === undefined) return []
  if (!Array.isArray(widgets) || widgets.length > 8) {
    errors.push('widgets must be a list of at most 8 widgets')
    return []
  }
  const ids = new Set<string>()
  const toolNames = new Set(tools.map((t) => t?.name))
  const allowed = new Set([
    'id',
    'title',
    'description',
    'widgetApi',
    'entry',
    'inputSchema',
    'tools',
    'height',
    'presentations',
    'refreshSeconds'
  ])
  const int = (v: unknown, lo: number, hi: number): boolean =>
    Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi
  for (const [i, raw] of (widgets as Partial<WidgetSpec>[]).entries()) {
    const at = `widgets[${i}]${raw?.id ? ` (${raw.id})` : ''}`
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push(`${at}: must be an object`)
      continue
    }
    const w = raw as WidgetSpec & Record<string, unknown>
    for (const k of Object.keys(w))
      if (!allowed.has(k)) errors.push(`${at}: "${k}" is not supported`)
    if (typeof w.id !== 'string' || !WIDGET_ID.test(w.id))
      errors.push(`${at}: id must be lowercase letters, digits or hyphens, starting with a letter`)
    else if (ids.has(w.id)) errors.push(`${at}: duplicate widget id`)
    else ids.add(w.id)
    if (typeof w.title !== 'string' || !w.title.trim() || w.title.length > 60)
      errors.push(`${at}: title must be 1 to 60 characters`)
    if (typeof w.description !== 'string' || !w.description.trim() || w.description.length > 500)
      errors.push(`${at}: description must be 1 to 500 characters`)
    if (!Number.isInteger(w.widgetApi)) errors.push(`${at}: widgetApi must be an integer`)
    else if (!SUPPORTED_WIDGET_API_VERSIONS.includes(w.widgetApi))
      errors.push(
        `${at}: widgetApi ${w.widgetApi} is not supported by this Custard (supports ${SUPPORTED_WIDGET_API_VERSIONS.join(', ')})`
      )
    if (!isRelativePath(w.entry) || !/\.(ts|js)$/.test(w.entry))
      errors.push(`${at}: entry must be a relative .ts or .js path inside the plugin folder`)
    if (w.inputSchema !== undefined) {
      const schemaErrors = checkSchema(w.inputSchema, `${at}.inputSchema`)
      errors.push(...schemaErrors)
      if (!schemaErrors.length && w.inputSchema.type !== 'object')
        errors.push(`${at}.inputSchema: type must be "object"`)
    }
    if (!Array.isArray(w.tools) || w.tools.length > 32)
      errors.push(`${at}: tools must be a list of this plugin's tool names (it may be empty)`)
    else
      for (const t of w.tools)
        if (typeof t !== 'string' || !toolNames.has(t))
          errors.push(`${at}: tools: "${String(t)}" is not one of this plugin's tools`)
    if (w.height !== undefined) {
      const h = w.height as Record<string, unknown>
      const { minHeight: lo, maxHeight: hi } = WIDGET_LIMITS
      if (!h || typeof h !== 'object' || Array.isArray(h))
        errors.push(`${at}: height must be an object`)
      else {
        for (const k of Object.keys(h))
          if (!['initial', 'min', 'max'].includes(k))
            errors.push(`${at}: height.${k} is not supported`)
        for (const k of ['initial', 'min', 'max'])
          if (h[k] !== undefined && !int(h[k], lo, hi))
            errors.push(`${at}: height.${k} must be a whole number from ${lo} to ${hi}`)
        const min = (h.min as number) ?? lo
        const max = (h.max as number) ?? hi
        if (min > max) errors.push(`${at}: height.min must not be more than height.max`)
        if (h.initial !== undefined && ((h.initial as number) < min || (h.initial as number) > max))
          errors.push(`${at}: height.initial must be between height.min and height.max`)
      }
    }
    if (w.presentations !== undefined) {
      const p = w.presentations as unknown[]
      if (
        !Array.isArray(p) ||
        !p.length ||
        p.some((x) => x !== 'compact' && x !== 'expanded') ||
        new Set(p).size !== p.length
      )
        errors.push(`${at}: presentations must list "compact" and/or "expanded" once each`)
    }
    if (
      w.refreshSeconds !== undefined &&
      !int(w.refreshSeconds, WIDGET_LIMITS.minRefreshSeconds, WIDGET_LIMITS.maxRefreshSeconds)
    )
      errors.push(
        `${at}: refreshSeconds must be a whole number from ${WIDGET_LIMITS.minRefreshSeconds} to ${WIDGET_LIMITS.maxRefreshSeconds}`
      )
  }
  return (widgets as WidgetSpec[]).map((w) => ({
    ...w,
    ...(w.presentations ? { presentations: w.presentations as WidgetPresentation[] } : {})
  }))
}

export const MEDIA_ID = /^[a-z][a-z0-9-]{0,30}$/
export const MEDIA_MAX_PROVIDERS = 4

// The fields Custard puts in each media tool's input, so a plugin's own
// schema can't make a valid request fail at the moment it's sent. Optional
// fields are sent only when the request has them.
const SUBMIT_FIELDS = ['operation', 'prompt', 'idempotencyKey'] as const

// `media`: image or video generation offered to Design. Each capability names
// the plugin's own tools; they still run through the normal host checks and
// approvals. Status, result and cancel tools take { remoteId }. See
// docs/design/MEDIA-PLUGINS.md.
function checkMedia(
  media: unknown,
  tools: ToolSpec[],
  widgets: WidgetSpec[],
  errors: string[]
): PluginMediaSpec[] {
  if (media === undefined) return []
  if (!Array.isArray(media) || !media.length || media.length > MEDIA_MAX_PROVIDERS) {
    errors.push(`media must be a list of 1 to ${MEDIA_MAX_PROVIDERS} providers`)
    return []
  }
  const byName = new Map(tools.filter((t) => t && typeof t === 'object').map((t) => [t.name, t]))
  // A widget calling these would be a second way to start paid work.
  const widgetTools = new Set(widgets.flatMap((w) => (Array.isArray(w.tools) ? w.tools : [])))
  const ids = new Set<string>()
  const out: PluginMediaSpec[] = []
  for (const [i, raw] of (media as unknown[]).entries()) {
    const p = (raw ?? {}) as Record<string, unknown>
    const at = `media[${i}]${typeof p.id === 'string' ? ` (${p.id})` : ''}`
    const before = errors.length
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push(`${at}: must be an object`)
      continue
    }
    for (const k of Object.keys(p))
      if (!['id', 'name', 'capabilities'].includes(k)) errors.push(`${at}: "${k}" is not supported`)
    if (typeof p.id !== 'string' || !MEDIA_ID.test(p.id))
      errors.push(`${at}: id must be lowercase letters, digits or hyphens, starting with a letter`)
    else if (ids.has(p.id)) errors.push(`${at}: duplicate media id`)
    else ids.add(p.id)
    if (typeof p.name !== 'string' || !p.name.trim() || p.name.length > 60)
      errors.push(`${at}: name must be 1 to 60 characters`)
    const caps = Array.isArray(p.capabilities) ? (p.capabilities as unknown[]) : null
    if (!caps || !caps.length) {
      errors.push(`${at}: capabilities must list at least one operation`)
      continue
    }
    // The capability itself (operation, formats, limits...) is checked by
    // Design's own rules; `tools` is checked here against this manifest.
    const stripped = caps.map((c) => {
      if (!c || typeof c !== 'object' || Array.isArray(c)) return c
      const rest = { ...(c as Record<string, unknown>) }
      delete rest.tools
      return rest
    })
    const v = validateCapabilities(stripped)
    errors.push(...v.errors.map((e) => `${at}: ${e}`))
    const capabilities: PluginMediaSpec['capabilities'] = []
    for (const [j, c] of caps.entries()) {
      const cat = `${at}: capabilities[${j}]`
      const t = (c as Record<string, unknown> | null)?.tools as Record<string, unknown> | undefined
      if (!t || typeof t !== 'object' || Array.isArray(t)) {
        errors.push(`${cat}: tools must name submit, status and result tools`)
        continue
      }
      for (const k of Object.keys(t))
        if (!['submit', 'status', 'result', 'cancel'].includes(k))
          errors.push(`${cat}: tools.${k} is not supported`)
      const declared = v.capabilities.find(
        (x) => x.operation === (c as Record<string, unknown>).operation
      )
      const tool = (role: string, effects: ToolSpec['effect'][]): ToolSpec | null => {
        const name = t[role]
        const spec = typeof name === 'string' ? byName.get(name) : undefined
        if (!spec) {
          errors.push(`${cat}: tools.${role}: "${String(name)}" is not one of this plugin's tools`)
          return null
        }
        const why: Record<string, string> = {
          submit: 'it starts work that may be charged',
          cancel: 'it changes the job at the provider',
          status: 'it must never start new work',
          result: 'it must never start new work'
        }
        if (!effects.includes(spec.effect))
          errors.push(
            `${cat}: tools.${role}: ${spec.name} must be a ${effects.join(' or ')} tool (${why[role]})`
          )
        if (widgetTools.has(spec.name))
          errors.push(`${cat}: tools.${role}: ${spec.name} can't also be a widget's tool`)
        return spec
      }
      const props = (s: ToolSpec): Record<string, unknown> =>
        (s.inputSchema?.properties as Record<string, unknown> | undefined) ?? {}
      const submit = tool('submit', ['write'])
      const status = tool('status', ['read'])
      const result = tool('result', ['read'])
      const cancel = t.cancel === undefined ? null : tool('cancel', ['write'])
      if (submit) {
        const has = props(submit)
        const needed = [
          ...SUBMIT_FIELDS,
          ...(declared?.references ? ['references'] : []),
          ...(declared?.sizes ? ['size'] : []),
          ...(declared?.durations ? ['durationSeconds'] : []),
          ...((declared?.formats.length ?? 0) > 1 ? ['format'] : [])
        ]
        const missing = needed.filter((f) => !(f in has))
        if (missing.length)
          errors.push(`${cat}: ${submit.name}'s inputSchema must declare ${missing.join(', ')}`)
      }
      for (const s of [status, result, cancel])
        if (s && (!('remoteId' in props(s)) || !s.inputSchema.required?.includes('remoteId')))
          errors.push(`${cat}: ${s.name}'s inputSchema must require remoteId`)
      for (const [role, s] of [
        ['status', status],
        ['result', result],
        ['cancel', cancel]
      ] as const)
        if (s && submit && s.name === submit.name)
          errors.push(`${cat}: tools.${role} can't be the submit tool`)
      if (declared?.cancel && t.cancel === undefined)
        errors.push(`${cat}: cancel is true, so tools.cancel must name a tool`)
      if (declared && !declared.cancel && t.cancel !== undefined)
        errors.push(`${cat}: tools.cancel is named but cancel is false`)
      if (declared && submit && status && result)
        capabilities.push({
          ...declared,
          tools: {
            submit: submit.name,
            status: status.name,
            result: result.name,
            ...(cancel ? { cancel: cancel.name } : {})
          }
        })
    }
    if (errors.length === before)
      out.push({ id: p.id as string, name: (p.name as string).trim(), capabilities })
  }
  return out
}

export type ManifestResult =
  | { ok: true; manifest: PluginManifest; errors: [] }
  | { ok: false; manifest: null; errors: string[] }

export function parseManifest(raw: unknown, folderName?: string): ManifestResult {
  const errors: string[] = []
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return { ok: false, manifest: null, errors: ['plugin.json must be a JSON object'] }
  const m = raw as Record<string, unknown>
  const allowed = new Set([
    '$schema',
    'manifestVersion',
    'id',
    'name',
    'description',
    'version',
    'apiVersion',
    'entry',
    'permissions',
    'tools',
    'config',
    'auth',
    'instructions',
    'widgets',
    'media'
  ])
  for (const k of Object.keys(m)) if (!allowed.has(k)) errors.push(`"${k}" is not a manifest field`)
  if (m.manifestVersion !== 1) errors.push('manifestVersion must be 1')
  const id = m.id
  if (typeof id !== 'string' || !PLUGIN_ID.test(id))
    errors.push('id must be 2 to 31 lowercase letters, digits or hyphens, starting with a letter')
  else if (folderName !== undefined && id !== folderName)
    errors.push(`id "${id}" must match its folder name "${folderName}"`)
  if (typeof m.name !== 'string' || !m.name || m.name.length > 60)
    errors.push('name must be 1 to 60 characters')
  if (typeof m.description !== 'string' || !m.description || m.description.length > 300)
    errors.push('description must be 1 to 300 characters')
  if (typeof m.version !== 'string' || !SEMVER.test(m.version))
    errors.push('version must be semver, like 1.0.0')
  if (!Number.isInteger(m.apiVersion)) errors.push('apiVersion must be an integer')
  else if (!SUPPORTED_API_VERSIONS.includes(m.apiVersion as number))
    errors.push(
      `apiVersion ${m.apiVersion} is not supported by this Custard (supports ${SUPPORTED_API_VERSIONS.join(', ')})`
    )
  if (!isRelativePath(m.entry) || !/\.(ts|js)$/.test(m.entry as string))
    errors.push('entry must be a relative .ts or .js path inside the plugin folder')
  if (
    m.instructions !== undefined &&
    (!isRelativePath(m.instructions) || !/\.md$/.test(m.instructions))
  )
    errors.push('instructions must be a relative .md path inside the plugin folder')

  const p = (m.permissions ?? {}) as Record<string, unknown>
  if (typeof p !== 'object') errors.push('permissions must be an object')
  for (const k of Object.keys(p))
    if (!['network', 'openExternal', 'storage'].includes(k))
      errors.push(`permissions.${k} is not a known permission`)
  const network = Array.isArray(p.network) ? (p.network as unknown[]) : []
  if (p.network !== undefined && !Array.isArray(p.network))
    errors.push('permissions.network must be a list of hosts')
  for (const h of network)
    if (h !== '*' && (typeof h !== 'string' || !HOST.test(h)))
      errors.push(
        `permissions.network: "${h}" must be a host name like api.example.com, *.example.com or "*"`
      )
  const open = Array.isArray(p.openExternal) ? (p.openExternal as unknown[]) : []
  if (p.openExternal !== undefined && !Array.isArray(p.openExternal))
    errors.push('permissions.openExternal must be a list of URL prefixes')
  for (const o of open)
    if (!validOpenPrefix(o))
      errors.push(
        `permissions.openExternal: "${o}" must be a custom scheme like "spotify:" or an https prefix like "https://example.com/"`
      )
  if (p.storage !== undefined && typeof p.storage !== 'boolean')
    errors.push('permissions.storage must be true or false')

  const config = checkConfig(m.config, errors)
  const tools = checkTools(typeof id === 'string' ? id : 'x', m.tools, errors)
  const auth = checkAuth(m.auth, network as string[], config, errors)
  const widgets = checkWidgets(m.widgets, tools, errors)
  const media = checkMedia(m.media, tools, widgets, errors)

  if (errors.length) return { ok: false, manifest: null, errors }
  return {
    ok: true,
    errors: [],
    manifest: {
      manifestVersion: 1,
      id: id as string,
      name: m.name as string,
      description: m.description as string,
      version: m.version as string,
      apiVersion: m.apiVersion as number,
      entry: m.entry as string,
      permissions: {
        network: network as string[],
        openExternal: open as string[],
        storage: p.storage === true
      },
      tools,
      config,
      ...(auth ? { auth } : {}),
      ...(m.instructions ? { instructions: m.instructions as string } : {}),
      ...(widgets.length ? { widgets } : {}),
      ...(media.length ? { media } : {})
    }
  }
}

// Everything that decides where an account's credentials go and what they
// allow. Saved tokens are kept across an update only if this is unchanged.
export function credentialScope(m: PluginManifest): string {
  if (!m.auth) return ''
  const a = m.auth
  return JSON.stringify({
    authorize: a.authorizeUrl,
    token: a.tokenUrl,
    api: [...a.apiHosts].sort(),
    scopes: [...a.scopes].sort(),
    clientIdKey: a.clientIdConfigKey,
    redirect: [a.redirectPort, a.redirectPath]
  })
}

// Everything a manifest asks for, as stable strings. A string missing from
// the user's grants means the user has to approve it before activation.
export function permissionsOf(m: PluginManifest): string[] {
  return [
    ...m.permissions.network.map((h) => `network:${h}`),
    ...m.permissions.openExternal.map((o) => `open:${o}`),
    ...(m.permissions.storage ? ['storage'] : []),
    ...(m.auth
      ? [
          `account:${new URL(m.auth.authorizeUrl).hostname}`,
          // Where the account's credentials go: the token endpoint (codes
          // and refresh tokens) and each host that gets the access token.
          // A change to either needs approval again.
          `account-token:${new URL(m.auth.tokenUrl).hostname}`,
          ...m.auth.apiHosts.map((h) => `account-api:${h}`),
          ...m.auth.scopes.map((s) => `account-scope:${s}`)
        ]
      : []),
    ...m.tools.filter((t) => t.effect === 'write').map((t) => `action:${t.name}`),
    // Each widget is approved on its own; a new or renamed one asks again.
    ...(m.widgets ?? []).map((w) => `widget:${w.id}`),
    // Offering media to Design is approved per provider, like widgets. Each
    // submission still asks (see docs/design/MEDIA-PLUGINS.md).
    ...(m.media ?? []).map((p) => `media:${p.id}`)
  ]
}
