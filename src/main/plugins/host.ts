import type { BetaTool } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { randomUUID } from 'crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import {
  SUPPORTED_API_VERSIONS,
  type PluginManifest,
  type PluginReview,
  type PluginStatus,
  type TestReport
} from '../../shared/plugins'
import { formatLabel } from '../../shared/vault'
import { WIDGET_LIMITS, type WidgetSpec } from '../../shared/widgets'
import { resolveInside } from '../workspace/paths'
import { bundle, hashSources, readSources, type SourceFile } from './build'
import { diffSources } from './diff'
import {
  credentialScope,
  fullToolName,
  parseManifest,
  permissionsOf,
  PLAIN_URL,
  PLUGIN_ID,
  splitToolName
} from './manifest'
import { safeFetch, type NetResponse, type Transport } from './net'
import { AuthError, refreshTokens, signIn, type Tokens } from './oauth'
import { redact } from './redact'
import { validate } from './schema'
import { SecretsLockedError, type PluginStore } from './store'

// The plugin host: discovers plugins in plugin/, builds and validates them,
// activates reviewed builds, runs them in sandboxes and mediates everything
// they do. Every check that matters happens here, in the main process, at
// the moment of use; manifests and the sandbox runtime only describe intent.

export type ConfigValues = Record<string, string | number | boolean>
// From the runtime: `interrupted` when the call was cut short after it reached
// the plugin (timeout, cancel, crash), `notSent` when it never reached it.
// From invoke: `outcome`, what became of the call (see ActionStatus).
export type ToolOutcome = {
  content: string
  isError: boolean
  interrupted?: boolean
  notSent?: boolean
  outcome?: 'completed' | 'failed' | 'not-run' | 'unknown'
  // Structured data for the plugin's widgets. Never sent to the model.
  data?: unknown
}

export type RuntimeHandle = {
  call(
    callId: string,
    tool: string,
    input: unknown,
    config: ConfigValues,
    timeoutMs: number,
    signal: AbortSignal
  ): Promise<ToolOutcome>
  dispose(reason: string): void
}

export type RuntimeFactory = (o: {
  pluginId: string
  code: string
  onCap: (callId: string, name: string, args: unknown) => Promise<CapResult>
  onExit: (reason: string) => void
}) => Promise<{ handle: RuntimeHandle; tools: string[] }>

export type TestRunner = (
  code: string,
  o?: { signal?: AbortSignal; timeoutMs?: number }
) => Promise<{ name: string; ok: boolean; error?: string }[]>

export type CapResult = { ok: true; value: unknown } | { ok: false; error: string }

export type HostDeps = {
  sourceRoot: () => string
  sdkDir: string
  store: PluginStore
  runtime: RuntimeFactory
  testRunner: TestRunner
  openExternal: (url: string) => Promise<void>
  openBrowser: (url: string) => Promise<void>
  askByDefault: () => boolean
  transport?: () => Transport | undefined
}

// Which build each offered tool came from, captured when a request starts.
export type ToolSnapshot = Map<string, { pluginId: string; buildId: string }>

export type ApprovalRequest = {
  pluginId: string
  pluginName: string
  tool: string
  label: string
  input: unknown
  // What the user reviews instead of the raw input, when the caller has a
  // clearer, complete view of the change (a file diff, a note's content).
  detail?: string
  // Asks every time: "Allow for this chat" isn't offered.
  individual?: boolean
  // The plugin build asking. "Allow for this chat" covers this build only.
  buildId?: string
}

const RESERVED_IDS = new Set(['vault', 'fs', 'reference', 'plugin', 'custard', 'core'])
const DEFAULT_TIMEOUT_MS = 20_000
const MAX_RESULT_CHARS = 50_000
const OAUTH_KEY = '__oauth'

const fail = (content: string): ToolOutcome => ({ content, isError: true })
// Refused before the plugin was called: nothing was done.
const notRun = (content: string): ToolOutcome => ({ content, isError: true, outcome: 'not-run' })
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

// A tool's `data` for widgets: plain JSON, bounded, and dropped if it holds a
// secret value (redaction would garble it, so it isn't attempted).
function widgetData(data: unknown, secrets: string[]): unknown {
  if (data === undefined) return undefined
  let json: string | undefined
  try {
    json = JSON.stringify(data)
  } catch {
    return undefined
  }
  if (json === undefined || json.length > WIDGET_LIMITS.dataBytes) return undefined
  if (redact(json, secrets) !== json) return undefined
  return JSON.parse(json)
}

export class PluginHost {
  private runtimes = new Map<string, { handle: RuntimeHandle; buildId: string }>()
  private starting = new Map<string, Promise<RuntimeHandle>>()
  private calls = new Map<
    string,
    { pluginId: string; buildId: string; controller: AbortController; write: boolean }
  >()
  private logs = new Map<string, string[]>()
  private refreshing = new Map<string, Promise<string>>()
  // Bumped whenever the account's sign-in is ended or invalidated (disconnect,
  // a Client ID change, reset, uninstall, a credential change on update). A
  // sign-in or refresh that started before then doesn't save its tokens.
  private signInGeneration = new Map<string, number>()
  private signedOut(id: string): void {
    this.signInGeneration.set(id, (this.signInGeneration.get(id) ?? 0) + 1)
  }
  private generation(id: string): number {
    return this.signInGeneration.get(id) ?? 0
  }
  private buildCache = new Map<string, ReturnType<PluginStore['build']>>()

