import { describe, expect, it } from 'vitest'
import { Readable } from 'stream'
import { gzipSync } from 'zlib'
import { LIMITS, webFetch, type Hop } from './fetch'

type Reply = { status: number; headers?: Record<string, string>; body?: Buffer | string }

// A hop that answers from a table by URL and records what was asked.
function fakeHop(table: Record<string, Reply | ((signal: AbortSignal) => Promise<Reply>)>): {
  hop: Hop
  seen: { url: string; headers: Record<string, string> }[]
} {
  const seen: { url: string; headers: Record<string, string> }[] = []
  const hop: Hop = async (url, headers, signal) => {
    seen.push({ url: url.toString(), headers })
    const entry = table[url.toString()]
    if (!entry) throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })
    const r = typeof entry === 'function' ? await entry(signal) : entry
    const body = typeof r.body === 'string' ? Buffer.from(r.body) : (r.body ?? Buffer.alloc(0))
    return { status: r.status, headers: r.headers ?? {}, stream: Readable.from([body]) }
  }
  return { hop, seen }
}

const signal = (): AbortSignal => new AbortController().signal

describe('webFetch', () => {
  it('fetches, follows a checked redirect and reports where it ended', async () => {
    const { hop, seen } = fakeHop({
      'https://a.example.com/': { status: 301, headers: { location: '/next' } },
      'https://a.example.com/next': {
        status: 200,
        headers: { 'content-type': 'text/plain' },
        body: 'hi'
      }
    })
    const r = await webFetch('https://a.example.com/', { signal: signal(), hop })
    expect(r).toMatchObject({ url: 'https://a.example.com/next', status: 200, redirected: true })
    expect(r.body.toString()).toBe('hi')
    expect(seen).toHaveLength(2)
  })

  it('sends no cookies or authorization', async () => {
    const { hop, seen } = fakeHop({ 'https://a.example.com/': { status: 200, body: 'x' } })
    await webFetch('https://a.example.com/', { signal: signal(), hop })
    const names = Object.keys(seen[0].headers).map((h) => h.toLowerCase())
    expect(names).not.toContain('cookie')
    expect(names).not.toContain('authorization')
  })

  it.each([
    ['http://a.example.com/', /https/],
    ['https://127.0.0.1/', /IP/],
    ['https://localhost/', /Local/],
    ['https://169.254.169.254/latest/meta-data', /IP/],
    ['https://metadata.internal/', /Local/],
    ['https://a.example.com:8443/', /port/]
  ])('refuses a redirect to %s', async (target, re) => {
    const { hop, seen } = fakeHop({
      'https://a.example.com/': { status: 302, headers: { location: target } }
    })
    await expect(webFetch('https://a.example.com/', { signal: signal(), hop })).rejects.toThrow(re)
    expect(seen).toHaveLength(1)
  })

  it('stops after five redirects', async () => {
    const table: Record<string, Reply> = {}
    for (let n = 0; n < 10; n++)
      table[`https://a.example.com/${n}`] = {
        status: 302,
        headers: { location: `/${n + 1}` }
      }
    const { hop } = fakeHop(table)
    await expect(webFetch('https://a.example.com/0', { signal: signal(), hop })).rejects.toThrow(
      /more than 5/
    )
  })

  it('decompresses gzip', async () => {
    const { hop } = fakeHop({
      'https://a.example.com/': {
        status: 200,
        headers: { 'content-encoding': 'gzip' },
        body: gzipSync('hello')
      }
    })
    const r = await webFetch('https://a.example.com/', { signal: signal(), hop })
    expect(r.body.toString()).toBe('hello')
  })

  it('stops a small download that decompresses past the limit', async () => {
    const bomb = gzipSync(Buffer.alloc(LIMITS.decodedBytes + 1024))
    expect(bomb.length).toBeLessThan(LIMITS.wireBytes)
    const { hop } = fakeHop({
      'https://a.example.com/': {
        status: 200,
        headers: { 'content-encoding': 'gzip' },
        body: bomb
      }
    })
    await expect(webFetch('https://a.example.com/', { signal: signal(), hop })).rejects.toThrow(
      /10 MB once decompressed/
    )
  })

  it('stops a download past the size limit', async () => {
    const { hop } = fakeHop({
      'https://a.example.com/': { status: 200, body: Buffer.alloc(LIMITS.wireBytes + 1) }
    })
    await expect(webFetch('https://a.example.com/', { signal: signal(), hop })).rejects.toThrow(
      /larger than 5 MB/
    )
  })

  it('refuses unknown compression', async () => {
    const { hop } = fakeHop({
      'https://a.example.com/': { status: 200, headers: { 'content-encoding': 'zstd' }, body: 'x' }
    })
    await expect(webFetch('https://a.example.com/', { signal: signal(), hop })).rejects.toThrow(
      /unsupported compression/
    )
  })

  it('times out', async () => {
    const saved = LIMITS.totalMs
    LIMITS.totalMs = 50
    try {
      const { hop } = fakeHop({
        'https://a.example.com/': (s) =>
          new Promise((_, reject) =>
            s.addEventListener('abort', () => reject(new Error('aborted')))
          )
      })
      await expect(webFetch('https://a.example.com/', { signal: signal(), hop })).rejects.toThrow(
        /did not respond/
      )
    } finally {
      LIMITS.totalMs = saved
    }
  })

  it('says when the user cancelled', async () => {
    const c = new AbortController()
    const { hop } = fakeHop({
      'https://a.example.com/': (s) =>
        new Promise((_, reject) => {
          s.addEventListener('abort', () => reject(new Error('aborted')))
          c.abort()
        })
    })
    await expect(webFetch('https://a.example.com/', { signal: c.signal, hop })).rejects.toThrow(
      /cancelled/
    )
  })
})
