import { lookup as dnsLookup, type LookupAddress } from 'dns'
import { request as httpsRequest } from 'https'
import { BlockList, isIP, type LookupFunction } from 'net'
import { hostAllowed } from './manifest'

// The only network path plugins have. Every request is https, to a host the
// manifest lists, and every address the host name resolves to is checked at
// connect time, so a public name can't be pointed at this machine, the local
// network or a cloud metadata endpoint. Redirects are followed by hand and
// each hop is checked again.

export class NetError extends Error {}

// Separate lists: BlockList also matches IPv4 against IPv4-mapped IPv6 rules.
const blocked = new BlockList()
const blocked6 = new BlockList()
for (const [net, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4]
] as const)
  blocked.addSubnet(net, bits, 'ipv4')
for (const [net, bits] of [
  ['::', 128],
  ['::1', 128],
  ['::ffff:0:0', 96], // IPv4-mapped: checked as IPv4 below, never used directly
  ['64:ff9b::', 96], // NAT64 can reach private IPv4
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8]
] as const)
  blocked6.addSubnet(net, bits, 'ipv6')

export function isBlockedIp(ip: string): boolean {
  const v = isIP(ip)
  if (v === 4) return blocked.check(ip, 'ipv4')
  if (v === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1]
    if (mapped) return true
    return blocked6.check(ip, 'ipv6')
  }
  return true
}

export function checkUrl(raw: string, allowedHosts: string[]): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new NetError('Not a valid URL.')
  }
  if (url.protocol !== 'https:') throw new NetError('Only https URLs are allowed.')
  if (url.username || url.password) throw new NetError('URLs with credentials are not allowed.')
  if (url.port && url.port !== '443') throw new NetError('Only the default https port is allowed.')
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (isIP(host)) throw new NetError('Plugins must use host names, not IP addresses.')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local'))
    throw new NetError('Local host names are not allowed.')
  if (!hostAllowed(allowedHosts, host))
    throw new NetError(`This plugin has no permission to connect to ${host}.`)
  return url
}

// DNS lookup that refuses names resolving to a blocked address. Used as the
// socket's own lookup, so the checked address is the one connected to.
export const safeLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { all: true }, (err, addresses: LookupAddress[]) => {
    if (err) return callback(err, '', 0)
    if (!addresses.length || addresses.some((a) => isBlockedIp(a.address)))
      return callback(
        new NetError(
          `${hostname} resolves to a private or local address, which plugins can't reach.`
        ),
        '',
        0
      )
    if ((options as { all?: boolean }).all)
      (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, addresses)
    else callback(null, addresses[0].address, addresses[0].family)
  })
}

export type NetRequest = {
  url: URL
  method: string
  headers: Record<string, string>
  body?: string
  signal: AbortSignal
}
export type NetResponse = { status: number; headers: Record<string, string>; body: string }
export type Transport = (req: NetRequest) => Promise<NetResponse>

const MAX_BODY = 5 * 1024 * 1024
const TIMEOUT_MS = 20_000

export const httpsTransport: Transport = (req) =>
  new Promise((resolve, reject) => {
    const r = httpsRequest(
      req.url,
      {
        method: req.method,
        headers: req.headers,
        lookup: safeLookup,
        signal: req.signal,
        timeout: TIMEOUT_MS
      },
      (res) => {
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (c: Buffer) => {
          size += c.length
          if (size > MAX_BODY) {
            res.destroy()
            reject(new NetError('The response was larger than 5 MB.'))
          } else chunks.push(c)
        })
        res.on('end', () => {
          const headers: Record<string, string> = {}
          for (const [k, v] of Object.entries(res.headers))
            if (v !== undefined && k !== 'set-cookie')
              headers[k] = Array.isArray(v) ? v.join(', ') : v
          resolve({
            status: res.statusCode ?? 0,
            headers,
            body: Buffer.concat(chunks).toString('utf8')
          })
        })
        res.on('error', reject)
      }
    )
    r.on('timeout', () => r.destroy(new NetError('The request timed out.')))
    r.on('error', reject)
    if (req.body !== undefined) r.write(req.body)
    r.end()
  })

// Headers a plugin may not set itself.
const FORBIDDEN_HEADERS =
  /^(host|connection|content-length|transfer-encoding|cookie|proxy-.*|upgrade|te|trailer|keep-alive)$/i

export type SafeFetchOptions = {
  method?: string
  headers?: Record<string, string>
  body?: string
  allowedHosts: string[]
  signal: AbortSignal
  // Extra headers for one hop, e.g. the access token for an API host. Called
  // again for every redirect, so a token never follows a redirect elsewhere.
  extraHeaders?: (url: URL) => Promise<Record<string, string>>
  transport?: Transport
}

export async function safeFetch(rawUrl: string, o: SafeFetchOptions): Promise<NetResponse> {
  const method = (o.method ?? 'GET').toUpperCase()
  if (!/^(GET|POST|PUT|PATCH|DELETE|HEAD)$/.test(method))
    throw new NetError(`Method ${method} is not allowed.`)
  if (o.body !== undefined && (typeof o.body !== 'string' || o.body.length > 1024 * 1024))
    throw new NetError('Request bodies must be strings up to 1 MB.')
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(o.headers ?? {}))
    if (!FORBIDDEN_HEADERS.test(k) && typeof v === 'string') headers[k.toLowerCase()] = v
  const transport = o.transport ?? httpsTransport

  let url = checkUrl(rawUrl, o.allowedHosts)
  let m = method
  let body = o.body
  for (let hop = 0; hop <= 5; hop++) {
    const hopHeaders = { ...headers, ...(o.extraHeaders ? await o.extraHeaders(url) : {}) }
    if (body !== undefined && !hopHeaders['content-length'])
      hopHeaders['content-length'] = String(Buffer.byteLength(body))
    const res = await transport({ url, method: m, headers: hopHeaders, body, signal: o.signal })
    if (![301, 302, 303, 307, 308].includes(res.status)) return res
    const location = res.headers['location']
    if (!location) return res
    url = checkUrl(new URL(location, url).toString(), o.allowedHosts)
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && m === 'POST')) {
      m = 'GET'
      body = undefined
      delete headers['content-type']
    }
  }
  throw new NetError('Too many redirects.')
}
