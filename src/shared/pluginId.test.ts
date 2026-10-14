import { describe, expect, it } from 'vitest'
import { pluginIdFrom } from './plugins'

describe('pluginIdFrom', () => {
  it('makes a folder-safe id from a name', () => {
    expect(pluginIdFrom('SEO Check')).toBe('seo-check')
    expect(pluginIdFrom('  Spotify!! ')).toBe('spotify')
    expect(pluginIdFrom('Café Menü')).toBe('cafe-menu')
    expect(pluginIdFrom('3D Printer')).toBe('d-printer')
  })
  it('meets the manifest rule', () => {
    for (const n of ['x', 'A', 'a'.repeat(80), 'Hello — World', 'Q2 report 2026'])
      expect(pluginIdFrom(n)).toMatch(/^[a-z][a-z0-9-]{1,30}$/)
  })
  it('numbers an id that is taken', () => {
    expect(pluginIdFrom('Spotify', new Set(['spotify']))).toBe('spotify-2')
    expect(pluginIdFrom('Spotify', new Set(['spotify', 'spotify-2']))).toBe('spotify-3')
  })
  it('gives up on a name with nothing to use', () => {
    expect(pluginIdFrom('')).toBeNull()
    expect(pluginIdFrom('!!! 123')).toBeNull()
    expect(pluginIdFrom('日本語')).toBeNull()
  })
})
