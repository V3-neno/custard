import { definePlugin, PluginError } from 'custard-plugin-sdk'
// clip.ts is replaced by slowmo's clip when the harness installs this plugin.
import { CLIP_WEBM } from './clip'

// DEVELOPMENT-ONLY media plugin for test/platform/media-sizes.mjs. It contacts
// nothing: it builds its files inside the plugin sandbox, so realistic sizes
// cross the sandbox and IPC exactly as a provider's inline results would.
// Words in the prompt choose the result:
//   png=<side>       a valid, uncompressed <side>x<side> RGB PNG
//   webm=<MB>        the fixture clip plus an EBML Void element, <MB> in all
//   files=<n>        n copies of the file (named 1-image.png, 2-image.png...)
//   samename         the copies all share one name
//   badb64           base64 with characters outside the alphabet
//   truncated        the PNG cut off halfway
//   mismatch         says image/png, is the WebM clip
//   resultfail       the result tool throws
type Job = { id: string; prompt: string; operation: string }

const word = (p: string, w: string): boolean => new RegExp(`\\b${w}\\b`).test(p)
const num = (p: string, k: string): number | null => {
  const m = new RegExp(`\\b${k}=(\\d+)`).exec(p)
  return m ? Number(m[1]) : null
}

const fromB64 = (s: string): Uint8Array => {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
const toB64 = (b: Uint8Array): string => {
  let s = ''
  // A multiple of 3, so the chunks join into one valid string.
  const step = 3 * 0x4000
  for (let i = 0; i < b.length; i += step) {
    let bin = ''
    const part = b.subarray(i, i + step)
    for (let k = 0; k < part.length; k += 0x2000)
      bin += String.fromCharCode(...part.subarray(k, k + 0x2000))
    s += btoa(bin)
  }
  return s
}

const CRC = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
const crc32 = (parts: Uint8Array[]): number => {
  let c = 0xffffffff
  for (const b of parts) for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const u32 = (n: number): Uint8Array =>
  new Uint8Array([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255])
const ascii = (s: string): Uint8Array => new Uint8Array([...s].map((c) => c.charCodeAt(0)))
const concat = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}
const chunk = (type: string, data: Uint8Array): Uint8Array => {
  const t = ascii(type)
  return concat([u32(data.length), t, data, u32(crc32([t, data]))])
}

// A gradient, stored (not compressed) so the size is what was asked for.
function png(side: number): Uint8Array {
  const row = 1 + side * 3
  const raw = new Uint8Array(row * side)
  for (let y = 0; y < side; y++)
    for (let x = 0; x < side; x++) {
      const o = y * row + 1 + x * 3
      raw[o] = (x * 255) / side
      raw[o + 1] = (y * 255) / side
      raw[o + 2] = 128
    }
  const blocks: Uint8Array[] = [new Uint8Array([0x78, 0x01])]
  for (let i = 0; i < raw.length; i += 65535) {
    const len = Math.min(65535, raw.length - i)
    const last = i + len >= raw.length ? 1 : 0
    blocks.push(new Uint8Array([last, len & 255, len >> 8, ~len & 255, (~len >> 8) & 255]))
    blocks.push(raw.subarray(i, i + len))
  }
  let a = 1
  let b = 0
  for (let i = 0; i < raw.length; i++) {
    a = (a + raw[i]) % 65521
    b = (b + a) % 65521
  }
  blocks.push(u32(((b << 16) | a) >>> 0))
  const ihdr = concat([u32(side), u32(side), new Uint8Array([8, 2, 0, 0, 0])])
  return concat([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', concat(blocks)),
    chunk('IEND', new Uint8Array())
  ])
}

// The clip, then a top-level EBML Void element (0xEC, 8-byte size) as padding.
function webm(mb: number): Uint8Array {
  const clip = fromB64(CLIP_WEBM)
  const pad = Math.max(0, mb * 1024 * 1024 - clip.length - 9)
  const size = new Uint8Array(8)
  size[0] = 0x01
  let n = pad
  for (let i = 7; i >= 1; i--) {
    size[i] = n % 256
    n = Math.floor(n / 256)
  }
  return concat([clip, new Uint8Array([0xec]), size, new Uint8Array(pad)])
}

export default definePlugin({
  tools: {
    submit: async (i: { operation: string; prompt: string; idempotencyKey: string }, ctx) => {
      const jobs = (await ctx.storage.get<Job[]>('jobs')) ?? []
      const job = { id: `big-${jobs.length + 1}`, prompt: i.prompt, operation: i.operation }
      await ctx.storage.set('jobs', [...jobs, job])
      return {
        content: `Started ${job.id}.`,
        data: { remoteId: job.id, status: { state: 'pending' } }
      }
    },
    status: async () => ({ content: 'Completed.', data: { state: 'completed' } }),
    result: async (i: { remoteId: string }, ctx) => {
      const job = ((await ctx.storage.get<Job[]>('jobs')) ?? []).find((j) => j.id === i.remoteId)
      if (!job) throw new PluginError('No such job.')
      const p = job.prompt
      if (word(p, 'resultfail')) throw new PluginError('The test service lost the result.')
      const video = job.operation.startsWith('video.')
      let bytes = video ? webm(num(p, 'webm') ?? 1) : png(num(p, 'png') ?? 256)
      if (word(p, 'truncated')) bytes = bytes.subarray(0, Math.floor(bytes.length / 2))
      let mime = video ? 'video/webm' : 'image/png'
      if (word(p, 'mismatch')) {
        bytes = fromB64(CLIP_WEBM)
        mime = 'image/png'
      }
      let base64 = toB64(bytes)
      if (word(p, 'badb64')) base64 = base64.slice(0, 1000) + '*!' + base64.slice(1002)
      const n = num(p, 'files') ?? 1
      const base = video ? 'clip.webm' : 'image.png'
      const name = (k: number): string =>
        word(p, 'samename') || n === 1 ? base : `${k + 1}-${base}`
      return {
        content: 'Here are the files.',
        data: { files: Array.from({ length: n }, (_, k) => ({ name: name(k), mime, base64 })) }
      }
    }
  }
})
