import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'fs'
import { join } from 'path'
import type { BuildInfo, PluginManifest } from '../../shared/plugins'
import type { SourceFile } from './build'
import { PLUGIN_ID } from './manifest'

// Plugin state in the app data folder, separate from the source in plugin/:
//   plugins/<id>/state.json    enabled, active/previous build, granted permissions
//   plugins/<id>/config.json   non-secret configuration
//   plugins/<id>/secrets.bin   secret config and account tokens, OS-encrypted
//   plugins/<id>/data.json     the plugin's own storage
//   plugins/<id>/builds/<id>/  bundle.js, manifest.json, sources.json
// Builds never write to config or secrets, so updates keep the user's settings.

export type Crypto = {
  available(): boolean
  encrypt(text: string): Buffer
  decrypt(data: Buffer): string
}

export type StateFile = {
  enabled: boolean
  active: BuildInfo | null
  previous: BuildInfo | null
  granted: string[]
  // Per write tool: true asks before every call. Missing means the global default.
  askEveryTime: Record<string, boolean>
  // "Use in Chat and Design": the user's choice to let this plugin run in
  // Chat, Design and Skills, saved with what it covered then (the network,
  // link, account and action permissions). null means off. A version that
  // asks for anything outside it needs the choice again.
  chatDesign: string[] | null
  // The event log in the vault: the user's switch, off until they turn it on.
  events: boolean
  // Background sync (plugins/sync.ts): the user's switch, off by default.
  background: boolean
  errors: { at: number; message: string }[]
}

const emptyState = (): StateFile => ({
  enabled: false,
  active: null,
  previous: null,
  granted: [],
  askEveryTime: {},
  chatDesign: null,
  events: false,
  background: false,
  errors: []
})

const MAX_DATA_BYTES = 1024 * 1024

export class SecretsLockedError extends Error {
  constructor() {
    super(
      "Custard can't read this plugin's saved secrets right now: the system's secure storage refused. Nothing was changed. Unlock it (or sign in to your keyring) and restart Custard, or reset the plugin's saved secrets with Manage on its card in Plugins mode."
    )
  }
}

function writeAtomic(path: string, data: string | Buffer): void {
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, data)
  renameSync(tmp, path)
}

export class PluginStore {
  constructor(
    readonly base: string,
    private crypto: Crypto
  ) {}

  dir(id: string): string {
    if (!PLUGIN_ID.test(id)) throw new Error('Invalid plugin id')
    return join(this.base, id)
  }

  private file(id: string, name: string): string {
    const d = this.dir(id)
    mkdirSync(d, { recursive: true })
    return join(d, name)
  }

