import { describe, expect, it } from 'vitest'
import { checkAutomation, type Automation } from '../../shared/automations'
import { NoticeGate, noticeFor } from './notices'
import type { SchedulerReport } from './scheduler'

const a = ((): Automation => {
  const c = checkAutomation({
    id: 'a1',
    name: 'Listening',
    skill: 's',
    model: 'claude-opus-5-5',
    times: ['08:00'],
    days: [],
    folders: [],
    plugins: [],
    enabled: true
  })
  if (!c.ok) throw new Error(c.problem)
  return c.automation
})()

const ended = (over: Partial<Extract<SchedulerReport, { type: 'ended' }>>): SchedulerReport => ({
  type: 'ended',
  automation: a,
  kind: 'scheduled',
  status: 'completed',
  paused: false,
  questions: 0,
  ...over
})
const skipped = (
  cause: 'missed' | 'limit' | 'gate',
  reason = 'Custard says.'
): SchedulerReport => ({
  type: 'skipped',
  automation: a,
  cause,
  reason
})

describe('noticeFor', () => {
  it('says nothing about a run that went fine or a missed slot', () => {
    expect(noticeFor(ended({}))).toBeNull()
    expect(noticeFor(skipped('missed'))).toBeNull()
  })

  it('tells failures, stops, pauses and questions by name only', () => {
    expect(noticeFor(ended({ status: 'failed' }))).toEqual({
      title: 'Automation failed',
      body: 'Listening failed. Details in Settings → Automations.'
    })
    expect(noticeFor(ended({ status: 'stopped' }))?.title).toBe('Automation stopped')
    expect(noticeFor(ended({ status: 'failed', paused: true }))?.body).toBe(
      'Listening failed 3 times in a row and paused itself. Details in Settings → Automations.'
    )
    expect(noticeFor(ended({ questions: 1 }))?.title).toBe('Automation has a question')
  })

  it('never carries a run’s own text', () => {
    // A failed run's reason can hold text from a note or plugin; the report
    // doesn't even carry it, and the notice is built from the name only.
    const n = noticeFor(ended({ status: 'failed' }))
    expect(JSON.stringify(n)).not.toContain('reason')
  })

  it('tells skips at a limit, with Custard’s own reason for the shared limits', () => {
    expect(noticeFor(skipped('limit'))?.body).toContain('its limit of runs a day')
    expect(noticeFor(skipped('gate', 'All automations together reached the limit.'))?.body).toBe(
      'Listening was skipped. All automations together reached the limit.'
    )
  })
})

describe('NoticeGate', () => {
  it('tells a skip once a day per automation and cause, failures every time', () => {
    let day = '2026-03-01'
    const g = new NoticeGate(() => day)
    expect(g.pass(skipped('limit'))).toBe(true)
    expect(g.pass(skipped('limit'))).toBe(false)
    expect(g.pass(skipped('gate'))).toBe(true)
    expect(g.pass(ended({ status: 'failed' }))).toBe(true)
    expect(g.pass(ended({ status: 'failed' }))).toBe(true)
    day = '2026-03-02'
    expect(g.pass(skipped('limit'))).toBe(true)
  })
})
