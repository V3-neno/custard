import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkAutomation, type Automation, type RunContext } from '../../shared/automations'
import { loadRuns, saveRuns } from './records'
import { GRACE_MS, Scheduler, type RunResult } from './scheduler'

let dir: string
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'custard-auto-'))))
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const make = (over: Record<string, unknown> = {}): Automation => {
  const c = checkAutomation({
    id: 'a1',
    name: 'Listening',
    skill: 'listening-log',
    model: 'claude-opus-5-5',
    times: ['08:00', '12:00'],
    days: [],
    timezone: 'UTC',
    folders: ['Notes'],
    plugins: [],
    enabled: true,
    ...over
  })
  if (!c.ok) throw new Error(c.problem)
  return c.automation
}
const T = (s: string): number => Date.parse(s)
const ok: RunResult = { status: 'completed', calls: [], changes: [] }

function setup(
  list: Automation[],
  start: string,
  result: () => RunResult = () => ok
): {
  s: Scheduler
  ran: { id: string; slot?: string }[]
  at: (t: string) => void
  adv: (ms: number) => void
} {
  let clock = T(start)
  const ran: { id: string; slot?: string }[] = []
  const s = new Scheduler({
    dir,
    now: () => clock,
    list: () => list,
    run: async (a, slot) => {
      ran.push({ id: a.id, slot })
      return result()
    }
  })
  return {
    s,
    ran,
    at: (t: string): void => {
      clock = T(t)
    },
    adv: (ms: number): void => {
      clock += ms
    }
  }
}

describe('firing', () => {
  it('fires once per slot, however often it looks', async () => {
    const t = setup([make()], '2026-03-01T07:59:00Z')
    t.s.tick() // first look: nothing before it counts
    t.at('2026-03-01T08:00:10Z')
    t.s.tick()
    t.s.tick()
    t.at('2026-03-01T08:00:40Z')
    t.s.tick()
    await t.s.idle()
    expect(t.ran).toEqual([{ id: 'a1', slot: '2026-03-01T08:00' }])
    t.at('2026-03-01T12:00:05Z')
    t.s.tick()
    await t.s.idle()
    expect(t.ran.map((r) => r.slot)).toEqual(['2026-03-01T08:00', '2026-03-01T12:00'])
  })
  it('a time the clocks jump over runs once, when they jump, and not twice with the time after it', async () => {
    // Europe/Stockholm 2026-03-29: 02:00 becomes 03:00 at 01:00Z.
    const a = make({ times: ['02:30', '03:30'], timezone: 'Europe/Stockholm' })
    const t = setup([a], '2026-03-29T00:30:00Z')
    t.s.tick()
    t.at('2026-03-29T01:00:10Z')
    t.s.tick()
    await t.s.idle()
    // 02:30 runs the moment the clocks jump, with the context saying so.
    expect(t.ran.map((r) => r.slot)).toEqual(['2026-03-29T02:30'])
    t.at('2026-03-29T01:30:10Z')
    t.s.tick()
    await t.s.idle()
    expect(t.ran.map((r) => r.slot)).toEqual(['2026-03-29T02:30', '2026-03-29T03:30'])
  })
  it('does not run slots from before it first saw the automation', async () => {
    const t = setup([make()], '2026-03-01T13:00:00Z')
    t.s.tick()
    await t.s.idle()
    expect(t.ran).toEqual([])
    expect(loadRuns(dir, 'a1').runs).toEqual([])
  })
  it('a paused or disabled automation does not run', async () => {
    const list = [make(), make({ id: 'a2', enabled: false })]
    const t = setup(list, '2026-03-01T07:59:00Z')
    t.s.tick()
    t.s.pause('a1')
    t.at('2026-03-01T08:00:10Z')
    t.s.tick()
    await t.s.idle()
    expect(t.ran).toEqual([])
  })
  it('resuming does not run what was missed while paused', async () => {
    const t = setup([make()], '2026-03-01T07:59:00Z')
    t.s.tick()
    t.s.pause('a1')
    t.at('2026-03-01T09:00:00Z')
    t.s.tick()
    t.s.resume('a1')
    t.at('2026-03-01T09:00:30Z')
    t.s.tick()
    await t.s.idle()
    expect(t.ran).toEqual([])
  })
  it('with catch-up off, records a missed slot and does not run it', async () => {
    const t = setup([make({ limits: { catchUpRuns: 0 } })], '2026-03-01T07:00:00Z')
    t.s.tick()
    t.at('2026-03-01T08:00:00Z')
    t.adv(GRACE_MS + 60_000)
    t.s.tick()
    await t.s.idle()
    expect(t.ran).toEqual([])
    const [r] = loadRuns(dir, 'a1').runs
    expect(r).toMatchObject({ status: 'skipped', slot: '2026-03-01T08:00' })
    expect(r.reason).toMatch(/catch-up is off/)
  })
  it('runs one at a time', async () => {
    let live = 0
    let most = 0
    const list = [make(), make({ id: 'a2' })]
    let clock = T('2026-03-01T07:59:00Z')
    const s = new Scheduler({
      dir,
      now: () => clock,
      list: () => list,
      run: async () => {
        live++
        most = Math.max(most, live)
        await new Promise((r) => setTimeout(r, 10))
        live--
        return ok
      }
    })
    s.tick()
    clock = T('2026-03-01T08:00:05Z')
    s.tick()
    await s.idle()
    expect(most).toBe(1)
    expect(loadRuns(dir, 'a1').runs).toHaveLength(1)
    expect(loadRuns(dir, 'a2').runs).toHaveLength(1)
  })
})

