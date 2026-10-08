import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeSync
} from 'fs'
import { join } from 'path'
import type { MediaFile } from '../../../shared/design'

// OpenAI returns a finished image in the response to the request that paid
// for it, and keeps no copy to fetch later. So the image is written here,
// durably, before submit() reports success, and result() reads it back.
// It stays until Design has stored it on its version (or the job is gone),
// and is pruned at startup: see prune().
//
//   <root>/<remoteId>/meta.json   { model, mime, name, createdAt }
//   <root>/<remoteId>/image       the bytes
//
// Files are created exclusively and readable by this user only.

const REMOTE_ID = /^oai-img-[A-Za-z0-9_-]{1,64}$/

export type StoredMeta = { model: string; mime: string; name: string; createdAt: number }

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

  // Writes the image, then its meta last, so a half-written entry has no meta
  // and reads as missing.
  put(remoteId: string, file: MediaFile, model: string, now = Date.now()): void {
    const dir = this.dir(remoteId)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const write = (name: string, bytes: Uint8Array | string): void => {
      const fd = openSync(join(dir, name), 'wx', 0o600)
      try {
        writeSync(fd, typeof bytes === 'string' ? Buffer.from(bytes) : bytes)
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
    }
    write('image', file.bytes)
    const meta: StoredMeta = { model, mime: file.mime, name: file.name, createdAt: now }
    write('meta.json', JSON.stringify(meta))
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

  remove(remoteId: string): void {
    rmSync(this.dir(remoteId), { recursive: true, force: true })
  }

  ids(): string[] {
    if (!existsSync(this.root)) return []
    return readdirSync(this.root).filter((n) => REMOTE_ID.test(n))
  }

  // Keeps only images Design may still need: those whose job still exists
  // and whose version is still waiting for them. `keep` answers that.
  // Anything else (stored on its version already, or its chat deleted) goes.
  prune(keep: (remoteId: string) => boolean): string[] {
    const removed: string[] = []
    for (const id of this.ids()) {
      if (keep(id)) continue
      this.remove(id)
      removed.push(id)
    }
    return removed
  }
}
