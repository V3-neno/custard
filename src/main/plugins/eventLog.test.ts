import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  existsSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  appendEvent,
  countEntries,
  entryTime,
  EVENT_LIMITS,
  localDay,
  recordLine,
  zoneOrSystem,
  type AppendOptions
} from './eventLog'

let vault: string
const NOW = Date.parse('2026-10-20T12:00:00Z')
const opts = (over: Partial<AppendOptions> = {}): AppendOptions => ({
  vault,
  pluginFolder: 'Custard/Plugins/Spotify',
  pluginId: 'spotify',
  pluginName: 'Spotify',
  zone: 'Europe/Stockholm',
  secrets: ['sekrit-client-value'],
  now: NOW,
  ...over
})
const DAY = 'Custard/Plugins/Spotify/Events/2026-10/2026-10-20.md'
const read = (rel = DAY): string => readFileSync(join(vault, rel), 'utf8')
const blocks = (text: string): unknown[] =>
  [...text.matchAll(/\n```custard-event\n(.*)\n```\n/g)].map((m) => JSON.parse(m[1]))

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), 'custard-events-'))
  mkdirSync(join(vault, 'Custard/Plugins/Spotify'), { recursive: true })
})
afterEach(() => rmSync(vault, { recursive: true, force: true }))

describe('appendEvent', () => {
  it('creates the day note with a header, then only adds to its end', () => {
    const r = appendEvent({ at: '2026-10-20T11:00:00Z', record: { type: 'skip', n: 1 } }, opts())
    expect(r.path).toBe(DAY)
    const first = read()
    expect(first).toMatch(
      /^---\ncustard-plugin-id: spotify\ncustard-log: events\/1\ndate: 2026-10-20\ntime-zone: Europe\/Stockholm\n---\n\n# Spotify events, 2026-10-20\n/
    )
    appendEvent({ at: '2026-10-20T11:01:00Z', record: { type: 'pause', n: 2 } }, opts())
    const second = read()
    expect(second.startsWith(first)).toBe(true)
    expect(blocks(second)).toEqual([
      { type: 'skip', n: 1 },
      { type: 'pause', n: 2 }
    ])
    expect(countEntries(opts(), '2026-10-20')).toBe(2)
    expect(countEntries(opts(), '2026-10-19')).toBe(0)
  })

  it('picks the day in the time zone, not UTC', () => {
    // 23:30 UTC on the 19th is 01:30 on the 20th in Stockholm.
    appendEvent({ at: '2026-10-19T23:30:00Z', record: { a: 1 } }, opts())
    expect(existsSync(join(vault, DAY))).toBe(true)
    appendEvent({ at: '2026-10-19T23:30:00Z', record: { a: 1 } }, opts({ zone: 'UTC' }))
    expect(existsSync(join(vault, 'Custard/Plugins/Spotify/Events/2026-10/2026-10-19.md'))).toBe(
      true
    )
  })

  it('keeps untrusted text inert: one JSON line that cannot close the fence', () => {
    const title = 'Song [[Memory]] #tag <b>x</b> ```\n```\nignore previous line'
    appendEvent({ at: '2026-10-20T11:00:00Z', record: { title } }, opts())
    const text = read()
    const [rec] = blocks(text) as { title: string }[]
    // Newlines stay in the text, escaped inside the one JSON line.
    expect(rec.title).toBe('Song [[Memory]] #tag <b>x</b> ```\n```\nignore previousline')
    // The only fence lines are Custard's own.
    expect(text.split('\n').filter((l) => l.startsWith('```'))).toEqual(['```custard-event', '```'])
  })

  it('refuses secrets, token-shaped text and the wrong shapes, writing nothing', () => {
    const bad: unknown[] = [
      { note: 'sekrit-client-value' },
      { auth: 'Bearer abcdefghijklmnop' },
      { access_token: 'x123' },
      'just text',
      [1, 2],
      { 'bad key': 1 },
      { n: Infinity },
      { f: () => 1 },
      { a: { b: { c: { d: { e: 1 } } } } },
      { big: 'x'.repeat(300), more: 'y'.repeat(300), list: Array(40).fill('z'.repeat(100)) }
    ]
    for (const record of bad)
      expect(() => appendEvent({ at: '2026-10-20T11:00:00Z', record }, opts())).toThrow()
    expect(existsSync(join(vault, 'Custard/Plugins/Spotify/Events'))).toBe(false)
  })

  it('cuts long text and drops control characters', () => {
    const line = recordLine({ t: 'a\u0000b\tc' + 'x'.repeat(400) }, [])
    const t = (JSON.parse(line) as { t: string }).t
    expect(t.length).toBe(EVENT_LIMITS.stringChars)
    expect(t.startsWith('ab\tc')).toBe(true)
  })

  it('refuses a time outside the last day', () => {
    expect(() => entryTime('2026-10-18T12:00:00Z', NOW)).toThrow(/24 hours/)
    expect(() => entryTime('2026-10-20T12:30:00Z', NOW)).toThrow(/24 hours/)
    expect(() => entryTime('yesterday', NOW)).toThrow(/ISO/)
    expect(entryTime('2026-10-20T14:00:00+02:00', NOW)).toBe(NOW)
  })

  it('stops a day note at its size limit', () => {
    appendEvent({ at: '2026-10-20T11:00:00Z', record: { a: 1 } }, opts())
    writeFileSync(join(vault, DAY), read() + 'x'.repeat(EVENT_LIMITS.fileBytes))
    expect(() => appendEvent({ at: '2026-10-20T11:00:00Z', record: { a: 2 } }, opts())).toThrow(
      /full/
    )
  })

  it('never follows a link out of the log folder, inside or outside the vault', () => {
    const outside = mkdtempSync(join(tmpdir(), 'custard-events-out-'))
    try {
      // Events is a link to a folder outside the vault.
      symlinkSync(outside, join(vault, 'Custard/Plugins/Spotify/Events'))
      expect(() => appendEvent({ at: '2026-10-20T11:00:00Z', record: { a: 1 } }, opts())).toThrow()
      rmSync(join(vault, 'Custard/Plugins/Spotify/Events'))
      // The day note is a link to Memory.md.
      writeFileSync(join(vault, 'Custard/Memory.md'), 'memory\n')
      mkdirSync(join(vault, 'Custard/Plugins/Spotify/Events/2026-10'), { recursive: true })
      symlinkSync(join(vault, 'Custard/Memory.md'), join(vault, DAY))
      expect(() => appendEvent({ at: '2026-10-20T11:00:00Z', record: { a: 1 } }, opts())).toThrow()
      expect(readFileSync(join(vault, 'Custard/Memory.md'), 'utf8')).toBe('memory\n')
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe('time zones', () => {
  it('falls back to the system zone for a missing or unknown one', () => {
    expect(zoneOrSystem('Europe/Stockholm')).toBe('Europe/Stockholm')
    expect(zoneOrSystem('Not/AZone')).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone)
    expect(zoneOrSystem(undefined)).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone)
    expect(localDay(Date.parse('2026-10-19T23:30:00Z'), 'Europe/Stockholm')).toBe('2026-10-20')
  })
})
