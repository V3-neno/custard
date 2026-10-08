import { describe, expect, it } from 'vitest'
import { validate } from './schema'

// L11: a manifest's `pattern` runs in the main process against model input.
// A pattern that backtracks without end must not freeze the app.

describe('schema patterns', () => {
  it('still checks ordinary patterns', () => {
    const s = { type: 'string' as const, pattern: '^spotify:track:[0-9A-Za-z]{22}$' }
    expect(validate(s, 'spotify:track:4uLU6hMCjMI75M1A2tKUQC')).toEqual([])
    expect(validate(s, 'spotify:track:x')).toEqual(['input has the wrong format'])
  })

  it('gives up on a catastrophic pattern quickly, refusing the value', () => {
    const s = { type: 'string' as const, pattern: '^(a+)+$' }
    const evil = `${'a'.repeat(40)}!`
    const t = Date.now()
    expect(validate(s, evil)).toEqual(["input's format couldn't be checked"])
    expect(Date.now() - t).toBeLessThan(1000)
    // Known to be slow now: later values are refused without running it again.
    const t2 = Date.now()
    expect(validate(s, evil)).toEqual(["input's format couldn't be checked"])
    expect(validate(s, 'aaa')).toEqual(["input's format couldn't be checked"])
    expect(Date.now() - t2).toBeLessThan(50)
  })
})
