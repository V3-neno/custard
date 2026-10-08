import { describe, expect, it } from 'vitest'
import { isMode } from './chat'

// L17: a mode sent by the renderer is checked before it picks prompts and tools.
describe('isMode', () => {
  it('accepts only the four modes', () => {
    expect(['chat', 'code', 'design', 'skills'].every(isMode)).toBe(true)
    for (const m of ['', 'Code', 'admin', '__proto__', 'toString', undefined, 1])
      expect(isMode(m)).toBe(false)
  })
})
