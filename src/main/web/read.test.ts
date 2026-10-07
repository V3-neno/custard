import { beforeEach, describe, expect, it } from 'vitest'
import { Readable } from 'stream'
import type { Hop } from './fetch'
import { CHUNK, clearReadCache, webRead } from './read'

const hopFor =
  (status: number, type: string, body: string, calls = { n: 0 }): Hop =>
  async () => {
    calls.n++
    return { status, headers: { 'content-type': type }, stream: Readable.from([Buffer.from(body)]) }
  }
const signal = new AbortController().signal

beforeEach(clearReadCache)

describe('webRead', () => {
  it('returns long pages in parts with an explicit continuation', async () => {
    const text = 'abcdefghij'.repeat(CHUNK / 5) // two parts
    const calls = { n: 0 }
    const hop = hopFor(200, 'text/plain', text, calls)
    const first = await webRead({ url: 'https://x.example.com/long' }, signal, hop)
    expect(first.isError).toBe(false)
    expect(first.content).toMatch(/Untrusted web content/)
    expect(first.content).toContain(`[Truncated: characters 0–${CHUNK} of ${text.length}.`)
    expect(first.content).toContain(`offset ${CHUNK}`)
    const second = await webRead({ url: 'https://x.example.com/long', offset: CHUNK }, signal, hop)
    expect(second.content).toContain(`characters ${CHUNK}–${text.length} of ${text.length}`)
    expect(second.content).not.toContain('To read on')
    expect(calls.n).toBe(1) // the second part came from the cache
  })

  it('reports HTTP errors, unsupported types and empty pages plainly', async () => {
    expect(
      (await webRead({ url: 'https://x.example.com/a' }, signal, hopFor(404, 'text/html', 'nope')))
        .content
    ).toMatch(/HTTP 404 \(Not Found\)/)
    expect(
      (await webRead({ url: 'https://x.example.com/b' }, signal, hopFor(200, 'video/mp4', 'x')))
        .content
    ).toMatch(/video\/mp4, which web_read can't read/)
    const empty = await webRead(
      { url: 'https://x.example.com/c' },
      signal,
      hopFor(200, 'text/html', '<html><body></body></html>')
    )
    expect(empty).toMatchObject({ isError: true })
    expect(empty.content).toMatch(/no readable text\.$/)
    expect(empty.content).not.toMatch(/JavaScript/)
  })

  it('refuses blocked destinations without fetching', async () => {
    const calls = { n: 0 }
    const r = await webRead(
      { url: 'https://10.0.0.1/' },
      signal,
      hopFor(200, 'text/plain', 'x', calls)
    )
    expect(r.content).toMatch(/IP addresses/)
    expect(calls.n).toBe(0)
  })

  it('lists links with the first part', async () => {
    const r = await webRead(
      { url: 'https://x.example.com/p' },
      signal,
      hopFor(
        200,
        'text/html',
        '<html><body><p>Hello there.</p><a href="/q?a=1">Q</a></body></html>'
      )
    )
    expect(r.content).toContain('[1] Q: https://x.example.com/q?a=1')
    expect(r.page?.links).toEqual(['https://x.example.com/q?a=1'])
  })
})
