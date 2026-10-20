import { createHash, randomBytes } from 'crypto'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'fs'
import { join, sep } from 'path'
import { isDeniedName, SHORT_NAME } from '../workspace/paths'
import { parseScriptManifest, SCRIPT_ID, type ScriptManifest } from './manifest'

// User scripts in the app data folder (docs/proposals/script-tools.md):
//   scripts/<id>/src/           source, edited in the Scripts workspace
//   scripts/<id>/approved/      copy of src taken when the user approved it
//   scripts/<id>/env/           Python venv, made only by "Install dependencies"
//   scripts/<id>/node_modules/  Node packages, same; Node finds them from approved/
//   scripts/<id>/work/          the script's current folder when it runs
//   scripts/<id>/runs/          run records
//   scripts/<id>/state.json     switches and the approval record
//
// Only approved/ ever runs. Its files are hashed again before every run and
// compared with the approval record, so a script (or anything else) that
// changes its own approved copy has to be approved again.

export type Approval = {
  version: string
  digest: string
  files: Record<string, string>
  at: number
}

export type ScriptState = {
  enabled: boolean
  // "Use in Chat": offered to the model in chats. Off until the user turns it on.
  useInChat: boolean
  approval: Approval | null
}

const emptyState = (): ScriptState => ({ enabled: false, useInChat: false, approval: null })

export const SNAPSHOT_LIMITS = { files: 500, bytes: 20 * 1024 * 1024 }
const RUNS_KEPT = 50

// Generated files that don't count as source and aren't copied.
const SKIPPED = /^(__pycache__|\.pytest_cache|\.mypy_cache|.*\.pyc|\.DS_Store|Thumbs\.db)$/i
// Dependency folders belong outside src/ (env/ and node_modules/ next to it).
const NOT_IN_SOURCE = /^(env|\.venv|venv|node_modules)$/i

export class SnapshotError extends Error {}

function writeAtomic(path: string, data: string): void {
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, data)
  renameSync(tmp, path)
}

// Every file under `root` as "a/b.py" → sha256, refusing links, secret-looking
// names and anything over the limits. Sorted, so the digest is stable.
// `strict` (for the approved copy) also refuses generated files such as
// __pycache__: a planted .pyc there could run code that was never reviewed.
export function hashTree(root: string, strict = false): Record<string, string> {
  const out: Record<string, string> = {}
  let count = 0
  let bytes = 0
  const walk = (dir: string, rel: string[]): void => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    )) {
      const path = [...rel, e.name].join('/')
      if (SKIPPED.test(e.name)) {
        if (strict) throw new SnapshotError(`${path}: generated files are not allowed here.`)
        continue
      }
      if (NOT_IN_SOURCE.test(e.name) && e.isDirectory())
        throw new SnapshotError(`${path}: dependencies don't belong in the source folder.`)
      if (isDeniedName(e.name) || SHORT_NAME.test(e.name))
        throw new SnapshotError(`${path}: this name is off limits in a script.`)
      const full = join(dir, e.name)
      const st = lstatSync(full)
      if (st.isSymbolicLink()) throw new SnapshotError(`${path}: links are not allowed.`)
      if (st.isDirectory()) walk(full, [...rel, e.name])
      else if (st.isFile()) {
        if (st.nlink > 1) throw new SnapshotError(`${path}: hard-linked files are not allowed.`)
        count++
        bytes += st.size
        if (count > SNAPSHOT_LIMITS.files)
          throw new SnapshotError(`A script can have at most ${SNAPSHOT_LIMITS.files} files.`)
        if (bytes > SNAPSHOT_LIMITS.bytes)
          throw new SnapshotError('A script can be at most 20 MB, not counting dependencies.')
        out[path] = createHash('sha256').update(readFileSync(full)).digest('hex')
      } else throw new SnapshotError(`${path}: only plain files and folders are allowed.`)
    }
  }
  walk(root, [])
  return out
}

export const digestOf = (files: Record<string, string>): string =>
  createHash('sha256')
    .update(
      Object.keys(files)
        .sort()
        .map((k) => `${k}\0${files[k]}\n`)
        .join('')
    )
    .digest('hex')

export type RunRecord = {
  at: number
  tool: string
  input: unknown
  caller: string
  ok: boolean
  error?: string
  exitCode: number | null
  ended: 'exit' | 'timeout' | 'stopped' | 'output-limit' | 'spawn-failed'
  durationMs: number
  stdoutTail: string
  stderrTail: string
}

export class ScriptStore {
  constructor(readonly base: string) {}

  dir(id: string): string {
    if (!SCRIPT_ID.test(id)) throw new Error('Invalid script id')
    return join(this.base, id)
  }
  srcDir = (id: string): string => join(this.dir(id), 'src')
  approvedDir = (id: string): string => join(this.dir(id), 'approved')
  workDir = (id: string): string => join(this.dir(id), 'work')
  envDir = (id: string): string => join(this.dir(id), 'env')
  nodeModulesDir = (id: string): string => join(this.dir(id), 'node_modules')
  private runsDir = (id: string): string => join(this.dir(id), 'runs')

  ids(): string[] {
    if (!existsSync(this.base)) return []
    return readdirSync(this.base, { withFileTypes: true })
      .filter((e) => e.isDirectory() && SCRIPT_ID.test(e.name))
      .map((e) => e.name)
      .sort()
  }

