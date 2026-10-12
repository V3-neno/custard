import { describe, expect, it } from 'vitest'
import { localDay, slotsBetween, zonedInstant } from './schedule'

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
    // 02:30 EST does not exist on the 8th; it is 03:30 EDT = 07:30Z.
    expect(new Date(s[1].instant).toISOString()).toBe('2026-03-08T07:30:00.000Z')
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