  // Told when a plugin is activated, enabled, disabled or removed, so its
  // widgets can be taken down (see main/widgets).
  private changeListeners = new Set<(id: string) => void>()
  onChange(cb: (id: string) => void): () => void {
    this.changeListeners.add(cb)
    return () => this.changeListeners.delete(cb)
  }
  private changed(id: string): void {
    for (const cb of this.changeListeners)
      try {
        cb(id)
      } catch (err) {
        console.error('Plugin change listener:', err)
      }
  }

  constructor(private d: HostDeps) {}

  get store(): PluginStore {
    return this.d.store
  }

  // Discovery and status

  private sourceDir(id: string): string {
    if (!PLUGIN_ID.test(id)) throw new Error('Invalid plugin id')
    return join(this.d.sourceRoot(), id)
  }

  sourceIds(): string[] {
    const root = this.d.sourceRoot()
    if (!existsSync(root)) return []
    return readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(root, e.name, 'plugin.json')))
      .map((e) => e.name)
  }

  private build(id: string, buildId: string): ReturnType<PluginStore['build']> {
    const key = `${id}/${buildId}`
    let b = this.buildCache.get(key)
    if (!b) {
      b = this.d.store.build(id, buildId)
      this.buildCache.set(key, b)
    }
    return b
  }

  readSource(id: string): {
    manifest: PluginManifest | null
    errors: string[]
    instructions: string
  } {
    const dir = this.sourceDir(id)
    const file = join(dir, 'plugin.json')
    if (!existsSync(file))
      return { manifest: null, errors: ['plugin.json is missing'], instructions: '' }
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'))
    } catch (err) {
      return {
        manifest: null,
        errors: [`plugin.json is not valid JSON: ${message(err)}`],
        instructions: ''
      }
    }
    const r = parseManifest(raw, id)
    const errors = [...r.errors]
    if (RESERVED_IDS.has(id)) errors.push(`"${id}" is reserved for Custard's own tools`)
    let instructions = ''
    if (r.manifest) {
      const b = { root: dir }
      try {
        const entry = resolveInside(b, r.manifest.entry, { mustExist: true })
        if (!statSync(entry).isFile()) errors.push('entry is not a file')
      } catch (err) {
        errors.push(`entry ${r.manifest.entry}: ${message(err)}`)
      }
      for (const w of r.manifest.widgets ?? [])
        try {
          const entry = resolveInside(b, w.entry, { mustExist: true })
          if (!statSync(entry).isFile()) errors.push(`widget ${w.id}: entry is not a file`)
        } catch (err) {
          errors.push(`widget ${w.id}: entry ${w.entry}: ${message(err)}`)
        }
      if (r.manifest.instructions)
        try {
          instructions = readFileSync(
            resolveInside(b, r.manifest.instructions, { mustExist: true }),
            'utf8'
          )
          if (instructions.length > 8000) errors.push('instructions must be under 8000 characters')
        } catch (err) {
          errors.push(`instructions ${r.manifest.instructions}: ${message(err)}`)
        }
    }
    return errors.length
      ? { manifest: null, errors, instructions: '' }
      : { manifest: r.manifest, errors, instructions }
  }

  // Source plus the SDK it builds against, so an SDK change makes a new build.
  // The widget SDK counts only for plugins with widgets, so adding it didn't
  // change every existing plugin's build.
  private sourceHash(files: SourceFile[]): string {
    let widgets = false
    try {
      const m = JSON.parse(files.find((f) => f.path === 'plugin.json')?.content ?? '{}')
      widgets = Array.isArray(m?.widgets) && m.widgets.length > 0
    } catch {
      // An invalid manifest fails validation anyway.
    }
    const sdkFiles = [
      'index.ts',
      'runtime.ts',
      ...(widgets ? ['widget.ts', 'widget-runtime.ts'] : [])
    ]
    const sdk = sdkFiles.map((f) => ({
      path: `sdk:${f}`,
      content: readFileSync(join(this.d.sdkDir, f), 'utf8')
    }))
    return hashSources([...files, ...sdk])
  }

  list(): PluginStatus[] {
    const ids = new Set([...this.sourceIds(), ...this.d.store.ids()])
    return [...ids].sort().map((id) => this.status(id))
  }

  status(id: string): PluginStatus {
    const src = existsSync(this.sourceDir(id))
      ? this.readSource(id)
      : { manifest: null, errors: ['The source folder is gone'], instructions: '' }
    const st = this.d.store.state(id)
    const active = st.active ? this.build(id, st.active.buildId).manifest : null
    const m = active ?? src.manifest
    let sourceChanged = false
    if (src.manifest)
      try {
        sourceChanged =
          !st.active || this.sourceHash(readSources(this.sourceDir(id))) !== st.active.buildId
      } catch {
        sourceChanged = true
      }
    const secretsLocked = this.d.store.secretsLocked(id)
    const secrets = secretsLocked ? {} : this.d.store.secrets(id)
    const fields = m?.config ?? {}
    const values: ConfigValues = {}
    for (const [k, f] of Object.entries(fields))
      if (!f.secret && f.default !== undefined) values[k] = f.default
    Object.assign(values, this.d.store.config(id))
    return {
      id,
      dir: this.sourceDir(id),
      name: m?.name ?? id,
      description: m?.description ?? '',
      version: m?.version ?? '',
      sourceErrors: src.errors,
      state: !st.active ? 'not-activated' : st.enabled ? 'enabled' : 'disabled',
      running: this.runtimes.has(id),
      active: st.active,
      previous: st.previous,
      sourceChanged,
      requested: src.manifest ? permissionsOf(src.manifest) : [],
      granted: st.granted,
      config: { fields, values, secretsSet: Object.keys(secrets).filter((k) => k !== OAUTH_KEY) },
      auth: m?.auth ? { connected: !!secrets[OAUTH_KEY] } : null,
      ...(secretsLocked ? { secretsLocked: true } : {}),
      tools: (m?.tools ?? []).map((t) => ({
        name: t.name,
        fullName: fullToolName(id, t.name),
        effect: t.effect,
        askEveryTime: t.effect === 'write' && (st.askEveryTime[t.name] ?? this.d.askByDefault())
      })),
      ...(m?.widgets?.length
        ? { widgets: m.widgets.map((w) => ({ id: w.id, title: w.title })) }
        : {}),
      errors: st.errors,
      log: this.logs.get(id) ?? []
    }
  }

  // Validate, review, test

  async validate(id: string): Promise<{
    ok: boolean
    errors: string[]
    warnings: string[]
    manifest: PluginManifest | null
    buildId: string | null
  }> {
    // Files first: a manifest changed after this read changes the hash
    // checked below.
    const files = readSources(this.sourceDir(id))
    const src = this.readSource(id)
    if (!src.manifest)
      return { ok: false, errors: src.errors, warnings: [], manifest: null, buildId: null }
    const m = src.manifest
    const buildId = this.sourceHash(files)
    if (!this.d.store.hasBuild(id, buildId)) {
      const r = await bundle(this.sourceDir(id), this.d.sdkDir, { kind: 'plugin', entry: m.entry })
      if (!r.ok) return { ok: false, errors: r.errors, warnings: [], manifest: m, buildId: null }
      const widgets: Record<string, string> = {}
      for (const w of m.widgets ?? []) {
        const wb = await bundle(this.sourceDir(id), this.d.sdkDir, {
          kind: 'widget',
          entry: w.entry
        })
        if (!wb.ok)
          return {
            ok: false,
            errors: wb.errors.map((e) => `widget ${w.id}: ${e}`),
            warnings: [],
            manifest: m,
            buildId: null
          }
        widgets[w.id] = wb.code
      }
      // The bundler reads the files again, so the code is what was hashed
      // (and is reviewed) only if nothing changed in between (L19).
      let after: string | null = null
      try {
        after = this.sourceHash(readSources(this.sourceDir(id)))
      } catch {
        // Treated as changed.
      }
      if (after !== buildId)
        return {
          ok: false,
          errors: ["The plugin's files changed while it was being built. Check it again."],
          warnings: [],
          manifest: m,
          buildId: null
        }
      this.d.store.saveBuild(id, buildId, {
        manifest: m,
        code: r.code,
        sources: files,
        instructions: src.instructions,
        widgets
      })
    }
    const warnings: string[] = []
    if (m.permissions.network.includes('*'))
      warnings.push(
        'This plugin may connect to any public website (private and local addresses stay blocked).'
      )
    if (!files.some((f) => /^tests\/.+\.test\.(ts|js)$/.test(f.path)))
      warnings.push('There are no tests in tests/*.test.ts.')
    // Tool names can't collide: ids are unique folder names and "__" only
    // appears between the id and the tool. Checked anyway, mechanically.
    const names = new Set<string>()
    for (const other of this.d.store.ids())
      if (other !== id) {
        const st = this.d.store.state(other)
        if (st.active)
          for (const t of this.build(other, st.active.buildId).manifest.tools)
            names.add(fullToolName(other, t.name))
      }
    const errors = m.tools
      .map((t) => fullToolName(id, t.name))
      .filter((n) => names.has(n))
      .map((n) => `Tool name ${n} is already used`)
    return { ok: errors.length === 0, errors, warnings, manifest: m, buildId }
  }

  async review(id: string): Promise<PluginReview> {
    const v = await this.validate(id)
    const st = this.d.store.state(id)
    const requested = v.manifest ? permissionsOf(v.manifest) : []
    let files: PluginReview['files'] = []
    try {
      files = diffSources(
        st.active ? this.d.store.buildSources(id, st.active.buildId) : [],
        readSources(this.sourceDir(id))
      )
    } catch {
      // Reported through validation errors.
    }
    return {
      id,
      ok: v.ok,
      errors: v.errors,
      warnings: v.warnings,
      manifest: v.manifest,
      version: { from: st.active?.version ?? null, to: v.manifest?.version ?? null },
      newPermissions: requested.filter((p) => !st.granted.includes(p)),
      removedPermissions: st.granted.filter((p) => !requested.includes(p)),
      files,
      buildId: v.buildId
    }
  }

  // Runs the plugin's tests, and a load check of the plugin itself, in fresh
  // sandboxes with no capabilities.
  async test(id: string, signal?: AbortSignal): Promise<TestReport> {
    const v = await this.validate(id)
    if (!v.ok || !v.buildId) return { ok: false, results: [], error: v.errors.join('\n') }
    const results: TestReport['results'] = []
    try {
      const { handle, tools } = await this.d.runtime({
        pluginId: id,
        code: this.build(id, v.buildId).code,
        onCap: async () => ({ ok: false, error: 'No capabilities during the load check.' }),
        onExit: () => {}
      })
      handle.dispose('load check done')
      const missing = v.manifest!.tools.filter((t) => !tools.includes(t.name)).map((t) => t.name)
      results.push({
        name: 'Plugin loads and handles every tool in plugin.json',
        ok: !missing.length,
        error: missing.length ? `No handler for ${missing.join(', ')}` : undefined
      })
    } catch (err) {
      results.push({
        name: 'Plugin loads and handles every tool in plugin.json',
        ok: false,
        error: message(err)
      })
    }
    const testFiles = readSources(this.sourceDir(id))
      .map((f) => f.path)
      .filter((p) => /^tests\/.+\.test\.(ts|js)$/.test(p))
    if (testFiles.length) {
      const b = await bundle(this.sourceDir(id), this.d.sdkDir, { kind: 'tests', files: testFiles })
      if (!b.ok) return { ok: false, results, error: b.errors.join('\n') }
      // Results count for the checked build only if the tests ran its code.
      if (this.sourceHash(readSources(this.sourceDir(id))) !== v.buildId)
        return {
          ok: false,
          results,
          error: "The plugin's files changed while the tests were being built. Run them again."
        }
      try {
        results.push(...(await this.d.testRunner(b.code, { signal })))
      } catch (err) {
        return { ok: false, results, error: message(err) }
      }
    }
    return { ok: results.every((r) => r.ok), results }
  }

  // Lifecycle

  private async start(id: string, buildId: string): Promise<RuntimeHandle> {
    const { manifest, code } = this.build(id, buildId)
    // Filled in once started; the exit handler only acts on this instance.
    const ref: { handle?: RuntimeHandle } = {}
    const r = await this.d.runtime({
      pluginId: id,
      code,
      onCap: (callId, name, args) => this.capability(id, callId, name, args),
      onExit: (reason) => {
        if (ref.handle && this.runtimes.get(id)?.handle === ref.handle) {
          this.runtimes.delete(id)
          this.d.store.addError(id, `The plugin stopped: ${reason}`)
        }
      }
    })
    const handle = (ref.handle = r.handle)
    const missing = manifest.tools.filter((t) => !r.tools.includes(t.name)).map((t) => t.name)
    if (missing.length) {
      handle.dispose('missing handlers')
      throw new Error(`The plugin has no handler for ${missing.join(', ')}.`)
    }
    this.runtimes.set(id, { handle, buildId })
    return handle
  }

  private stop(id: string, reason: string): void {
    for (const [callId, c] of this.calls)
      if (c.pluginId === id) {
        c.controller.abort()
        this.calls.delete(callId)
      }
    this.runtimes.get(id)?.handle.dispose(reason)
    this.runtimes.delete(id)
  }

  // Starts every enabled plugin; failures are recorded and shown in Settings.
  async startAll(): Promise<void> {
    for (const id of this.d.store.ids()) {
      const st = this.d.store.state(id)
      if (st.enabled && st.active)
        await this.start(id, st.active.buildId).catch((err) =>
          this.d.store.addError(id, `Failed to start: ${message(err)}`)
        )
    }
  }

  async activate(id: string, buildId: string, approved: string[]): Promise<PluginStatus> {
    if (!/^[0-9a-f]{16}$/.test(buildId) || !this.d.store.hasBuild(id, buildId))
      throw new Error('Validate the plugin first.')
    const { manifest } = this.build(id, buildId)
    if (!SUPPORTED_API_VERSIONS.includes(manifest.apiVersion))
      throw new Error(
        `This plugin needs API version ${manifest.apiVersion}, which this Custard doesn't support.`
      )
    const st = this.d.store.state(id)
    const perms = permissionsOf(manifest)
    const granted = new Set([...st.granted, ...approved])
    const missing = perms.filter((p) => !granted.has(p))
    if (missing.length) throw new Error(`Approve these permissions first: ${missing.join(', ')}`)
    // Saved tokens are only reused when the credentials would go to the same
    // places with the same scopes. Otherwise the account must be connected
    // again. Checked before anything changes, so locked secrets stop it.
    const changedBuild = !st.active || st.active.buildId !== buildId
    const signOut =
      !!st.active &&
      credentialScope(this.build(id, st.active.buildId).manifest) !== credentialScope(manifest)
    if (signOut && this.d.store.secretsLocked(id)) throw new SecretsLockedError()

    this.stop(id, 'a new version is being activated')
    try {
      await this.start(id, buildId)
    } catch (err) {
      this.d.store.addError(id, `Activating ${manifest.version} failed: ${message(err)}`)
      // Automatic rollback: bring the version that was running back up.
      if (st.enabled && st.active)
        await this.start(id, st.active.buildId).catch((e) =>
          this.d.store.addError(id, `Restarting ${st.active!.version} failed: ${message(e)}`)
        )
      throw new Error(
        `Version ${manifest.version} failed to start, so it was not activated.${st.active ? ` ${st.active.version} is still the active version.` : ''} ${message(err)}`
      )
    }
    const info = { buildId, version: manifest.version, builtAt: Date.now() }
    const previous = st.active && st.active.buildId !== buildId ? st.active : st.previous
    // Grants shrink to what this version asks for, so a later version that
    // asks again needs approval again.
    // A different build may behave differently, so "don't ask" choices for
    // its write tools don't carry over: they ask again until turned off again.
    const askEveryTime = changedBuild
      ? Object.fromEntries(Object.entries(st.askEveryTime).filter(([, ask]) => ask))
      : st.askEveryTime
    this.d.store.setState(id, {
      enabled: true,
      active: info,
      previous,
      granted: perms,
      askEveryTime
    })
    if (signOut) {
      this.signedOut(id)
      this.d.store.setSecret(id, OAUTH_KEY, null)
    }
    this.d.store.pruneBuilds(id, [buildId, ...(previous ? [previous.buildId] : [])])
    this.changed(id)
    return this.status(id)
  }

  async rollback(id: string, approved: string[] = []): Promise<PluginStatus> {
    const st = this.d.store.state(id)
    if (!st.previous) throw new Error('There is no earlier version to roll back to.')
    return this.activate(id, st.previous.buildId, approved)
  }

  disable(id: string): PluginStatus {
    this.d.store.setState(id, { enabled: false })
    this.stop(id, 'disabled')
    this.changed(id)
    return this.status(id)
  }

  async enable(id: string): Promise<PluginStatus> {
    const st = this.d.store.state(id)
    if (!st.active) throw new Error('Review and activate the plugin first.')
    const missing = permissionsOf(this.build(id, st.active.buildId).manifest).filter(
      (p) => !st.granted.includes(p)
    )
    if (missing.length) throw new Error(`Approve these permissions first: ${missing.join(', ')}`)
    this.stop(id, 'restarting')
    await this.start(id, st.active.buildId)
    this.d.store.setState(id, { enabled: true })
    this.changed(id)
    return this.status(id)
  }

  // Deletes builds, settings, data and account tokens. The source stays.
  uninstall(id: string): void {
    this.signedOut(id)
    this.stop(id, 'uninstalled')
    this.d.store.remove(id)
    for (const k of this.buildCache.keys()) if (k.startsWith(`${id}/`)) this.buildCache.delete(k)
    this.logs.delete(id)
    this.changed(id)
  }

  shutdown(): void {
    for (const id of [...this.runtimes.keys()]) this.stop(id, 'Custard is closing')
  }

  // Settings

  setConfig(id: string, values: Record<string, unknown>): PluginStatus {
    const st = this.d.store.state(id)
    const m = st.active ? this.build(id, st.active.buildId).manifest : this.readSource(id).manifest
    if (!m) throw new Error('Fix the plugin manifest first.')
    const config = this.d.store.config(id)
    const authKey = m.auth?.clientIdConfigKey
    for (const [k, v] of Object.entries(values)) {
      const f = m.config[k]
      if (!f) throw new Error(`Unknown setting ${k}.`)
      const clear = v === null || v === ''
      if (!clear) {
        const errors = validate(
          {
            type: f.type,
            enum: f.enum,
            pattern: f.pattern,
            minimum: f.minimum,
            maximum: f.maximum
          },
          v,
          f.title
        )
        if (errors.length) throw new Error(errors.join('; '))
      }
      if (f.secret) this.d.store.setSecret(id, k, clear ? null : String(v))
      else {
        // A different app or account invalidates the current sign-in.
        if (k === authKey && config[k] !== v) {
          this.signedOut(id)
          this.d.store.setSecret(id, OAUTH_KEY, null)
        }
        if (clear) delete config[k]
        else config[k] = v as string | number | boolean
      }
    }
    this.d.store.setConfig(id, config)
    return this.status(id)
  }

  setAskEveryTime(id: string, tool: string, ask: boolean): PluginStatus {
    const st = this.d.store.state(id)
    this.d.store.setState(id, { askEveryTime: { ...st.askEveryTime, [tool]: ask } })
    return this.status(id)
  }

  async connect(id: string): Promise<PluginStatus> {
    const { manifest, granted } = this.activeManifest(id)
    const spec = manifest.auth
    if (!spec) throw new Error('This plugin has no account to connect.')
    if (!granted.includes(`account:${new URL(spec.authorizeUrl).hostname}`))
      throw new Error('Approve account access first.')
    const clientId = this.d.store.config(id)[spec.clientIdConfigKey]
    if (typeof clientId !== 'string' || !clientId)
      throw new Error(`Set ${manifest.config[spec.clientIdConfigKey].title} first.`)
    const started = this.generation(id)
    const tokens = await signIn(spec, clientId, this.d.openBrowser, {
      allowedHosts: this.allowedHosts(manifest, granted),
      transport: this.d.transport?.()
    })
    if (this.generation(id) !== started || !this.d.store.state(id).active)
      throw new Error(
        'The sign-in was cancelled because the account was disconnected or changed meanwhile.'
      )
    this.d.store.setSecret(id, OAUTH_KEY, JSON.stringify(tokens))
    return this.status(id)
  }

  // Forgets the tokens on this computer. The provider may still list the app
  // as connected until the user removes it there.
  disconnect(id: string): PluginStatus {
    this.signedOut(id)
    this.d.store.setSecret(id, OAUTH_KEY, null)
    return this.status(id)
  }

  // The user's explicit choice when saved secrets can't be decrypted: delete
  // them (account sign-in and secret settings) so new ones can be saved.
  resetSecrets(id: string): PluginStatus {
    this.signedOut(id)
    this.d.store.resetSecrets(id)
    return this.status(id)
  }

  // Chat integration

  private activeManifest(id: string): {
    manifest: PluginManifest
    granted: string[]
    buildId: string
  } {
    const st = this.d.store.state(id)
    if (!st.enabled || !st.active) throw new Error('This plugin is not enabled.')
    return {
      manifest: this.build(id, st.active.buildId).manifest,
      granted: st.granted,
      buildId: st.active.buildId
    }
  }

  // Tools of every enabled plugin, for the existing assistant tool pipeline.
  toolSet(): { tools: BetaTool[]; snapshot: ToolSnapshot; instructions: string[] } {
    const tools: BetaTool[] = []
    const snapshot: ToolSnapshot = new Map()
    const instructions: string[] = []
    for (const id of this.d.store.ids()) {
      const st = this.d.store.state(id)
      if (!st.enabled || !st.active) continue
      const { manifest, instructions: text } = this.build(id, st.active.buildId)
      for (const t of manifest.tools) {
        const name = fullToolName(id, t.name)
        tools.push({
          name,
          description: `[${manifest.name} plugin] ${t.description}`,
          input_schema: t.inputSchema as BetaTool['input_schema']
        })
        snapshot.set(name, { pluginId: id, buildId: st.active.buildId })
      }
      if (text.trim())
        instructions.push(
          `<plugin name="${manifest.name}" tools="${id}__*">\n${text.trim()}\n</plugin>`
        )
    }
    return { tools, snapshot, instructions }
  }

  // Widgets the assistant may show now: declared by an enabled plugin's
  // active build and approved by the user.
  widgetCatalog(): {
    pluginId: string
    pluginName: string
    buildId: string
    widget: WidgetSpec
  }[] {
    const out: ReturnType<PluginHost['widgetCatalog']> = []
    for (const id of this.d.store.ids()) {
      const st = this.d.store.state(id)
      if (!st.enabled || !st.active) continue
      const { manifest } = this.build(id, st.active.buildId)
      if (permissionsOf(manifest).some((p) => !st.granted.includes(p))) continue
      for (const w of manifest.widgets ?? [])
        if (st.granted.includes(`widget:${w.id}`))
          out.push({
            pluginId: id,
            pluginName: manifest.name,
            buildId: st.active.buildId,
            widget: w
          })
    }
    return out
  }

  widgetCode(id: string, buildId: string, widgetId: string): string | null {
    return this.d.store.widgetCode(id, buildId, widgetId)
  }

  // Whether a tool of a build changes something; null if there's no such tool.
  toolWrites(id: string, buildId: string, tool: string): boolean | null {
    try {
      const t = this.build(id, buildId).manifest.tools.find((x) => x.name === tool)
      return t ? t.effect === 'write' : null
    } catch {
      return null
    }
  }

  // A line from a widget in the plugin's log, redacted like the plugin's own.
  widgetLog(id: string, line: string): void {
    this.log(id, redact(line.slice(0, 300), this.secretValues(id)))
  }

  // The chat label for a plugin tool, from its manifest.
  describeTemplate(id: string, tool: string): string | null {
    try {
      const st = this.d.store.state(id)
      if (!st.active) return null
      const { manifest } = this.build(id, st.active.buildId)
      const t = manifest.tools.find((x) => x.name === tool)
      return t ? (t.label ?? `${manifest.name}: ${t.name.replace(/_/g, ' ')}`) : null
    } catch {
      return null
    }
  }

  describeCall(name: string, input: unknown): { label: string; write: boolean } | null {
    const split = splitToolName(name)
    if (!split || !PLUGIN_ID.test(split.pluginId)) return null
    const template = this.describeTemplate(split.pluginId, split.tool)
    if (!template) return null
    const st = this.d.store.state(split.pluginId)
    const t = this.build(split.pluginId, st.active!.buildId).manifest.tools.find(
      (x) => x.name === split.tool
    )!
    return {
      label: formatLabel(template, (input ?? {}) as Record<string, unknown>),
      write: t.effect === 'write'
    }
  }

  private secretValues(id: string): string[] {
    // Locked secrets can't reach the plugin either, so there is nothing to hide.
    if (this.d.store.secretsLocked(id)) return []
    const all = this.d.store.secrets(id)
    const values = Object.entries(all)
      .filter(([k]) => k !== OAUTH_KEY)
      .map(([, v]) => v)
    if (all[OAUTH_KEY])
      try {
        const t = JSON.parse(all[OAUTH_KEY]) as Tokens
        values.push(t.accessToken, t.refreshToken)
      } catch {
        // Nothing to add.
      }
    return values
  }

  async invoke(
    name: string,
    input: unknown,
    o: {
      snapshot: ToolSnapshot
      signal: AbortSignal
      approve: (r: ApprovalRequest) => Promise<boolean>
      // The user already approved this exact call (a repeat of an action
      // whose outcome was unknown), so don't ask again.
      preApproved?: boolean
    }
  ): Promise<ToolOutcome> {
    const offered = o.snapshot.get(name)
    const split = splitToolName(name)
    if (!offered || !split || split.pluginId !== offered.pluginId)
      return notRun('This tool is not available right now.')
    const id = offered.pluginId

    // Re-checked at call time: the tool list the model saw may be stale.
    const current = (): { manifest: PluginManifest; granted: string[] } | string => {
      const st = this.d.store.state(id)
      if (!st.enabled || !st.active)
        return `The ${id} plugin is disabled, so this call was not run.`
      if (st.active.buildId !== offered.buildId)
        return 'The plugin was updated or rolled back after this reply started, so this call was not run. Ask again to use the current version.'
      const { manifest } = this.build(id, st.active.buildId)
      const missing = permissionsOf(manifest).filter((p) => !st.granted.includes(p))
      if (missing.length)
        return 'The plugin is missing approved permissions, so this call was not run.'
      return { manifest, granted: st.granted }
    }
    let c = current()
    if (typeof c === 'string') return notRun(c)
    const tool = c.manifest.tools.find((t) => t.name === split.tool)
    if (!tool) return notRun('This plugin has no such tool.')
    const errors = validate(tool.inputSchema, input ?? {})
    if (errors.length) return notRun(`Invalid input: ${errors.slice(0, 5).join('; ')}`)

    if (
      tool.effect === 'write' &&
      !o.preApproved &&
      (this.d.store.state(id).askEveryTime[tool.name] ?? this.d.askByDefault())
    ) {
      const label = this.describeCall(name, input)?.label ?? name
      const allowed = await o.approve({
        pluginId: id,
        pluginName: c.manifest.name,
        tool: tool.name,
        label,
        input,
        buildId: offered.buildId
      })
      if (!allowed)
        return notRun(
          o.signal.aborted
            ? 'Stopped before it ran, so nothing was done.'
            : 'The user declined this action, so nothing was done.'
        )
      c = current()
      if (typeof c === 'string') return notRun(c)
    }
    if (o.signal.aborted) return notRun('Stopped before it ran, so nothing was done.')

    const callId = randomUUID()
    const controller = new AbortController()
    const onAbort = (): void => controller.abort()
    o.signal.addEventListener('abort', onAbort)
    const write = tool.effect === 'write'
    this.calls.set(callId, { pluginId: id, buildId: offered.buildId, controller, write })
    const secrets = this.secretValues(id)
    // Once the call may have reached the plugin, a write cut short might
    // still have happened.
    let sent = false
    try {
      const handle = await this.ensureRunning(id, offered.buildId)
      const config: ConfigValues = {}
      for (const [k, f] of Object.entries(c.manifest.config))
        if (!f.secret && f.default !== undefined) config[k] = f.default
      for (const [k, v] of Object.entries(this.d.store.config(id)))
        if (c.manifest.config[k] && !c.manifest.config[k].secret) config[k] = v
      sent = true
      const r = await handle.call(
        callId,
        tool.name,
        input ?? {},
        config,
        tool.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        controller.signal
      )
      const content = redact(String(r.content).slice(0, MAX_RESULT_CHARS), secrets)
      const data = widgetData(r.data, secrets)
      if (r.isError) this.log(id, `${tool.name}: ${content.slice(0, 200)}`)
      const outcome = r.notSent
        ? 'not-run'
        : r.interrupted
          ? write
            ? 'unknown'
            : 'failed'
          : r.isError
            ? 'failed'
            : 'completed'
      return { content, isError: !!r.isError, outcome, ...(data !== undefined ? { data } : {}) }
    } catch (err) {
      const msg = redact(message(err), secrets)
      this.d.store.addError(id, `${tool.name}: ${msg}`)
      return { ...fail(msg), outcome: sent && write ? 'unknown' : sent ? 'failed' : 'not-run' }
    } finally {
      o.signal.removeEventListener('abort', onAbort)
      this.calls.delete(callId)
    }
  }

  private async ensureRunning(id: string, buildId: string): Promise<RuntimeHandle> {
    const r = this.runtimes.get(id)
    if (r && r.buildId === buildId) return r.handle
    // Restart after a crash or hang, one start at a time.
    let p = this.starting.get(id)
    if (!p) {
      p = this.start(id, buildId).finally(() => this.starting.delete(id))
      this.starting.set(id, p)
    }
    return p
  }

  private log(id: string, line: string): void {
    const lines = [
      ...(this.logs.get(id) ?? []),
      `${new Date().toISOString().slice(11, 19)} ${line}`
    ].slice(-50)
    this.logs.set(id, lines)
  }

  // Capabilities: the only things plugin code can ask the host to do.

  private allowedHosts(m: PluginManifest, granted: string[]): string[] {
    return m.permissions.network.filter((h) => granted.includes(`network:${h}`))
  }

  async capability(id: string, callId: string, name: string, args: unknown): Promise<CapResult> {
    const secrets = this.secretValues(id)
    try {
      const call = this.calls.get(callId)
      if (!call || call.pluginId !== id)
        throw new Error('Plugins can only use the host during a tool call.')
      if (call.controller.signal.aborted) throw new Error('The call was cancelled.')
      const { manifest, granted, buildId } = this.activeManifest(id)
      if (buildId !== call.buildId) throw new Error('The plugin was changed during this call.')
      const a = (args ?? {}) as Record<string, unknown>
      switch (name) {
        case 'fetch':
          return {
            ok: true,
            value: await this.fetchFor(id, manifest, granted, a, call.controller.signal)
          }
        case 'storage.get':
        case 'storage.set':
        case 'storage.delete': {
          if (!manifest.permissions.storage || !granted.includes('storage'))
            throw new Error('This plugin has no storage permission.')
          const key = String(a.key ?? '')
          if (name === 'storage.get') return { ok: true, value: this.d.store.data(id)[key] }
          if (name === 'storage.set' && a.value === undefined)
            throw new Error('Use storage.delete to remove a value.')
          this.d.store.setData(id, key, name === 'storage.set' ? a.value : undefined)
          return { ok: true, value: null }
        }
        case 'openExternal': {
          // Only during an action (a write tool), which the user can be
          // asked about; a read tool never shows an approval card.
          if (!call.write) throw new Error('Only actions can open links, so nothing was opened.')
          const url = String(a.url ?? '')
          const prefixes = manifest.permissions.openExternal.filter((p) =>
            granted.includes(`open:${p}`)
          )
          if (url.length > 2000 || !PLAIN_URL.test(url) || !prefixes.some((p) => url.startsWith(p)))
            throw new Error('This plugin may not open that link.')
          if (url.startsWith('https://')) new URL(url)
          await this.d.openExternal(url)
          return { ok: true, value: null }
        }
        case 'log':
          this.log(id, redact(String(a.message ?? '').slice(0, 300), secrets))
          return { ok: true, value: null }
        default:
          throw new Error(`Unknown capability ${name}.`)
      }
    } catch (err) {
      return { ok: false, error: redact(message(err), secrets) }
    }
  }

  private async fetchFor(
    id: string,
    m: PluginManifest,
    granted: string[],
    a: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<NetResponse> {
    const init = (a.init ?? {}) as {
      method?: string
      headers?: Record<string, string>
      body?: string
      auth?: boolean
    }
    const url = String(a.url ?? '')
    const auth = init.auth === true
    if (auth && !m.auth) throw new Error('This plugin has no account to sign in with.')
    if (auth && !granted.includes(`account:${new URL(m.auth!.authorizeUrl).hostname}`))
      throw new Error('Account access is not approved.')
    const send = (): Promise<NetResponse> =>
      safeFetch(url, {
        method: init.method,
        headers: init.headers,
        body: init.body,
        allowedHosts: this.allowedHosts(m, granted),
        signal,
        transport: this.d.transport?.(),
        // A request sent with the account's token only follows redirects to
        // the hosts approved to receive it.
        ...(auth ? { redirectHosts: m.auth!.apiHosts } : {}),
        extraHeaders: async (u): Promise<Record<string, string>> =>
          auth && m.auth!.apiHosts.includes(u.hostname)
            ? { authorization: `Bearer ${await this.accessToken(id, m, granted, false)}` }
            : {}
      })
    let res = await send()
    // A rejected token means nothing was done, so one retry after a refresh is safe.
    if (res.status === 401 && auth && this.d.store.secrets(id)[OAUTH_KEY]) {
      try {
        await this.accessToken(id, m, granted, true)
        res = await send()
      } catch (err) {
        if (!(err instanceof AuthError)) throw err
      }
    }
    return res
  }

  private async accessToken(
    id: string,
    m: PluginManifest,
    granted: string[],
    force: boolean
  ): Promise<string> {
    const raw = this.d.store.secrets(id)[OAUTH_KEY]
    if (!raw) throw new AuthError('Not signed in. Connect the account in Settings → Plugins.')
    const tokens = JSON.parse(raw) as Tokens
    if (!force && tokens.expiresAt - Date.now() > 60_000) return tokens.accessToken
    let p = this.refreshing.get(id)
    if (!p) {
      const started = this.generation(id)
      p = (async () => {
        const clientId = String(this.d.store.config(id)[m.auth!.clientIdConfigKey] ?? '')
        try {
          const next = await refreshTokens(m.auth!, clientId, tokens, {
            allowedHosts: this.allowedHosts(m, granted),
            transport: this.d.transport?.()
          })
          // Signed out while this was running: the new tokens are dropped.
          if (this.generation(id) !== started)
            throw new AuthError('Not signed in. Connect the account in Settings → Plugins.')
          this.d.store.setSecret(id, OAUTH_KEY, JSON.stringify(next))
          return next.accessToken
        } catch (err) {
          if (err instanceof AuthError && err.revoked && this.generation(id) === started)
            this.d.store.setSecret(id, OAUTH_KEY, null)
          throw err
        }
      })().finally(() => this.refreshing.delete(id))
      this.refreshing.set(id, p)
    }
    return p
  }
}
