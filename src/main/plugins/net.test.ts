import { describe, expect, it } from 'vitest'
import {
  checkUrl,
  isBlockedIp,
  safeFetch,
  safeLookup,
  type NetRequest,
  type NetResponse
} from './net'
import { redact } from './redact'

const allowed = ['api.example.com', '*.cdn.example.com']

describe('isBlockedIp', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.100.100.200',
    '0.0.0.0',
    '::1',
    '::',
    'fe80::1',
    'fd00:ec2::254',
    '::ffff:127.0.0.1',
    '::ffff:8.8.8.8',
    '64:ff9b::7f00:1',
    'not-an-ip'
  ])('blocks %s', (ip) => expect(isBlockedIp(ip)).toBe(true))

  it.each(['8.8.8.8', '35.186.224.25', '2606:4700:4700::1111'])('allows %s', (ip) =>
    expect(isBlockedIp(ip)).toBe(false)
  )
})

describe('checkUrl', () => {
  it('allows listed https hosts', () => {
    expect(checkUrl('https://api.example.com/v1', allowed).hostname).toBe('api.example.com')
    expect(checkUrl('https://img.cdn.example.com/x.png', allowed).hostname).toBe(
      'img.cdn.example.com'
    )
  })
  it.each([
    ['http://api.example.com/', /https/],
    ['https://other.example.com/', /no permission/],
    ['https://127.0.0.1/', /IP addresses/],
    ['https://[::1]/', /IP addresses/],
    ['https://localhost/', /Local/],
    ['https://user:pw@api.example.com/', /credentials/],
    ['https://api.example.com:8443/', /port/],
    ['file:///etc/passwd', /https/],
    ['https://api.example.com.evil.org/', /no permission/]
  ])('refuses %s', (url, re) => expect(() => checkUrl(url, allowed)).toThrow(re))
})

describe('safeLookup', () => {
  it('refuses names that resolve to loopback', async () => {
    const err = await new Promise<Error | null>((resolve) =>
      safeLookup('localhost', {}, (e) => resolve(e))
    )
    expect(err?.message).toMatch(/private or local/)
  })
})

type Route = (req: NetRequest) => NetResponse
const transport =
  (route: Route, seen: NetRequest[] = []) =>
  async (req: NetRequest) => {
    seen.push(req)
    return route(req)
  }
const res = (status: number, headers: Record<string, string> = {}, body = ''): NetResponse => ({
  status,
  headers,
  body
})
const signal = new AbortController().signal

describe('safeFetch', () => {
  it('re-checks every redirect hop', async () => {
    const t = transport((r) =>
      r.url.pathname === '/start' ? res(302, { location: 'https://evil.example.org/x' }) : res(200)
    )
    await expect(
      safeFetch('https://api.example.com/start', { allowedHosts: allowed, signal, transport: t })
    ).rejects.toThrow(/no permission/)
  })

  it('refuses redirects to IPs and local names', async () => {
    for (const location of [
      'https://169.254.169.254/latest/meta-data',
      'https://localhost/',
      'http://api.example.com/'
    ])
      await expect(
        safeFetch('https://api.example.com/start', {
          allowedHosts: allowed,
          signal,
          transport: transport(() => res(301, { location }))
        })
      ).rejects.toThrow()
  })

  it('adds host-provided auth per hop, so it never follows a redirect elsewhere', async () => {
    const seen: NetRequest[] = []
    const t = transport(
      (r) =>
        r.url.hostname === 'api.example.com'
          ? res(302, { location: 'https://a.cdn.example.com/file' })
          : res(200, {}, 'ok'),
      seen
    )
    const r = await safeFetch('https://api.example.com/file', {
      allowedHosts: allowed,
      signal,
      transport: t,
      extraHeaders: async (u): Promise<Record<string, string>> =>
        u.hostname === 'api.example.com' ? { authorization: 'Bearer secret-token' } : {}
    })
    expect(r.body).toBe('ok')
    expect(seen[0].headers.authorization).toBe('Bearer secret-token')
    expect(seen[1].headers.authorization).toBeUndefined()
  })

  it('turns POST into GET on 303 and drops the body', async () => {
    const seen: NetRequest[] = []
    const t = transport(
      (r) => (r.url.pathname === '/a' ? res(303, { location: '/b' }) : res(200)),
      seen
    )
    await safeFetch('https://api.example.com/a', {
      method: 'POST',
      body: 'x=1',
      allowedHosts: allowed,
      signal,
      transport: t
    })
    expect(seen[1]).toMatchObject({ method: 'GET', body: undefined })
  })

  it('stops after five redirects', async () => {
    const t = transport(() => res(302, { location: '/again' }))
    await expect(
      safeFetch('https://api.example.com/', { allowedHosts: allowed, signal, transport: t })
    ).rejects.toThrow(/Too many/)
  })

  it('drops headers plugins may not set', async () => {
    const seen: NetRequest[] = []
    await safeFetch('https://api.example.com/', {
      headers: { Host: 'internal', Cookie: 'a=b', 'X-Ok': '1' },
      allowedHosts: allowed,
      signal,
      transport: transport(() => res(200), seen)
    })
    expect(seen[0].headers).toEqual({ 'x-ok': '1' })
  })
})

describe('redact', () => {
  it('removes known secrets and token-shaped text', () => {
    const out = redact(
      'token abcdef123 and Bearer eyJhbGciOi.xyz and {"refresh_token":"r123456"}',
      ['abcdef123']
    )
    expect(out).not.toMatch(/abcdef123|eyJhbGciOi|r123456/)
  })
})
