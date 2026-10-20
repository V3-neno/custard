import { describe, expect, it } from 'vitest'
import { gateReason } from './gate'

const s = { runsPerDayAll: 3, stopAtBudget: true }

describe('gateReason', () => {
  it('lets runs through under the limits', () => {
    expect(gateReason(s, 2, { cost: 1, budget: 10 })).toBeNull()
    expect(gateReason(s, 0, { cost: 50, budget: null })).toBeNull()
  })

  it('stops at the runs a day for all automations', () => {
    expect(gateReason(s, 3, { cost: 0, budget: null })).toBe(
      'All automations together reached the limit of 3 scheduled runs a day.'
    )
  })

  it('stops once the month reaches the budget, unless turned off', () => {
    expect(gateReason(s, 0, { cost: 10, budget: 10 })).toContain('reached your budget ($10.00)')
    expect(gateReason({ ...s, stopAtBudget: false }, 0, { cost: 99, budget: 10 })).toBeNull()
  })
})