  private readJson<T>(path: string, fallback: T): T {
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as T
    } catch {
      return fallback
    }
  }

  ids(): string[] {
    if (!existsSync(this.base)) return []
    return readdirSync(this.base, { withFileTypes: true })
      .filter(
        (e) =>
          e.isDirectory() &&
          PLUGIN_ID.test(e.name) &&
          existsSync(join(this.base, e.name, 'state.json'))
      )
      .map((e) => e.name)
  }

  state(id: string): StateFile {
    return { ...emptyState(), ...this.readJson(join(this.dir(id), 'state.json'), {}) }
  }

  setState(id: string, patch: Partial<StateFile>): StateFile {
    const next = { ...this.state(id), ...patch }
    writeAtomic(this.file(id, 'state.json'), JSON.stringify(next, null, 2))
    return next
  }

  addError(id: string, message: string): void {
    const errors = [
      ...this.state(id).errors,
      { at: Date.now(), message: message.slice(0, 500) }
    ].slice(-20)
    this.setState(id, { errors })
  }

  // Builds

  private buildDir(id: string, buildId: string): string {
    if (!/^[0-9a-f]{16}$/.test(buildId)) throw new Error('Invalid build id')
    return join(this.dir(id), 'builds', buildId)
  }

  hasBuild(id: string, buildId: string): boolean {
    return existsSync(join(this.buildDir(id, buildId), 'bundle.js'))
  }

  saveBuild(
    id: string,
    buildId: string,
    b: {
      manifest: PluginManifest
      code: string
      sources: SourceFile[]
      instructions: string
      // Each widget's bundled UI, by widget id.
      widgets?: Record<string, string>
    }
  ): void {
    const d = this.buildDir(id, buildId)
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'manifest.json'), JSON.stringify(b.manifest, null, 2))
    writeFileSync(join(d, 'sources.json'), JSON.stringify(b.sources))
    writeFileSync(join(d, 'instructions.md'), b.instructions)
    if (b.widgets && Object.keys(b.widgets).length) {
      mkdirSync(join(d, 'widgets'), { recursive: true })
      for (const [w, code] of Object.entries(b.widgets))
        writeFileSync(join(d, 'widgets', `${w}.js`), code)
    }
    // Written last: its presence marks a complete build.
    writeAtomic(join(d, 'bundle.js'), b.code)
  }

  build(
    id: string,
    buildId: string
  ): { manifest: PluginManifest; code: string; instructions: string } {
    const d = this.buildDir(id, buildId)
    return {
      manifest: JSON.parse(readFileSync(join(d, 'manifest.json'), 'utf8')),
      code: readFileSync(join(d, 'bundle.js'), 'utf8'),
      instructions: existsSync(join(d, 'instructions.md'))
        ? readFileSync(join(d, 'instructions.md'), 'utf8')
        : ''
    }
  }

  // A widget's bundled UI from a saved build, or null if it has none.
  widgetCode(id: string, buildId: string, widgetId: string): string | null {
    if (!/^[a-z][a-z0-9-]{0,30}$/.test(widgetId)) return null
    const f = join(this.buildDir(id, buildId), 'widgets', `${widgetId}.js`)
    return existsSync(f) ? readFileSync(f, 'utf8') : null
  }

  buildSources(id: string, buildId: string): SourceFile[] {
    return this.readJson(join(this.buildDir(id, buildId), 'sources.json'), [])
  }

  // Keeps only the given builds.
  pruneBuilds(id: string, keep: string[]): void {
    const d = join(this.dir(id), 'builds')
    if (!existsSync(d)) return
    for (const b of readdirSync(d))
      if (!keep.includes(b)) rmSync(join(d, b), { recursive: true, force: true })
  }

  // Configuration

  config(id: string): Record<string, string | number | boolean> {
    return this.readJson(join(this.dir(id), 'config.json'), {})
  }

  setConfig(id: string, values: Record<string, string | number | boolean>): void {
    writeAtomic(this.file(id, 'config.json'), JSON.stringify(values, null, 2))
  }

  // A secrets file that can't be decrypted (secure storage locked, changed or
  // refused) is not the same as no secrets: it throws SecretsLockedError and
  // is left exactly as it is, so nothing in it is lost or overwritten.
  secrets(id: string): Record<string, string> {
    const path = join(this.dir(id), 'secrets.bin')
    if (!existsSync(path)) return {}
    let parsed: unknown
    try {
      parsed = JSON.parse(this.crypto.decrypt(readFileSync(path)))
    } catch {
      throw new SecretsLockedError()
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new SecretsLockedError()
    return parsed as Record<string, string>
  }

  // Whether the secrets can be read now; never throws.
  secretsLocked(id: string): boolean {
    try {
      this.secrets(id)
      return false
    } catch (err) {
      if (err instanceof SecretsLockedError) return true
      throw err
    }
  }

  // Deletes the secrets file, readable or not. Only for an explicit reset by
  // the user (or uninstall, which removes everything).
  resetSecrets(id: string): void {
    rmSync(join(this.dir(id), 'secrets.bin'), { force: true })
  }

  // Refuses (SecretsLockedError) while the existing secrets can't be read,
  // rather than replacing them.
  setSecret(id: string, key: string, value: string | null): void {
    const all = this.secrets(id)
    if (value === null) delete all[key]
    else all[key] = value
    const path = this.file(id, 'secrets.bin')
    if (!Object.keys(all).length) {
      rmSync(path, { force: true })
      return
    }
    if (!this.crypto.available())
      throw new Error("This system's secure storage isn't available, so secrets can't be saved.")
    writeAtomic(path, this.crypto.encrypt(JSON.stringify(all)))
  }

  // The plugin's own storage (storage permission)

  data(id: string): Record<string, unknown> {
    return this.readJson(join(this.dir(id), 'data.json'), {})
  }

  setData(id: string, key: string, value: unknown): void {
    if (typeof key !== 'string' || !key || key.length > 100)
      throw new Error('Storage keys are 1 to 100 characters.')
    const all = this.data(id)
    if (value === undefined) delete all[key]
    else all[key] = value
    const text = JSON.stringify(all)
    if (text.length > MAX_DATA_BYTES) throw new Error('Plugin storage is limited to 1 MB.')
    writeAtomic(this.file(id, 'data.json'), text)
  }

  // Removes everything Custard stores for the plugin. The source stays.
  remove(id: string): void {
    rmSync(this.dir(id), { recursive: true, force: true })
  }
}
