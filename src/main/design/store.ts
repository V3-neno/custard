import { createHash, randomBytes } from 'crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'fs'
import { dirname, join } from 'path'
import type { Artifact, ArtifactFile, Job } from '../../shared/design'
import { readSettingsFile, writeSettingsFile } from '../settingsFile'

// Design outputs on disk, in Custard's app data, per conversation:
//   <root>/<chat>/artifacts.json                     outputs and versions
//   <root>/<chat>/<artifact>/<version>/<file path>   each version's files
//   <root>/jobs.json                                 generation jobs
// Never in the vault. A version's files are written once (exclusive create)
// and made read-only; the index only ever gains versions, and a settled
// version never changes. They are written into a staging folder
// (<version>.partial-<random>) and renamed into place, so a version folder
// is complete or absent. A version folder that exists while the index still
// shows the version pending (Custard stopped between the rename and the
// index update) is unrecorded, so a later write for that version replaces
// it; this is how a result fetched again after a restart is saved. Deleting a chat deletes its folder here; exported
// copies elsewhere are separate files and are left alone.

export class StoreError extends Error {}

export const STORE_LIMITS = {
  fileBytes: 200 * 1024 * 1024,
  versionBytes: 400 * 1024 * 1024,
  files: 200,
  pathDepth: 4
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/
const id = (x: string, what: string): string => {
  if (!ID.test(x)) throw new StoreError(`Invalid ${what}.`)
  return x
}

// A version file's path: relative, plain names only, no "..", no hidden
// files, no Windows device or stream tricks.
export function safeFilePath(p: string): string[] {
  const parts = p.split('/')
  if (
    !parts.length ||
    parts.length > STORE_LIMITS.pathDepth ||
    !parts.every(
      (s) =>
        SEGMENT.test(s) && !/[. ]$/.test(s) && !/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(s)
    )
  )
    throw new StoreError(`"${p}" isn't an allowed file name.`)
  return parts
}

const sameVersion = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

export class ArtifactStore {
  constructor(private root: string) {}

  private chatDir(chat: string): string {
    return join(this.root, id(chat, 'chat'))
  }
  private index(chat: string): string {
    return join(this.chatDir(chat), 'artifacts.json')
  }

  list(chat: string): Artifact[] {
    const f = this.index(chat)
    if (!existsSync(f)) return []
    const raw = readSettingsFile(f) as { artifacts?: Artifact[] }
    return Array.isArray(raw.artifacts) ? raw.artifacts : []
  }

  get(chat: string, artifactId: string): Artifact | null {
    return this.list(chat).find((a) => a.id === artifactId) ?? null
  }

  // Saves an output. Refused if it would drop a version or change a settled
  // one: revisions only ever add.
  save(a: Artifact): void {
    id(a.id, 'output')
    const all = this.list(a.conversationId)
    const old = all.find((x) => x.id === a.id)
    if (old) {
      for (const v of old.versions) {
        const now = a.versions.find((x) => x.id === v.id)
        if (!now) throw new StoreError('A version can never be removed.')
        if (v.status !== 'pending' && !sameVersion(v, now))
          throw new StoreError('A finished version can never be changed.')
      }
      if (old.kind !== a.kind || old.conversationId !== a.conversationId)
        throw new StoreError("An output's kind and chat can't change.")
    }
    mkdirSync(this.chatDir(a.conversationId), { recursive: true })
    writeSettingsFile(this.index(a.conversationId), {
      artifacts: old ? all.map((x) => (x.id === a.id ? a : x)) : [...all, a]
    })
  }

  // Writes a version's files once and returns what to record on it.
  writeFiles(
    chat: string,
    artifactId: string,
    versionId: string,
    files: { path: string; mime: string; bytes: Uint8Array }[]
  ): ArtifactFile[] {
    if (!files.length) throw new StoreError('No files to store.')
    if (files.length > STORE_LIMITS.files) throw new StoreError('Too many files.')
    const total = files.reduce((n, f) => n + f.bytes.byteLength, 0)
    if (total > STORE_LIMITS.versionBytes)
      throw new StoreError('These files are too large to keep.')
    const settled = this.get(chat, artifactId)?.versions.find((v) => v.id === versionId)
    if (settled && settled.status !== 'pending')
      throw new StoreError('A finished version can never be changed.')
    const parent = join(this.chatDir(chat), id(artifactId, 'output'))
    const dir = join(parent, id(versionId, 'version'))
    const staging = `${dir}.partial-${randomBytes(6).toString('hex')}`
    mkdirSync(parent, { recursive: true })
    mkdirSync(staging)
    const seen = new Set<string>()
    const records: ArtifactFile[] = []
    try {
      for (const f of files) {
        const parts = safeFilePath(f.path)
        const key = parts.join('/').toLowerCase()
        if (seen.has(key)) throw new StoreError(`"${f.path}" is listed twice.`)
        seen.add(key)
        if (f.bytes.byteLength > STORE_LIMITS.fileBytes)
          throw new StoreError(`${f.path} is too large.`)
        const full = join(staging, ...parts)
        mkdirSync(dirname(full), { recursive: true })
        writeFileSync(full, f.bytes, { flag: 'wx' })
        chmodSync(full, 0o444)
        records.push({
          path: parts.join('/'),
          mime: f.mime,
          sha256: createHash('sha256').update(f.bytes).digest('hex'),
          size: f.bytes.byteLength
        })
      }
      // Leftovers for this version: an unrecorded folder, or staging from an
      // attempt that stopped part way.
      rmSync(dir, { recursive: true, force: true })
      for (const n of readdirSync(parent))
        if (n.startsWith(`${versionId}.partial-`) && join(parent, n) !== staging)
          rmSync(join(parent, n), { recursive: true, force: true })
      renameSync(staging, dir)
    } catch (err) {
      rmSync(staging, { recursive: true, force: true })
      throw err
    }
    return records
  }

  // The stored file for a path recorded on a version, or null. Only recorded
  // files are ever served or exported.
  file(
    chat: string,
    artifactId: string,
    versionId: string,
    path: string
  ): { full: string; record: ArtifactFile } | null {
    const v = this.get(chat, artifactId)?.versions.find((x) => x.id === versionId)
    const record = v?.files.find((f) => f.path === path)
    if (!record) return null
    return {
      full: join(this.chatDir(chat), artifactId, versionId, ...safeFilePath(record.path)),
      record
    }
  }

  read(chat: string, artifactId: string, versionId: string, path: string): Buffer | null {
    const f = this.file(chat, artifactId, versionId, path)
    if (!f) return null
    const bytes = readFileSync(f.full)
    // A file changed on disk is not served as if it were the version.
    if (createHash('sha256').update(bytes).digest('hex') !== f.record.sha256) return null
    return bytes
  }

  deleteChat(chat: string): void {
    const dir = this.chatDir(chat)
    if (!existsSync(dir)) return
    rmSync(dir, { recursive: true, force: true })
  }
}

// Jobs survive restarts; see jobs.ts for what a restart does with them.
export class JobStore {
  constructor(private file: string) {}

  load(): Job[] {
    if (!existsSync(this.file)) return []
    const raw = readSettingsFile(this.file) as { jobs?: Job[] }
    return Array.isArray(raw.jobs) ? raw.jobs : []
  }

  save(job: Job): void {
    const all = this.load()
    const at = all.findIndex((j) => j.id === job.id)
    if (at >= 0) all[at] = job
    else all.push(job)
    mkdirSync(dirname(this.file), { recursive: true })
    writeSettingsFile(this.file, { jobs: all })
  }

  deleteChat(chat: string): void {
    const all = this.load()
    const kept = all.filter((j) => j.requestedBy.conversationId !== chat)
    if (kept.length !== all.length) writeSettingsFile(this.file, { jobs: kept })
  }
}
