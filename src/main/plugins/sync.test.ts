import { describe, expect, it } from 'vitest'
import { BackgroundSync, FIRST_DELAY_MS, MAX_BACKOFF_MS, type SyncResult } from './sync'
import type { BackgroundSyncStat } from './host'

const MIN = 60_000

function setup(results: () => SyncResult = () => ({ ok: true })): {
  s: BackgroundSync
  calls: string[]
  stats: BackgroundSyncStat[]
  failed: string[]
  on: { id: string; name: string; everyMinutes: number }[]
  adv: (ms: number) => void
  begin: () => Promise<void>
} {
  let clock = Date.parse('2026-03-01T08:00:00Z')
  const calls: string[] = []
  const stats: BackgroundSyncStat[] = []
  const failed: string[] = []
  const on = [{ id: 'spotify', name: 'Spotify', everyMinutes: 30 }]
  const s = new BackgroundSync({
    now: () => clock,
    plugins: () => on,
    call: async (id) => {
      calls.push(id)
      return results()
    },
    stat: (_id, st) => stats.push(st),
    failed: (p) => failed.push(p.name),
    day: (t) => new Date(t).toISOString().slice(0, 10)
  })
  // The first look starts the clock; the first call is a minute later.
  const begin = async (): Promise<void> => {
    await s.tick()
    clock += FIRST_DELAY_MS
    await s.tick()
  }
  return { s, calls, stats, failed, on, adv: (ms) => (clock += ms), begin }
}

describe('BackgroundSync', () => {
  it('waits a minute, then calls every interval', async () => {
    const t = setup()
    await t.s.tick()
    expect(t.calls).toEqual([])
    t.adv(FIRST_DELAY_MS)
    await t.s.tick()
    await t.s.tick()
    expect(t.calls).toEqual(['spotify'])
    t.adv(29 * MIN)
    await t.s.tick()
    expect(t.calls).toHaveLength(1)
    t.adv(MIN)
    await t.s.tick()
    expect(t.calls).toHaveLength(2)
    expect(t.stats.at(-1)).toMatchObject({ ok: true, today: 2, error: null })
  })

  it('never calls more often than every 15 minutes', async () => {
    const t = setup()
    t.on[0].everyMinutes = 1
    await t.begin()
    t.adv(14 * MIN)
    await t.s.tick()
    expect(t.calls).toHaveLength(1)
    t.adv(MIN)
    await t.s.tick()
    expect(t.calls).toHaveLength(2)
  })

  it('backs off after failures, up to 6 hours, and tells the first failure once', async () => {
    const t = setup(() => ({ ok: false, error: 'Spotify said no' }))
    await t.begin()
    expect(t.failed).toEqual(['Spotify'])
    expect(t.stats.at(-1)).toMatchObject({ ok: false, error: 'Spotify said no' })
    // Second call only after 2 × 30 minutes.
    t.adv(59 * MIN)
    await t.s.tick()
    expect(t.calls).toHaveLength(1)
    t.adv(MIN)
    await t.s.tick()
    expect(t.calls).toHaveLength(2)
    expect(t.failed).toEqual(['Spotify'])
    for (let i = 0; i < 6; i++) {
      t.adv(MAX_BACKOFF_MS)
      await t.s.tick()
    }
    const before = t.calls.length
    t.adv(MAX_BACKOFF_MS - MIN)
    await t.s.tick()
    expect(t.calls).toHaveLength(before)
    t.adv(MIN)
    await t.s.tick()
    expect(t.calls).toHaveLength(before + 1)
  })

  it('stops at 96 calls a day, even if turned off and on', async () => {
    let clock = 0
    let calls = 0
    const on = [{ id: 'p', name: 'P', everyMinutes: 15 }]
    const s = new BackgroundSync({
      now: () => clock,
      plugins: () => on,
      call: async () => {
        calls++
        return { ok: true }
      },
      stat: () => {},
      // One long day.
      day: () => 'd'
    })
    for (let i = 0; i < 120; i++) {
      await s.tick()
      clock += 15 * MIN
      if (i === 50) {
        // Off and on again: a fresh schedule, the same count.
        const p = on.pop()!
        await s.tick()
        on.push(p)
      }
    }
    expect(calls).toBe(96)
  })

  it('a turned-off plugin is never called', async () => {
    const t = setup()
    t.on.length = 0
    t.adv(FIRST_DELAY_MS * 10)
    await t.s.tick()
    expect(t.calls).toEqual([])
  })

  it('a thrown call counts as a failure', async () => {
    const t = setup(() => {
      throw new Error('crashed')
    })
    await t.begin()
    expect(t.stats.at(-1)).toMatchObject({ ok: false, error: 'crashed' })
  })
})
