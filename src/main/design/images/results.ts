import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync
} from 'fs'
import { randomBytes } from 'crypto'
import { join } from 'path'
import type { MediaFile } from '../../../shared/design'

// OpenAI returns a finished image in the response to the request that paid
// for it, and keeps no copy to fetch later. So the image is written here,
// durably, before submit() reports success, and result() reads it back.
// It stays until Design has stored it on its version (or the job is gone),
// and is pruned at startup: see prune().
//
//   <root>/<remoteId>/meta.json   { model, mime, name, createdAt, key }
//   <root>/<remoteId>/image       the bytes
//
// An entry is written whole into a staging folder beside it
// (".staging-<remoteId>-<random>"), both files synced, and then renamed into
// place, so <root>/<remoteId> either holds a complete entry or doesn't
// exist. A crash after both files were synced but before the rename leaves a
// complete staging folder; recover() finishes it. Files are created
// exclusively and readable by this user only. Nothing here holds the API key.

const REMOTE_ID = /^oai-img-[A-Za-z0-9_-]{1,64}$/
const STAGING = /^\.staging-(oai-img-[A-Za-z0-9_-]{1,64})-[0-9a-f]{12}$/

// `job` is Custard's own local job id (the correlation id of contract S2,
// not an OpenAI idempotency guarantee: OpenAI offers none here), so a stored
// image can be matched to its job even when the job never recorded a remote
// id. Entries written before it was added have none.
export type StoredMeta = {
  model: string
  mime: string
  name: string
  createdAt: number
  job?: string
}

function syncDir(dir: string): void {
  // Makes a rename durable on Linux and macOS. Windows can't open a folder
  // this way; NTFS journals the rename itself.
  try {
    const fd = openSync(dir, 'r')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  } catch {
    // Best effort.
  }
}

export class ResultStore {
  constructor(private root: string) {}

  private dir(remoteId: string): string {
    if (!REMOTE_ID.test(remoteId)) throw new Error('Invalid image reference.')
    return join(this.root, remoteId)
  }

  has(remoteId: string): boolean {
    try {
      return existsSync(join(this.dir(remoteId), 'meta.json'))
    } catch {
      return false
    }
  }

  // Writes the whole entry in a staging folder, then renames it into place.
  put(remoteId: string, file: MediaFile, model: string, now = Date.now(), job?: string): void {
    const dir = this.dir(remoteId)
    if (existsSync(dir)) throw new Error('This image is already stored.')
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    const staging = join(this.root, `.staging-${remoteId}-${randomBytes(6).toString('hex')}`)
    mkdirSync(staging, { mode: 0o700 })
    try {
      const write = (name: string, bytes: Uint8Array | string): void => {
        const fd = openSync(join(staging, name), 'wx', 0o600)
        try {
          const buf = typeof bytes === 'string' ? Buffer.from(bytes) : bytes
          let at = 0
          while (at < buf.byteLength) at += writeSync(fd, buf, at)
          fsyncSync(fd)
        } finally {
          closeSync(fd)
        }
      }
      write('image', file.bytes)
      const meta: StoredMeta = {
        model,
        mime: file.mime,
        name: file.name,
        createdAt: now,
        ...(job ? { job } : {})
      }
      write('meta.json', JSON.stringify(meta))
      syncDir(staging)
      renameSync(staging, dir)
      syncDir(this.root)
    } catch (err) {
      rmSync(staging, { recursive: true, force: true })
      throw err
    }
  }

  get(remoteId: string): { meta: StoredMeta; file: MediaFile } | null {
    if (!this.has(remoteId)) return null
    const dir = this.dir(remoteId)
    try {
      const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as StoredMeta
      const bytes = new Uint8Array(readFileSync(join(dir, 'image')))
      return { meta, file: { name: meta.name, mime: meta.mime, bytes } }
    } catch {
      return null
    }
  }

  // After a restart: the stored entry recorded for this job (its
  // correlation id), or null. Complete staging folders left by a crash just
  // before their rename are moved into place first. Reads and renames local
  // files only; never contacts a provider.
  findJob(correlationId: string): { remoteId: string; meta: StoredMeta; file: MediaFile } | null {
    this.finishStaging()
    for (const id of this.ids()) {
      const r = this.get(id)
      if (r && r.meta.job === correlationId) return { remoteId: id, ...r }
    }
    return null
  }

  // Moves each complete staging folder (meta.json present, so both files
  // were synced) into place, unless its id is already stored.
  private finishStaging(): void {
    for (const st of this.staging()) {
      const from = join(this.root, st.name)
      if (!existsSync(join(from, 'meta.json')) || existsSync(this.dir(st.remoteId))) continue
      try {
        renameSync(from, this.dir(st.remoteId))
        syncDir(this.root)
      } catch {
        // Left for prune.
      }
    }
  }

  // Stored entries with the job each records, for tidying.
  entries(): { remoteId: string; job?: string; createdAt: number }[] {
    return this.ids().flatMap((id) => {
      try {
        const meta = JSON.parse(readFileSync(join(this.dir(id), 'meta.json'), 'utf8')) as StoredMeta
        return [{ remoteId: id, job: meta.job, createdAt: meta.createdAt }]
      } catch {
        return [{ remoteId: id, createdAt: 0 }]
      }
    })
  }

  remove(remoteId: string): void {
    rmSync(this.dir(remoteId), { recursive: true, force: true })
  }

  ids(): string[] {
    if (!existsSync(this.root)) return []
    return readdirSync(this.root).filter((n) => REMOTE_ID.test(n))
  }

  private staging(): { name: string; remoteId: string }[] {
    if (!existsSync(this.root)) return []
    return readdirSync(this.root).flatMap((name) => {
      const m = STAGING.exec(name)
      return m ? [{ name, remoteId: m[1] }] : []
    })
  }

  // Keeps only images Design may still need, as `keep` answers: in practice
  // those whose job still exists and whose version is still waiting for them
  // (images/index.ts). Anything else (stored on its version already, or its
  // chat deleted) goes, and so does a staging folder for an id not kept.
  prune(keep: (remoteId: string) => boolean): string[] {
    const removed: string[] = []
    for (const id of this.ids()) {
      if (keep(id)) continue
      this.remove(id)
      removed.push(id)
    }
    for (const s of this.staging()) {
      if (keep(s.remoteId)) continue
      rmSync(join(this.root, s.name), { recursive: true, force: true })
    }
    return removed
  }
}
