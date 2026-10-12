import { describe, expect, it } from 'vitest'
import { isMode, modes } from './chat'

// L17: a mode sent by the renderer is checked before it picks prompts and tools.
describe('isMode', () => {
  it('accepts only the four modes', () => {
    expect(['chat', 'code', 'design', 'skills'].every(isMode)).toBe(true)
    for (const m of ['', 'Code', 'admin', '__proto__', 'toString', undefined, 1])
      expect(isMode(m)).toBe(false)
  })
})

describe('mode bar', () => {
  it('reads Chat, Design, Plugins, Skills; Plugins keeps the id code', () => {
    expect(modes.map((m) => m.label)).toEqual(['Chat', 'Design', 'Plugins', 'Skills'])
    expect(modes.map((m) => m.id)).toEqual(['chat', 'design', 'code', 'skills'])
  })
})
