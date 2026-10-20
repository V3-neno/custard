import { describe, expect, it } from 'vitest'
import { trayMenu, trayTooltip, withDot, type TrayState } from './trayMenu'

const idle: TrayState = { running: null, on: 2, paused: [], last: null }

describe('trayMenu', () => {
  it('says what is on and ends with Open and Quit', () => {
    const m = trayMenu(idle)
    expect(m[0]).toEqual({ kind: 'info', label: '2 automations on, none running' })
    expect(m.slice(-3).map((i) => i.kind)).toEqual(['separator', 'open', 'quit'])
    expect(trayMenu({ ...idle, on: 0 })[0]).toEqual({ kind: 'info', label: 'No automations on' })
  })

  it('names the running automation, the last run and what is paused', () => {
    const at = Date.parse('2026-03-01T08:05:00Z')
    const m = trayMenu({
      running: 'Listening',
      on: 1,
      paused: ['A', 'B', 'C', 'D'],
      last: { name: 'Daily log', status: 'failed', at }
    })
    const labels = m.flatMap((i) => (i.kind === 'separator' ? [] : [i.label]))
    expect(labels[0]).toBe('Running now: Listening')
    expect(labels[1]).toMatch(/^Last run: Daily log, failed at /)
    expect(labels).toContain('Paused: C')
    expect(labels).not.toContain('Paused: D')
    expect(labels).toContain('and 1 more paused')
    expect(trayTooltip({ ...idle, running: 'Listening' })).toBe('Custard · running Listening')
    expect(trayTooltip(idle)).toBe('Custard')
  })
})

describe('withDot', () => {
  it('paints the dot in the bottom-right corner only, without changing the input', () => {
    const size = 32
    const src = new Uint8Array(size * size * 4)
    const out = withDot(src, size)
    const px = (x: number, y: number): number[] =>
      Array.from(out.slice((y * size + x) * 4, (y * size + x) * 4 + 4))
    expect(px(2, 2)).toEqual([0, 0, 0, 0])
    expect(px(24, 24)).toEqual([0x3f, 0xae, 0xf5, 255])
    expect(src.every((b) => b === 0)).toBe(true)
  })
})
