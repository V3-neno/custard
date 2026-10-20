import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkAutomation, type Automation } from '../../shared/automations'
import { loadRuns } from './records'
import { Scheduler, type RunResult, type SchedulerReport } from './scheduler'

// The limits on all automations together (gate) and what the scheduler
// reports for notifications and the tray.

let dir: string
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'custard-report-'))))
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
    folders: [],
    plugins: [],
    enabled: true,
    ...over
  })
  if (!c.ok) throw new Error(c.problem)
  return c.automation
}

function setup(
  list: Automation[],
  opts: { result?: () => RunResult; gate?: (a: Automation) => string | null } = {}
): { s: Scheduler; ran: string[]; reports: SchedulerReport[]; at: (t: string) => void } {
  let clock = Date.parse('2026-03-01T07:59:00Z')
  const ran: string[] = []
  const reports: SchedulerReport[] = []
  const s = new Scheduler({
    dir,
    now: () => clock,
    list: () => list,
    run: async (a) => {
      ran.push(a.id)
      return opts.result?.() ?? { status: 'completed', calls: [], changes: [] }
    },
    gate: opts.gate,
    report: (e) => reports.push(e)
  })
  s.tick()
  return { s, ran, reports, at: (t) => (clock = Date.parse(t)) }
}

describe('gate', () => {
  it('skips a scheduled run with the gate’s reason, and reports it', async () => {
    const t = setup([make()], { gate: () => 'All automations together reached the limit.' })
    t.at('2026-03-01T08:00:10Z')
    t.s.tick()
    await t.s.idle()
    expect(t.ran).toEqual([])
    const r = loadRuns(dir, 'a1').runs[0]
    expect(r.status).toBe('skipped')
    expect(r.reason).toBe('All automations together reached the limit.')
    expect(t.reports).toMatchObject([{ type: 'skipped', cause: 'gate' }])
  })

  it('never gates Run now', async () => {
    const t = setup([make()], { gate: () => 'no' })
    t.s.runNow('a1')
    await t.s.idle()
    expect(t.ran).toEqual(['a1'])
  })

  it('asks the gate only after the automation’s own limit', async () => {
    let asked = 0
    const t = setup([make({ limits: { runsPerDay: 1 } })], {
      gate: () => {
        asked++
        return null
      }
    })
    t.at('2026-03-01T08:00:10Z')
    t.s.tick()
    await t.s.idle()
    t.at('2026-03-01T12:00:10Z')
    t.s.tick()
    await t.s.idle()
    expect(t.ran).toEqual(['a1'])
    expect(asked).toBe(1)
    expect(t.reports.map((r) => (r.type === 'skipped' ? r.cause : r.status))).toEqual([
      'completed',
      'limit'
    ])
  })
})

describe('reports', () => {
  it('reports how a run ended, with its questions', async () => {
    const t = setup([make()], {
      result: () => ({ status: 'completed', calls: [], changes: [], questions: ['q1', 'q2'] })
    })
    t.s.runNow('a1')
    await t.s.idle()
    expect(t.reports).toMatchObject([
      { type: 'ended', kind: 'manual', status: 'completed', paused: false, questions: 2 }
    ])
  })

  it('reports the run after which it paused itself', async () => {
    const t = setup([make({ limits: { failuresBeforePause: 2 } })], {
      result: () => ({ status: 'failed', reason: 'boom', calls: [], changes: [] })
    })
    t.at('2026-03-01T08:00:10Z')
    t.s.tick()
    await t.s.idle()
    t.at('2026-03-01T12:00:10Z')
    t.s.tick()
    await t.s.idle()
    expect(t.reports.map((r) => r.type === 'ended' && r.paused)).toEqual([false, true])
    expect(loadRuns(dir, 'a1').state.paused).toBeTruthy()
  })

  it('reports missed slots as missed', async () => {
    const t = setup([make({ limits: { catchUpRuns: 0 } })])
    t.at('2026-03-01T13:00:00Z')
    t.s.tick()
    await t.s.idle()
    expect(t.reports).toMatchObject([{ type: 'skipped', cause: 'missed' }])
  })
})