describe('limits and failures', () => {
  it('stops at the runs-per-day limit and records the skip', async () => {
    const a = make({ times: ['08:00', '09:00', '10:00'], limits: { runsPerDay: 2 } })
    const t = setup([a], '2026-03-01T07:59:00Z')
    t.s.tick()
    for (const at of ['08:00:05', '09:00:05', '10:00:05']) {
      t.at(`2026-03-01T${at}Z`)
      t.s.tick()
      await t.s.idle()
    }
    expect(t.ran).toHaveLength(2)
    const runs = loadRuns(dir, 'a1').runs
    expect(runs.filter((r) => r.status === 'skipped')).toHaveLength(1)
    expect(runs[0].reason).toMatch(/2 runs a day/)
    // The next day starts over.
    t.at('2026-03-02T08:00:05Z')
    t.s.tick()
    await t.s.idle()
    expect(t.ran).toHaveLength(3)
  })
  it('the limit is per automation', async () => {
    const list = [
      make({ limits: { runsPerDay: 1 } }),
      make({ id: 'a2', limits: { runsPerDay: 5 } })
    ]
    const t = setup(list, '2026-03-01T07:59:00Z')
    t.s.tick()
    for (const at of ['08:00:05', '12:00:05']) {
      t.at(`2026-03-01T${at}Z`)
      t.s.tick()
      await t.s.idle()
    }
    expect(t.ran.filter((r) => r.id === 'a1')).toHaveLength(1)
    expect(t.ran.filter((r) => r.id === 'a2')).toHaveLength(2)
  })
  it('pauses itself after failures in a row, and not before', async () => {
    const a = make({
      times: ['08:00', '09:00', '10:00', '11:00'],
      limits: { failuresBeforePause: 3 }
    })
    const t = setup([a], '2026-03-01T07:59:00Z', () => ({
      status: 'failed',
      reason: 'The provider is limiting requests.',
      calls: [],
      changes: []
    }))
    t.s.tick()
    for (const at of ['08:00:05', '09:00:05', '10:00:05', '11:00:05']) {
      t.at(`2026-03-01T${at}Z`)
      t.s.tick()
      await t.s.idle()
    }
    expect(t.ran).toHaveLength(3)
    const st = loadRuns(dir, 'a1').state
    expect(st.paused?.reason).toMatch(/Paused after 3 failed runs/)
    expect(st.paused?.reason).toMatch(/limiting requests/)
  })
  it('a success resets the count', async () => {
    let n = 0
    const a = make({
      times: ['08:00', '09:00', '10:00', '11:00'],
      limits: { failuresBeforePause: 2 }
    })
    const t = setup([a], '2026-03-01T07:59:00Z', () =>
      ++n === 2 ? ok : { status: 'failed', reason: 'x', calls: [], changes: [] }
    )
    t.s.tick()
    for (const at of ['08:00:05', '09:00:05', '10:00:05']) {
      t.at(`2026-03-01T${at}Z`)
      t.s.tick()
      await t.s.idle()
    }
    expect(loadRuns(dir, 'a1').state.paused).toBeUndefined()
    expect(loadRuns(dir, 'a1').state.failures).toBe(1)
  })
  it('a run that throws is recorded as failed', async () => {
    const list = [make()]
    let clock = T('2026-03-01T07:59:00Z')
    const s = new Scheduler({
      dir,
      now: () => clock,
      list: () => list,
      run: async () => {
        throw new Error('boom')
      }
    })
    s.tick()
    clock = T('2026-03-01T08:00:05Z')
    s.tick()
    await s.idle()
    expect(loadRuns(dir, 'a1').runs[0]).toMatchObject({ status: 'failed', reason: 'boom' })
  })
})

