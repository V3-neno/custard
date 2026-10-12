import { describe, expect, it } from 'vitest'
import { chatHasOutsideText, isOutsideTool } from './outsideText'

const act = (name: string, status: string): never =>
  ({ name, label: name, write: false, status, key: 'k' }) as never
const conv = (actions: Record<string, never>, continuedFrom?: string): never =>
  ({ actions, ...(continuedFrom ? { continuedFrom } : {}) }) as never

describe('outside text', () => {
  it('knows which tools bring outside text', () => {
    expect(isOutsideTool('web_search')).toBe(true)
    expect(isOutsideTool('web_read')).toBe(true)
    expect(isOutsideTool('spotify__search')).toBe(true)
    expect(isOutsideTool('vault_read')).toBe(false)
    expect(isOutsideTool('vault_edit')).toBe(false)
    expect(isOutsideTool('design_generate')).toBe(false)
  })
  it('is false for a chat with none', () => {
    expect(chatHasOutsideText(null)).toBe(false)
    expect(chatHasOutsideText(conv({}))).toBe(false)
    expect(chatHasOutsideText(conv({ a: act('vault_read', 'completed') }))).toBe(false)
  })
  it('is true once a web or plugin tool ran', () => {
    expect(chatHasOutsideText(conv({ a: act('web_read', 'completed') }))).toBe(true)
    expect(chatHasOutsideText(conv({ a: act('spotify__search', 'failed') }))).toBe(true)
    expect(chatHasOutsideText(conv({ a: act('web_read', 'unknown') }))).toBe(true)
  })
  it('ignores a call that never ran', () => {
    expect(chatHasOutsideText(conv({ a: act('web_read', 'not-run') }))).toBe(false)
    expect(chatHasOutsideText(conv({ a: act('web_read', 'pending') }))).toBe(false)
  })
  it('counts a continued chat, which carries earlier text', () => {
    expect(chatHasOutsideText(conv({}, 'c1'))).toBe(true)
  })
})
