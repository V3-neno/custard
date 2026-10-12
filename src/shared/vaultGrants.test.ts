import { describe, expect, it } from 'vitest'
import {
  anyGrantAllows,
  grantFor,
  modeAllows,
  normalizeGrants,
  protectedDepth
} from './vaultGrants'

const g = (folder: string, mode: 'create' | 'append' | 'edit' = 'edit'): never =>
  ({ folder, mode }) as never

describe('modes nest', () => {
  it('create < append < edit', () => {
    expect(modeAllows('edit', 'append')).toBe(true)
    expect(modeAllows('edit', 'create')).toBe(true)
    expect(modeAllows('append', 'create')).toBe(true)
    expect(modeAllows('append', 'edit')).toBe(false)
    expect(modeAllows('create', 'append')).toBe(false)
  })
  it('offers a tool only when some grant allows it', () => {
    expect(anyGrantAllows([], 'append')).toBe(false)
    expect(anyGrantAllows([g('A', 'create')], 'append')).toBe(false)
    expect(anyGrantAllows([g('A', 'append')], 'append')).toBe(true)
    expect(anyGrantAllows([g('A', 'append')], 'edit')).toBe(false)
  })
})

describe('normalizeGrants', () => {
  it('keeps clean entries and drops the rest', () => {
    const r = normalizeGrants([
      { folder: 'Projects/Notes/', mode: 'append' },
      { folder: '', mode: 'edit' },
      { folder: '..', mode: 'edit' },
      { folder: 'a/../b', mode: 'edit' },
      { folder: '.obsidian', mode: 'edit' },
      { folder: 'C:\\x', mode: 'edit' },
      { folder: 'OBSIDI~1', mode: 'edit' },
      { folder: 'ok', mode: 'delete' },
      { folder: 7, mode: 'edit' },
      null
    ])
    expect(r.grants).toEqual([{ folder: 'Projects/Notes', mode: 'append' }])
    expect(r.dropped).toBe(9)
  })
  it('keeps one entry per folder, the widest mode', () => {
    expect(
      normalizeGrants([
        { folder: 'A', mode: 'create' },
        { folder: 'a', mode: 'edit' },
        { folder: 'A', mode: 'append' }
      ]).grants
    ).toEqual([{ folder: 'a', mode: 'edit' }])
  })
  it('accepts nothing that is not a list', () => {
    expect(normalizeGrants(undefined).grants).toEqual([])
    expect(normalizeGrants({ folder: 'A', mode: 'edit' }).grants).toEqual([])
  })
})

describe('grantFor', () => {
  const grants = [g('Projects', 'append'), g('Projects/Open', 'edit')]
  it('finds the most specific folder', () => {
    expect(grantFor(grants, 'Projects/a.md')).toBe('append')
    expect(grantFor(grants, 'Projects/Open/deep/b.md')).toBe('edit')
  })
  it('does not cover notes outside, or a folder of a similar name', () => {
    expect(grantFor(grants, 'Other/a.md')).toBeNull()
    expect(grantFor(grants, 'Projects2/a.md')).toBeNull()
    expect(grantFor(grants, 'Projects')).toBeNull()
    expect(grantFor([], 'Projects/a.md')).toBeNull()
  })
  it('compares without case and without trailing dots', () => {
    expect(grantFor([g('projects')], 'PROJECTS/A.md')).toBe('edit')
    expect(grantFor([g('Projects')], 'Projects./a.md')).toBe('edit')
  })
})

describe('protected places', () => {
  it('knows which paths are protected', () => {
    expect(protectedDepth('Custard/Memory.md')).toBe(2)
    expect(protectedDepth('Custard/Skills/x/SKILL.md')).toBe(2)
    expect(protectedDepth('Custard/Captures/a.md')).toBe(2)
    expect(protectedDepth('Custard/Plugins/Spotify/Activity/a.md')).toBe(4)
    expect(protectedDepth('Custard/Plugins/Spotify/Listening/a.md')).toBe(0)
    expect(protectedDepth('Projects/a.md')).toBe(0)
  })
  it('a parent grant does not cover them', () => {
    for (const parent of ['Custard', 'Custard/Plugins', 'Custard/Plugins/Spotify']) {
      expect(grantFor([g(parent)], 'Custard/Skills/x/SKILL.md')).toBeNull()
      expect(grantFor([g(parent)], 'Custard/Captures/a.md')).toBeNull()
      expect(grantFor([g(parent)], 'Custard/Plugins/Spotify/Activity/a.md')).toBeNull()
    }
    expect(grantFor([g('Custard')], 'Custard/Memory.md')).toBeNull()
  })
  it('the same parent grant still covers what is not protected', () => {
    expect(grantFor([g('Custard/Plugins/Spotify')], 'Custard/Plugins/Spotify/Listening/a.md')).toBe(
      'edit'
    )
    expect(grantFor([g('Custard')], 'Custard/Plugins/Spotify/Overview.md')).toBe('edit')
  })
  it('an explicit grant on the protected folder covers it', () => {
    expect(grantFor([g('Custard/Captures', 'append')], 'Custard/Captures/a.md')).toBe('append')
    expect(
      grantFor([g('Custard/Plugins/Spotify/Activity')], 'Custard/Plugins/Spotify/Activity/a.md')
    ).toBe('edit')
  })
  it('Memory.md is a file, so no folder grant can name it', () => {
    expect(grantFor([g('Custard/Memory.md')], 'Custard/Memory.md')).toBeNull()
  })
  it('case and trailing dots do not get around it', () => {
    expect(grantFor([g('Custard')], 'custard/SKILLS./x/SKILL.md')).toBeNull()
  })
})
