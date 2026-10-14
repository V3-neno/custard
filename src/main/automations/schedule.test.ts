import { describe, expect, it } from 'vitest'
import { isoLocal, localDay, slotsBetween, zonedInstant } from './schedule'

const utc = (s: string): number => Date.parse(s)
const labels = (a: Parameters<typeof slotsBetween>[0], from: string, to: string): string[] =>
  slotsBetween(a, utc(from), utc(to)).map((s) => s.label)

describe('daily slots', () => {
  const a = { times: ['07:30', '19:00'], days: [], timezone: 'UTC' }
  it('finds the slots in a window, oldest first', () => {
    expect(labels(a, '2026-03-01T00:00:00Z', '2026-03-02T12:00:00Z')).toEqual([
      '2026-03-01T07:30',
      '2026-03-01T19:00',
      '2026-03-02T07:30'
    ])
  })
  it('excludes the start of the window and includes the end', () => {
    expect(labels(a, '2026-03-01T07:30:00Z', '2026-03-01T19:00:00Z')).toEqual(['2026-03-01T19:00'])
    expect(labels(a, '2026-03-01T07:29:59Z', '2026-03-01T07:30:00Z')).toEqual(['2026-03-01T07:30'])
  })
  it('gives each slot once however the window is cut', () => {
    const all = labels(a, '2026-03-01T00:00:00Z', '2026-03-04T00:00:00Z')
    const parts = [
      '2026-03-01T00:00:00Z',
      '2026-03-01T07:30:00Z',
      '2026-03-02T10:00:00Z',
      '2026-03-04T00:00:00Z'
    ]
    const joined = parts.slice(1).flatMap((to, i) => labels(a, parts[i], to))
    expect(joined).toEqual(all)
  })
  it('is empty for an empty or reversed window', () => {
    expect(labels(a, '2026-03-02T00:00:00Z', '2026-03-01T00:00:00Z')).toEqual([])
  })
})

describe('time zones and DST', () => {
  const ny = { times: ['07:30'], days: [], timezone: 'America/New_York' }
  it('keeps the local time across the spring change', () => {
    // NY: EST (UTC-5) until 2026-03-08 02:00, EDT (UTC-4) after.
    const s = slotsBetween(ny, utc('2026-03-06T00:00:00Z'), utc('2026-03-10T00:00:00Z'))
    expect(s.map((x) => new Date(x.instant).toISOString())).toEqual([
      '2026-03-06T12:30:00.000Z',
      '2026-03-07T12:30:00.000Z',
      '2026-03-08T11:30:00.000Z',
      '2026-03-09T11:30:00.000Z'
    ])
  })
  it('keeps the local time across the autumn change', () => {
    const s = slotsBetween(ny, utc('2026-10-30T00:00:00Z'), utc('2026-11-03T00:00:00Z'))
    expect(s.map((x) => new Date(x.instant).toISOString())).toEqual([
      '2026-10-30T11:30:00.000Z',
      '2026-10-31T11:30:00.000Z',
      '2026-11-01T12:30:00.000Z',
      '2026-11-02T12:30:00.000Z'
    ])
  })
  it('runs a time that does not exist when the jump ends, once', () => {
    const gap = { times: ['02:30'], days: [], timezone: 'America/New_York' }
    const s = slotsBetween(gap, utc('2026-03-07T00:00:00Z'), utc('2026-03-09T12:00:00Z'))
    expect(s.map((x) => x.label)).toEqual([
      '2026-03-07T02:30',
      '2026-03-08T02:30',
      '2026-03-09T02:30'
    ])
    // 02:30 does not exist on the 8th: the clocks go from 02:00 EST to 03:00 EDT
    // = 07:00Z, and that is when it runs. Not 03:30, the time the gap would
    // shift it to.
    expect(new Date(s[1].instant).toISOString()).toBe('2026-03-08T07:00:00.000Z')
    expect(s.map((x) => x.shifted)).toEqual([undefined, true, undefined])
  })
  it('a shifted time and the time it is shifted to are one run, in Europe/Stockholm', () => {
    // 2026-03-29: 02:00 CET becomes 03:00 CEST at 01:00Z.
    const win: [number, number] = [utc('2026-03-28T12:00:00Z'), utc('2026-03-29T12:00:00Z')]
    const at = (times: string[]): { label: string; at: string; shifted?: true }[] =>
      slotsBetween({ times, days: [], timezone: 'Europe/Stockholm' }, ...win).map((x) => ({
        label: x.label,
        at: new Date(x.instant).toISOString(),
        ...(x.shifted ? { shifted: true as const } : {})
      }))
    expect(at(['02:30'])).toEqual([
      { label: '2026-03-29T02:30', at: '2026-03-29T01:00:00.000Z', shifted: true }
    ])
    // 03:00 exists and is that same moment: one run, labelled by the time that exists.
    expect(at(['02:30', '03:00'])).toEqual([
      { label: '2026-03-29T03:00', at: '2026-03-29T01:00:00.000Z' }
    ])
    // 03:30 is half an hour later: two runs, as configured.
    expect(at(['02:30', '03:30'])).toEqual([
      { label: '2026-03-29T02:30', at: '2026-03-29T01:00:00.000Z', shifted: true },
      { label: '2026-03-29T03:30', at: '2026-03-29T01:30:00.000Z' }
    ])
    // Two times in the gap are one moment: the first label keeps it.
    expect(at(['02:15', '02:45'])).toEqual([
      { label: '2026-03-29T02:15', at: '2026-03-29T01:00:00.000Z', shifted: true }
    ])
  })
  it('finds the moment the clocks jump in a half-hour zone too', () => {
    // Lord Howe: 02:00 +10:30 becomes 02:30 +11:00 on 2026-10-04, a 30-minute gap.
    const lh = { times: ['02:15'], days: [], timezone: 'Australia/Lord_Howe' }
    const s = slotsBetween(lh, utc('2026-10-03T00:00:00Z'), utc('2026-10-05T00:00:00Z'))
    expect(s.map((x) => x.shifted)).toEqual([true, undefined])
    // 02:15 on the 4th does not exist; the jump is at 02:00 +10:30 = 15:30Z on the 3rd.
    expect(new Date(s[0].instant).toISOString()).toBe('2026-10-03T15:30:00.000Z')
  })
  it('runs a time that happens twice the first time only', () => {
    const twice = { times: ['01:30'], days: [], timezone: 'America/New_York' }
    const s = slotsBetween(twice, utc('2026-10-31T12:00:00Z'), utc('2026-11-02T12:00:00Z'))
    expect(s).toHaveLength(2)
    // First 01:30 on Nov 1 is EDT (UTC-4) = 05:30Z.
    expect(new Date(s[0].instant).toISOString()).toBe('2026-11-01T05:30:00.000Z')
  })
  it('works east of UTC where the local date is ahead', () => {
    const tokyo = { times: ['08:00'], days: [], timezone: 'Asia/Tokyo' }
    const s = slotsBetween(tokyo, utc('2026-05-01T00:00:00Z'), utc('2026-05-02T00:00:00Z'))
    // 08:00 on May 1 in Tokyo is April 30 23:00Z, before the window.
    expect(s.map((x) => x.label)).toEqual(['2026-05-02T08:00'])
    expect(new Date(s[0].instant).toISOString()).toBe('2026-05-01T23:00:00.000Z')
  })
  it('zonedInstant inverts the local reading', () => {
    expect(
      new Date(zonedInstant({ y: 2026, m: 7, d: 1, h: 9, mi: 0 }, 'Europe/Stockholm')).toISOString()
    ).toBe('2026-07-01T07:00:00.000Z')
  })
})