describe('Run now and closing', () => {
  it('Run now runs even when paused, and is not counted against the day', async () => {
    const t = setup([make({ limits: { runsPerDay: 1 } })], '2026-03-01T07:00:00Z')
    t.s.pause('a1')
    expect(t.s.runNow('a1')).toBe(true)
    await t.s.idle()
    expect(t.ran).toHaveLength(1)
    t.s.resume('a1')
    t.at('2026-03-01T08:00:05Z')
    t.s.tick() // first look after resume starts at resume time
    expect(loadRuns(dir, 'a1').runs[0].kind).toBe('manual')
  })
  it('refuses Run now for an unknown automation, and a second while one is queued', async () => {
    const t = setup([make()], '2026-03-01T07:00:00Z')
    expect(t.s.runNow('nope')).toBe(false)
    expect(t.s.runNow('a1')).toBe(true)
    expect(t.s.runNow('a1')).toBe(false)
    await t.s.idle()
  })
  it('a run cut off by closing is marked failed and not repeated', async () => {
    saveRuns(dir, 'a1', {
      state: { failures: 0, checkedUntil: T('2026-03-01T08:00:30Z') },
      runs: [
        {
          id: 'r1',
          automationId: 'a1',
          kind: 'scheduled',
          slot: '2026-03-01T08:00',
          startedAt: T('2026-03-01T08:00:01Z'),
          status: 'running',
          calls: [],
          changes: []
        }
      ]
    })
    const t = setup([make()], '2026-03-01T08:01:00Z')
    t.s.start(3_600_000)
    await t.s.idle()
    t.s.stop()
    expect(t.ran).toEqual([])
    const [r] = loadRuns(dir, 'a1').runs
    expect(r.status).toBe('failed')
    expect(r.reason).toMatch(/closed/)
  })
  // Automation thinking, Phase 2: the record says what the run started with.
  it('a run record keeps the model and effort the run started with', async () => {
    const list = [make({ effort: 'high' })]
    const t = setup(list, '2026-03-01T07:00:00Z')
    t.s.runNow('a1')
    await t.s.idle()
    // Changed after the run: the record still says what it ran with.
    list[0] = make({ model: 'gpt-6-astra', effort: 'low' })
    const [r] = loadRuns(dir, 'a1').runs
    expect([r.status, r.model, r.effort]).toEqual(['completed', 'claude-opus-5-5', 'high'])
  })
  it('with no effort set, the record has the model and no effort', async () => {
    const t = setup([make()], '2026-03-01T07:00:00Z')
    t.s.runNow('a1')
    await t.s.idle()
    const [r] = loadRuns(dir, 'a1').runs
    expect(r.model).toBe('claude-opus-5-5')
    expect('effort' in r).toBe(false)
  })
  it('records written before model and effort were kept still load as they were', () => {
    const old = {
      id: 'r0',
      automationId: 'a1',
      kind: 'scheduled' as const,
      slot: '2026-03-01T08:00',
      startedAt: 1,
      endedAt: 2,
      status: 'completed' as const,
      calls: [{ label: 'Listed the vault', outcome: 'completed' }],
      changes: [],
      summary: 'Done.'
    }
    saveRuns(dir, 'a1', { state: { failures: 0 }, runs: [old] })
    expect(loadRuns(dir, 'a1').runs).toEqual([old])
  })
  it('a deleted automation queued to run does not run', async () => {
    const list = [make()]
    const t = setup(list, '2026-03-01T07:00:00Z')
    t.s.runNow('a1')
    list.length = 0
    await t.s.idle()
    expect(t.ran).toEqual([])
  })
})

