import { describe, expect, it } from 'vitest'
import { testReport } from './report'

const pass = (name: string, ms = 1): { name: string; ok: boolean; ms: number } => ({
  name,
  ok: true,
  ms
})

describe('what plugin_test tells the model', () => {
  it('does not say passed when no test ran', () => {
    const t = testReport({ ok: true, results: [] })
    expect(t).toMatch(/No tests ran/)
    expect(t).not.toMatch(/passed/)
  })
  it('lists failures first, with times, and counts them', () => {
    const t = testReport({
      ok: false,
      results: [pass('a', 5), { name: 'b', ok: false, error: 'nope', ms: 7 }]
    })
    expect(t.split('\n')[0]).toBe('1 of 2 checks failed.')
    expect(t.indexOf('FAIL: b [7 ms] (nope)')).toBeLessThan(t.indexOf('pass: a [5 ms]'))
  })
  it('marks a cut error and a cut list, and says what a filter skipped', () => {
    const many = Array.from({ length: 100 }, (_, i) => pass(`t${i}`))
    const t = testReport({
      ok: false,
      results: [{ name: 'x', ok: false, error: 'e'.repeat(1000) }, ...many],
      skipped: 3
    })
    expect(t).toMatch(/\[… 600 more characters left out …\]/)
    expect(t).toMatch(/\[… 21 more results left out …\]/)
    expect(t).toMatch(/3 tests did not match the filter/)
  })
  it('keeps what passed before a stop, with the reason', () => {
    const t = testReport({ ok: false, results: [pass('first')], error: 'The tests were stopped.' })
    expect(t).toMatch(/did not finish cleanly/)
    expect(t).toMatch(/pass: first/)
    expect(t).toMatch(/Error: The tests were stopped\./)
  })
})
