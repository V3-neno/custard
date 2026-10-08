import { request as httpsRequest } from 'https'
import type { IncomingMessage } from 'http'
import { createBrotliDecompress, createGunzip, createInflate } from 'zlib'
import type { Transform } from 'stream'
import { checkPublicUrl, NetError, safeLookup } from '../plugins/net'

// Fetches a public web page for web_read. Same address rules as plugin
// network access (https only, every hop's DNS answer checked at connect
// time), but any public host is allowed and nothing identifying is sent: no
// cookies, no tokens, no authorization.

export const LIMITS = {
  totalMs: 20_000,
  redirects: 5,
  wireBytes: 5 * 1024 * 1024,
  decodedBytes: 10 * 1024 * 1024
}

export type WebResponse = {
  url: string // after redirects
  status: number
  headers: Record<string, string>
  body: Buffer // decompressed
  redirected: boolean
}

// One hop: a request and its raw (still compressed) response stream.
export type Hop = (
  url: URL,
  headers: Record<string, string>,
  signal: AbortSignal
) => Promise<{ status: number; headers: Record<string, string>; stream: NodeJS.ReadableStream }>

const HEADERS = {
  'user-agent': 'Mozilla/5.0 (compatible; Custard/0.1; +https://github.com/V3-neno/custard)',
  accept:
    'text/html,application/xhtml+xml,text/markdown,text/plain,application/json;q=0.9,*/*;q=0.5',
  'accept-encoding': 'gzip, deflate, br',
  'accept-language': 'en;q=0.9, *;q=0.5'
}

const flatHeaders = (res: IncomingMessage): Record<string, string> => {
  const h: Record<string, string> = {}
  for (const [k, v] of Object.entries(res.headers))
    if (v !== undefined && k !== 'set-cookie') h[k] = Array.isArray(v) ? v.join(', ') : v
  return h
}

export const httpsHop: Hop = (url, headers, signal) =>
  new Promise((resolve, reject) => {
    const r = httpsRequest(
      url,
      // A fresh agent each time: no pooled sockets, no shared session state.
      { method: 'GET', headers, lookup: safeLookup, signal, agent: false },
      (res) => resolve({ status: res.statusCode ?? 0, headers: flatHeaders(res), stream: res })
    )
    r.on('error', reject)
    r.end()
  })

function decoder(encoding: string | undefined): Transform | null {
  switch ((encoding ?? '').trim().toLowerCase()) {
    case '':
    case 'identity':
      return null
    case 'gzip':
    case 'x-gzip':
      return createGunzip()
    case 'deflate':
      return createInflate()
    case 'br':
      return createBrotliDecompress()
    default:
      throw new NetError(`The page used an unsupported compression (${encoding}).`)
  }
}

// Reads a response, stopping as soon as either limit is passed.
function readBody(
  stream: NodeJS.ReadableStream,
  encoding: string | undefined,
  signal: AbortSignal
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let wire = 0
    let size = 0
    const chunks: Buffer[] = []
    const dec = decoder(encoding)
    let done = false
    const fail = (err: Error): void => {
      if (done) return
      done = true
      ;(stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.()
      dec?.destroy()
      reject(err)
    }
    const onAbort = (): void => fail(new NetError('The request was cancelled or timed out.'))
    signal.addEventListener('abort', onAbort, { once: true })
    stream.on('data', (c: Buffer) => {
      wire += c.length
      if (wire > LIMITS.wireBytes) fail(new NetError('The page was larger than 5 MB.'))
    })
    const out = dec ?? stream
    out.on('data', (c: Buffer) => {
      size += c.length
      if (size > LIMITS.decodedBytes)
        fail(new NetError('The page was larger than 10 MB once decompressed.'))
      else chunks.push(c)
    })
    out.on('end', () => {
      if (done) return
      done = true
      signal.removeEventListener('abort', onAbort)
      resolve(Buffer.concat(chunks))
    })
    out.on('error', (e: Error) =>
      fail(dec ? new NetError(`The page couldn't be decompressed: ${e.message}`) : e)
    )
    stream.on('error', (e: Error) => fail(e))
    if (dec) stream.pipe(dec)
  })
}

export async function webFetch(
  rawUrl: string,
  o: { signal: AbortSignal; hop?: Hop }
): Promise<WebResponse> {
  // Tests of the built app swap the network for a fake, like plugin transport.
  const testHop = (globalThis as { __custardWebHop?: Hop }).__custardWebHop
  const hop = o.hop ?? testHop ?? httpsHop
  const signal = AbortSignal.any([o.signal, AbortSignal.timeout(LIMITS.totalMs)])
  let url = checkPublicUrl(rawUrl)
  try {
    for (let n = 0; n <= LIMITS.redirects; n++) {
      const res = await hop(url, { ...HEADERS }, signal)
      if ([301, 302, 303, 307, 308].includes(res.status) && res.headers['location']) {
        ;(res.stream as NodeJS.ReadableStream & { resume?: () => void }).resume?.()
        // Each hop is checked like the first.
        url = checkPublicUrl(new URL(res.headers['location'], url).toString())
        continue
      }
      const body = await readBody(res.stream, res.headers['content-encoding'], signal)
      return {
        url: url.toString(),
        status: res.status,
        headers: res.headers,
        body,
        redirected: n > 0
      }
    }
  } catch (err) {
    if (signal.aborted && !o.signal.aborted)
      throw new NetError('The page did not respond within 20 seconds.')
    if (o.signal.aborted) throw new NetError('The request was cancelled.')
    throw err
  }
  throw new NetError('The page redirected more than 5 times.')
}