describe('checkAutomation', () => {
  const base = {
    id: 'a1',
    name: 'N',
    skill: 's',
    model: 'm',
    times: ['07:30'],
    days: [],
    folders: [],
    plugins: [],
    enabled: true
  }
  it('accepts a clean one and fills the limits', () => {
    const c = checkAutomation(base)
    expect(c.ok && c.automation.limits).toEqual({
      runsPerDay: 24,
      toolCalls: 30,
      minutes: 5,
      failuresBeforePause: 3,
      catchUpRuns: 3
    })
  })
  it('refuses what is wrong rather than repairing it', () => {
    for (const bad of [
      { ...base, name: ' ' },
      { ...base, times: [] },
      { ...base, times: ['7:30'] },
      { ...base, times: ['24:00'] },
      { ...base, days: [0] },
      { ...base, days: [32] },
      { ...base, timezone: 'Mars/Base' },
      { ...base, skill: '../x' },
      { ...base, skill: 'a/b' },
      { ...base, id: 'A B' }
    ])
      expect(checkAutomation(bad).ok).toBe(false)
  })
  it('keeps limits inside their bounds', () => {
    const c = checkAutomation({
      ...base,
      limits: { runsPerDay: 9999, toolCalls: -4, minutes: 'x' }
    })
    expect(c.ok && c.automation.limits).toMatchObject({ runsPerDay: 96, toolCalls: 1, minutes: 5 })
  })
  // Automation thinking, Phase 2: effort is kept only as one of the five
  // levels; anything else is dropped and the automation still loads.
  it('keeps a valid effort and drops any other value', () => {
    for (const e of ['low', 'medium', 'high', 'xhigh', 'max']) {
      const c = checkAutomation({ ...base, effort: e })
      expect(c.ok && c.automation.effort).toBe(e)
    }
    for (const e of ['High', 'none', 'fast', '', 3, null, true, { level: 'high' }]) {
      const c = checkAutomation({ ...base, effort: e })
      expect(c.ok).toBe(true)
      expect(c.ok && 'effort' in c.automation).toBe(false)
    }
    // None set (every automation saved before effort existed).
    const old = checkAutomation(base)
    expect(old.ok && 'effort' in old.automation).toBe(false)
  })
  it('sorts and dedupes times and days', () => {
    const c = checkAutomation({ ...base, times: ['19:00', '07:30', '19:00'], days: [15, 1, 15] })
    expect(c.ok && [c.automation.times, c.automation.days]).toEqual([
      ['07:30', '19:00'],
      [1, 15]
    ])
  })
})