  state(id: string): ScriptState {
    try {
      return {
        ...emptyState(),
        ...(JSON.parse(readFileSync(join(this.dir(id), 'state.json'), 'utf8')) as object)
      }
    } catch {
      return emptyState()
    }
  }

  setState(id: string, patch: Partial<ScriptState>): ScriptState {
    const next = { ...this.state(id), ...patch }
    mkdirSync(this.dir(id), { recursive: true })
    writeAtomic(join(this.dir(id), 'state.json'), JSON.stringify(next, null, 2))
    return next
  }

  // The manifest in a folder (source or approved copy).
  manifestIn(
    id: string,
    folder: string
  ): { ok: true; manifest: ScriptManifest } | { ok: false; errors: string[] } {
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(join(folder, 'script.json'), 'utf8'))
    } catch (err) {
      return {
        ok: false,
        errors: [
          existsSync(join(folder, 'script.json'))
            ? `script.json is not valid JSON: ${(err as Error).message}`
            : 'script.json is missing'
        ]
      }
    }
    const parsed = parseScriptManifest(raw, id)
    if (!parsed.ok) return parsed
    const entry = join(folder, ...parsed.manifest.entry.split('/'))
    if (!existsSync(entry))
      return { ok: false, errors: [`entry ${parsed.manifest.entry} is missing`] }
    return parsed
  }

  // What approving now would record: the source's manifest and hashes.
  review(id: string): {
    manifest: ScriptManifest
    files: Record<string, string>
    digest: string
  } {
    const src = this.srcDir(id)
    if (!existsSync(src)) throw new SnapshotError('This script has no source folder.')
    const parsed = this.manifestIn(id, src)
    if (!parsed.ok) throw new SnapshotError(parsed.errors.join('\n'))
    const files = hashTree(src)
    return { manifest: parsed.manifest, files, digest: digestOf(files) }
  }

  // Copies src/ to approved/ and records its hashes. `expectDigest` is the
  // digest the user saw on the review screen: if the source changed since,
  // nothing is approved.
  approve(id: string, expectDigest: string, now = Date.now()): Approval {
    const r = this.review(id)
    if (r.digest !== expectDigest)
      throw new SnapshotError('The script changed after you reviewed it. Review it again.')
    const dir = this.dir(id)
    const tmp = join(dir, `approved.${process.pid}.${randomBytes(4).toString('hex')}.tmp`)
    cpSync(this.srcDir(id), tmp, {
      recursive: true,
      filter: (s) => !s.split(sep).some((p) => SKIPPED.test(p))
    })
    // The copy must be exactly what was reviewed.
    const copied = hashTree(tmp, true)
    if (digestOf(copied) !== r.digest) {
      rmSync(tmp, { recursive: true, force: true })
      throw new SnapshotError('The script changed while it was being approved. Review it again.')
    }
    const old = join(dir, `approved.old.${process.pid}`)
    if (existsSync(this.approvedDir(id))) renameSync(this.approvedDir(id), old)
    renameSync(tmp, this.approvedDir(id))
    rmSync(old, { recursive: true, force: true })
    const approval: Approval = {
      version: r.manifest.version,
      digest: r.digest,
      files: r.files,
      at: now
    }
    this.setState(id, { approval })
    mkdirSync(this.workDir(id), { recursive: true })
    return approval
  }

  // Throws unless approved/ is exactly what was approved.
  verifyApproved(id: string): ScriptManifest {
    const a = this.state(id).approval
    if (!a) throw new SnapshotError('This script has not been approved.')
    if (!existsSync(this.approvedDir(id)))
      throw new SnapshotError('The approved copy is missing. Approve the script again.')
    let digest: string
    try {
      digest = digestOf(hashTree(this.approvedDir(id), true))
    } catch (err) {
      throw new SnapshotError(`The approved copy can't be checked: ${(err as Error).message}`)
    }
    if (digest !== a.digest)
      throw new SnapshotError(
        'The approved copy changed since you approved it, so it will not run. Review and approve it again.'
      )
    const parsed = this.manifestIn(id, this.approvedDir(id))
    if (!parsed.ok) throw new SnapshotError(parsed.errors.join('\n'))
    return parsed.manifest
  }

  // Removes what Custard made for the script; keeps the source.
  uninstall(id: string): void {
    for (const d of ['approved', 'env', 'node_modules', 'work', 'runs', 'state.json'])
      rmSync(join(this.dir(id), d), { recursive: true, force: true })
  }

  addRun(id: string, record: RunRecord): void {
    const dir = this.runsDir(id)
    mkdirSync(dir, { recursive: true })
    const name = `${String(record.at).padStart(14, '0')}-${randomBytes(3).toString('hex')}.json`
    writeAtomic(join(dir, name), JSON.stringify(record, null, 2))
    const all = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort()
    for (const f of all.slice(0, Math.max(0, all.length - RUNS_KEPT)))
      rmSync(join(dir, f), { force: true })
  }

  runs(id: string): RunRecord[] {
    const dir = this.runsDir(id)
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .reverse()
      .flatMap((f) => {
        try {
          return [JSON.parse(readFileSync(join(dir, f), 'utf8')) as RunRecord]
        } catch {
          return []
        }
      })
  }
}
