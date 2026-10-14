import { afterEach, describe, expect, it, vi } from 'vitest'
import { registeredTests, runRegisteredTests, test } from './testing'

const registry = registeredTests() as unknown[]
afterEach(() => {
  registry.length = 0
  vi.useRealTimers()
})

describe('the sandbox test runner', () => {
  it('times each test and keeps going after a failure', async () => {
    test('one', () => {})
    test('two', () => {
      throw new Error('bad')
    })
    test('three', async () => {})
    const r = await runRegisteredTests()
    expect(r.map((x) => [x.name, x.ok])).toEqual([
      ['one', true],
      ['two', false],
      ['three', true]
    ])
    expect(r.every((x) => typeof x.ms === 'number')).toBe(true)
    expect(r[1].error).toBe('bad')
  })
  it('filters by name and reports the rest as skipped', async () => {
    test('Play works', () => {})
    test('pause works', () => {})
    const r = await runRegisteredTests('PLAY')
    expect(r).toEqual([
      { name: 'Play works', ok: true, ms: expect.any(Number) },
      { name: 'pause works', ok: true, skipped: true }
    ])
  })
  it('fails a test that never settles and still runs the next one', async () => {
    vi.useFakeTimers()
    test('hangs', () => new Promise(() => {}))
    test('after', () => {})
    const p = runRegisteredTests()
    await vi.advanceTimersByTimeAsync(10_001)
    const r = await p
    expect(r[0]).toMatchObject({
      name: 'hangs',
      ok: false,
      error: expect.stringMatching(/10 seconds/)
    })
    expect(r[1]).toMatchObject({ name: 'after', ok: true })
  })
  it('tells the host as each test starts and finishes, when the host listens', async () => {
    const lines: unknown[] = []
    const g = globalThis as { __custardEmit?: (s: string) => void }
    g.__custardEmit = (s) => lines.push(JSON.parse(s))
    try {
      test('first', () => {})
      test('second', () => {
        throw new Error('x')
      })
      await runRegisteredTests()
    } finally {
      delete g.__custardEmit
    }
    expect(lines).toEqual([
      { start: 'first' },
      { done: { name: 'first', ok: true, ms: expect.any(Number) } },
      { start: 'second' },
      { done: { name: 'second', ok: false, error: 'x', ms: expect.any(Number) } }
    ])
  })
})