describe('catch-up', () => {
  const four = { times: ['08:00', '09:00', '10:00', '11:00', '12:00', '13:00'] }
  it('runs a missed slot late, flagged, with its window', async () => {
    const ctxs: RunContext[] = []
    const list = [make()]
    let clock = T('2026-03-01T07:00:00Z')
    const s = new Scheduler({
      dir,
      now: () => clock,
      list: () => list,
      run: async (_a, _slot, _sig, ctx) => {
        ctxs.push(ctx)
        return ok
      }
    })
    s.tick()
    clock = T('2026-03-01T08:40:00Z')
    s.tick()
    await s.idle()
    expect(ctxs).toHaveLength(1)
    expect(ctxs[0]).toMatchObject({
      catch_up: true,
      scheduled_for: { local: '2026-03-01T08:00+00:00', utc: '2026-03-01T08:00:00Z' },
      window_start: { local: '2026-02-28T12:00+00:00', utc: '2026-02-28T12:00:00Z' },
      window_end: { local: '2026-03-01T08:00+00:00' },
      last_successful_run: null,
      missed_slots: [],
      time_zone: 'UTC'
    })
    expect(loadRuns(dir, 'a1').runs[0].catchUp).toBe(true)
  })
  it('runs the newest 3 oldest-first and folds the older ones, never dropping them', async () => {
    const ctxs: { slot?: string; ctx: RunContext }[] = []
    const list = [make(four)]
    let clock = T('2026-03-01T07:00:00Z')
    const s = new Scheduler({
      dir,
      now: () => clock,
      list: () => list,
      run: async (_a, slot, _sig, ctx) => {
        ctxs.push({ slot, ctx })
        return ok
      }
    })
    s.tick()
    clock = T('2026-03-01T13:30:00Z') // 08:00 to 13:00 all missed: six slots
    s.tick()
    await s.idle()
    expect(ctxs.map((c) => c.slot)).toEqual([
      '2026-03-01T11:00',
      '2026-03-01T12:00',
      '2026-03-01T13:00'
    ])
    expect(ctxs.every((c) => c.ctx.catch_up)).toBe(true)
    // The three older slots ride in the first run's context only.
    expect(ctxs[0].ctx.missed_slots.map((m) => m.local)).toEqual([
      '2026-03-01T08:00+00:00',
      '2026-03-01T09:00+00:00',
      '2026-03-01T10:00+00:00'
    ])
    expect(ctxs[1].ctx.missed_slots).toEqual([])
    expect(ctxs[2].ctx.missed_slots).toEqual([])
    expect(ctxs[1].ctx.window_start?.local).toBe('2026-03-01T11:00+00:00')
    const runs = loadRuns(dir, 'a1').runs
    const note = runs.find((r) => r.status === 'skipped')
    expect(note?.reason).toMatch(/3 older scheduled runs were missed and not run/)
    expect(note?.reason).toMatch(/2026-03-01T11:00/)
    // Nothing is looked at twice.
    clock = T('2026-03-01T13:31:00Z')
    s.tick()
    await s.idle()
    expect(ctxs).toHaveLength(3)
  })
  it('on-time slots are not catch-up, and the last success is carried', async () => {
    const ctxs: RunContext[] = []
    const list = [make()]
    let clock = T('2026-03-01T07:59:00Z')
    const s = new Scheduler({
      dir,
      now: () => clock,
      list: () => list,
      run: async (_a, _slot, _sig, ctx) => {
        ctxs.push(ctx)
        return ok
      }
    })
    s.tick()
    clock = T('2026-03-01T08:00:30Z')
    s.tick()
    await s.idle()
    clock = T('2026-03-01T12:00:30Z')
    s.tick()
    await s.idle()
    expect(ctxs.map((c) => c.catch_up)).toEqual([false, false])
    expect(ctxs[0].last_successful_run).toBeNull()
    expect(ctxs[1].last_successful_run).toMatchObject({ slot: '2026-03-01T08:00+00:00' })
    expect(ctxs[1].window_start?.local).toBe('2026-03-01T08:00+00:00')
  })
  it('the setting limits how many run, and counts against the daily limit', async () => {
    const t = setup(
      [make({ ...four, limits: { catchUpRuns: 2, runsPerDay: 1 } })],
      '2026-03-01T07:00:00Z'
    )
    t.s.tick()
    t.at('2026-03-01T13:30:00Z')
    t.s.tick()
    await t.s.idle()
    // Two were to run; the day limit let one through and noted the other.
    expect(t.ran.map((r) => r.slot)).toEqual(['2026-03-01T12:00'])
    const reasons = loadRuns(dir, 'a1').runs.map((r) => r.reason ?? '')
    expect(reasons.some((r) => /1 runs a day|limit of 1 runs a day/.test(r))).toBe(true)
    expect(reasons.some((r) => /older scheduled runs were missed/.test(r))).toBe(true)
  })
  it('opening Custard (start) catches up what was missed while it was closed', async () => {
    saveRuns(dir, 'a1', {
      state: { failures: 0, checkedUntil: T('2026-03-01T07:00:00Z') },
      runs: []
    })
    const t = setup([make()], '2026-03-01T12:30:00Z')
    t.s.start(3_600_000)
    await t.s.idle()
    t.s.stop()
    expect(t.ran.map((r) => r.slot)).toEqual(['2026-03-01T08:00', '2026-03-01T12:00'])
  })
  it('a disabled or paused automation catches up on nothing when it comes back', async () => {
    const t = setup([make()], '2026-03-01T07:00:00Z')
    t.s.tick()
    t.s.pause('a1')
    t.at('2026-03-01T13:00:00Z')
    t.s.tick()
    t.s.resume('a1')
    t.at('2026-03-01T13:00:30Z')
    t.s.tick()
    await t.s.idle()
    expect(t.ran).toEqual([])
  })
  it('lists at most 200 folded slots and counts the rest', async () => {
    const many = { times: ['08:00', '09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00'] }
    const ctxs: RunContext[] = []
    const list = [make({ ...many, limits: { catchUpRuns: 1 } })]
    let clock = T('2026-01-01T00:00:00Z')
    const s = new Scheduler({
      dir,
      now: () => clock,
      list: () => list,
      run: async (_a, _slot, _sig, ctx) => {
        ctxs.push(ctx)
        return ok
      }
    })
    s.tick()
    clock = T('2026-02-15T23:00:00Z') // 46 days x 8 slots
    s.tick()
    await s.idle()
    expect(ctxs).toHaveLength(1)
    expect(ctxs[0].missed_slots).toHaveLength(200)
    expect(ctxs[0].missed_slots_omitted).toBe(46 * 8 - 1 - 200)
  })
})