describe('days of the month', () => {
  it('runs only on the listed days', () => {
    const a = { times: ['09:00'], days: [1, 15], timezone: 'UTC' }
    expect(labels(a, '2026-04-01T00:00:00Z', '2026-05-02T00:00:00Z')).toEqual([
      '2026-04-01T09:00',
      '2026-04-15T09:00',
      '2026-05-01T09:00'
    ])
  })
  it('skips a day the month does not have', () => {
    const a = { times: ['09:00'], days: [31], timezone: 'UTC' }
    expect(labels(a, '2026-04-01T00:00:00Z', '2026-06-30T00:00:00Z')).toEqual(['2026-05-31T09:00'])
  })
  it('the day is the local day', () => {
    const a = { times: ['01:00'], days: [2], timezone: 'Asia/Tokyo' }
    expect(labels(a, '2026-05-01T00:00:00Z', '2026-05-31T00:00:00Z')).toEqual(['2026-05-02T01:00'])
  })
})

describe('localDay', () => {
  it('names the day in the zone', () => {
    expect(localDay(utc('2026-05-01T20:00:00Z'), 'Asia/Tokyo')).toBe('2026-05-02')
    expect(localDay(utc('2026-05-01T20:00:00Z'), 'UTC')).toBe('2026-05-01')
  })
})

describe('local times with their offset', () => {
  const at = (iso: string, tz: string): string => isoLocal(Date.parse(iso), tz)
  it('writes the offset in force at that instant, in half-hour and negative zones too', () => {
    expect(at('2026-03-01T08:00:00Z', 'UTC')).toBe('2026-03-01T08:00+00:00')
    expect(at('2026-07-01T08:00:00Z', 'Europe/Stockholm')).toBe('2026-07-01T10:00+02:00')
    expect(at('2026-01-01T08:00:00Z', 'Europe/Stockholm')).toBe('2026-01-01T09:00+01:00')
    expect(at('2026-01-01T08:00:00Z', 'Asia/Kolkata')).toBe('2026-01-01T13:30+05:30')
    expect(at('2026-01-01T08:00:00Z', 'America/St_Johns')).toBe('2026-01-01T04:30-03:30')
    expect(at('2026-07-01T08:00:00Z', 'America/St_Johns')).toBe('2026-07-01T05:30-02:30')
    expect(at('2026-01-01T08:00:00Z', 'Australia/Lord_Howe')).toBe('2026-01-01T19:00+11:00')
  })
  it('tells the two passes of a repeated hour apart', () => {
    // Stockholm goes back at 03:00 local on 2026-10-25: 02:30 happens twice.
    expect(at('2026-10-25T00:30:00Z', 'Europe/Stockholm')).toBe('2026-10-25T02:30+02:00')
    expect(at('2026-10-25T01:30:00Z', 'Europe/Stockholm')).toBe('2026-10-25T02:30+01:00')
  })
})
