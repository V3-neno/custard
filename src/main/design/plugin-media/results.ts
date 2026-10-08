import { request as httpsRequest } from 'https'
import { checkUrl, NetError, safeLookup } from '../../plugins/net'

// Plugin media results are untrusted: whatever a plugin returns is checked
// here before Design stores it. Files come inline (base64) or as an https
// URL on a host the plugin's own approved network permission reaches; the
// host fetches those itself, with the same address checks as plugin
// requests, so a result can't point Custard at this machine or the local
// network. Sizes are capped and each file's bytes must match a type the
// provider declared for the operation.

export const RESULT_LIMITS = {
  files: 4,
  // Per file, after decoding.
  bytes: 200 * 1024 * 1024,
  name: 120,
  redirects: 3,
  timeoutMs: 60_000
}

// A result that can't be used. Permanent unless `transient`: an expired or
// refused link, or an HTTP error, may work on a later check (the plugin can
// return a fresh link); a wrong type, bad data or a forbidden host won't.
export class ResultError extends Error {
  constructor(
    message: string,
    readonly transient = false
  ) {
    super(message)
  }
}

// What a file's first bytes say it is. Only types the app window may show
// (see MEDIA_TYPES in main/design/index.ts).
export function sniff(b: Uint8Array): string | null {
  const at = (i: number, ...xs: number[]): boolean => xs.every((x, k) => b[i + k] === x)
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png'
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'image/gif'
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp'
  if (at(4, 0x66, 0x74, 0x79, 0x70)) return 'video/mp4'
  if (at(0, 0x1a, 0x45, 0xdf, 0xa3)) return 'video/webm'
  return null
}

// The declared type, only when the bytes really are that type.
export function checkType(bytes: Uint8Array, mime: string, allowed: string[]): string {
  if (!allowed.includes(mime))
    throw new ResultError(`The provider returned ${mime}, which it didn't declare.`)
  const actual = sniff(bytes)
  if (actual !== mime)
    throw new ResultError(
      `A returned file says it is ${mime} but ${actual ? `is ${actual}` : "isn't a recognised image or video"}.`
    )
  return mime
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

export function decodeInline(base64: string, max = RESULT_LIMITS.bytes): Uint8Array {
  const clean = base64.replace(/\s+/g, '')
  if (clean.length % 4 !== 0 || !BASE64.test(clean))
    throw new ResultError('A returned file is not valid base64.')
  if ((clean.length / 4) * 3 > max + 2)
    throw new ResultError('A returned file is larger than Custard accepts.')
  return new Uint8Array(Buffer.from(clean, 'base64'))
}

export type BinaryResponse = {
  status: number
  headers: Record<string, string>
  body: Uint8Array
}
export type BinaryTransport = (r: {
  url: URL
  signal?: AbortSignal
  maxBytes: number
}) => Promise<BinaryResponse>

export const httpsBinary: BinaryTransport = ({ url, signal, maxBytes }) =>
  new Promise((resolve, reject) => {
    const r = httpsRequest(
      url,
      {
        method: 'GET',
        lookup: safeLookup,
        signal,
        timeout: RESULT_LIMITS.timeoutMs,
        headers: { accept: 'image/*, video/*' }
      },
      (res) => {
        const declared = Number(res.headers['content-length'])
        if (Number.isFinite(declared) && declared > maxBytes) {
          res.destroy()
          return reject(new ResultError('The result is larger than Custard accepts.'))
        }
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (c: Buffer) => {
          size += c.length
          if (size > maxBytes) {
            res.destroy()
            reject(new ResultError('The result is larger than Custard accepts.'))
          } else chunks.push(c)
        })
        res.on('end', () => {
          const headers: Record<string, string> = {}
          for (const [k, v] of Object.entries(res.headers))
            if (typeof v === 'string') headers[k] = v
          resolve({
            status: res.statusCode ?? 0,
            headers,
            body: new Uint8Array(Buffer.concat(chunks))
          })
        })
        res.on('error', reject)
      }
    )
    r.on('timeout', () => r.destroy(new NetError('Fetching the result timed out.')))
    r.on('error', reject)
    r.end()
  })

// Fetches a result URL. Every hop must be https to a host in `allowedHosts`
// (the plugin's approved network hosts), and is address-checked at connect.
export async function fetchResult(
  raw: string,
  o: {
    allowedHosts: string[]
    signal?: AbortSignal
    maxBytes?: number
    transport?: BinaryTransport
  }
): Promise<Uint8Array> {
  const transport = o.transport ?? httpsBinary
  const maxBytes = o.maxBytes ?? RESULT_LIMITS.bytes
  let url: URL
  try {
    url = checkUrl(raw, o.allowedHosts)
  } catch (err) {
    throw new ResultError(`Custard won't fetch that result: ${(err as Error).message}`)
  }
  for (let hop = 0; hop <= RESULT_LIMITS.redirects; hop++) {
    const res = await transport({ url, signal: o.signal, maxBytes })
    if ([301, 302, 303, 307, 308].includes(res.status) && res.headers['location']) {
      try {
        url = checkUrl(new URL(res.headers['location'], url).toString(), o.allowedHosts)
      } catch (err) {
        throw new ResultError(
          `Custard won't follow the result's redirect: ${(err as Error).message}`
        )
      }
      continue
    }
    if (res.status === 404 || res.status === 410)
      throw new ResultError('The result link has expired or is gone.', true)
    if (res.status === 401 || res.status === 403)
      throw new ResultError('The result link was refused; it may have expired.', true)
    if (res.status < 200 || res.status >= 300)
      throw new ResultError(`Fetching the result failed (HTTP ${res.status}).`, true)
    if (res.body.length > maxBytes)
      throw new ResultError('The result is larger than Custard accepts.')
    return res.body
  }
  throw new ResultError('The result link redirected too many times.')
}
