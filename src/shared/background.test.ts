import { describe, expect, it } from 'vitest'
import { DEFAULT_BACKGROUND, normalizeBackground } from './background'

describe('normalizeBackground', () => {
  it('defaults: tray and login off, notifications on, 48 runs a day, budget stops runs', () => {
    expect(normalizeBackground(undefined)).toEqual(DEFAULT_BACKGROUND)
    expect(DEFAULT_BACKGROUND).toEqual({
      keepInTray: false,
      openAtLogin: false,
      notify: true,
      runsPerDayAll: 48,
      stopAtBudget: true
    })
  })

  it('starts at login only when kept in the tray', () => {
    expect(normalizeBackground({ openAtLogin: true }).openAtLogin).toBe(false)
    expect(normalizeBackground({ keepInTray: true, openAtLogin: true }).openAtLogin).toBe(true)
  })

  it('keeps the runs a day within 1-200, whole numbers only', () => {
    expect(normalizeBackground({ runsPerDayAll: 0 }).runsPerDayAll).toBe(1)
    expect(normalizeBackground({ runsPerDayAll: 5000 }).runsPerDayAll).toBe(200)
    expect(normalizeBackground({ runsPerDayAll: 2.5 }).runsPerDayAll).toBe(48)
    expect(normalizeBackground({ runsPerDayAll: '9' }).runsPerDayAll).toBe(48)
  })

  it('ignores values of the wrong type', () => {
    expect(normalizeBackground({ keepInTray: 'yes', notify: 0 })).toEqual(DEFAULT_BACKGROUND)
  })
})
