import { describe, expect, it } from 'vitest'
import {
  anyGrantAllows,
  cleanFolderInput,
  folderKey,
  GRANT_MODES,
  grantFor,
  grantLabel,
  modeAllows,
  normalizeGrants,
  placeKind,
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
    expect(protectedDepth('Custard/Chats/a.md')).toBe(2)
    expect(protectedDepth('Custard/Plugins/Spotify/Activity/a.md')).toBe(4)
    expect(protectedDepth('Custard/Plugins/Spotify/Overview.md')).toBe(4)
    expect(protectedDepth('Custard/Plugins/Spotify/Listening/Overview.md')).toBe(0)
    expect(protectedDepth('Custard/Plugins/Spotify/Listening/a.md')).toBe(0)
    expect(protectedDepth('Projects/a.md')).toBe(0)
  })
  it('a parent grant does not cover them', () => {
    for (const parent of ['Custard', 'Custard/Plugins', 'Custard/Plugins/Spotify']) {
      expect(grantFor([g(parent)], 'Custard/Skills/x/SKILL.md')).toBeNull()
      expect(grantFor([g(parent)], 'Custard/Captures/a.md')).toBeNull()
      expect(grantFor([g(parent)], 'Custard/Chats/a.md')).toBeNull()
      expect(grantFor([g(parent)], 'Custard/Plugins/Spotify/Activity/a.md')).toBeNull()
    }
    expect(grantFor([g('Custard')], 'Custard/Memory.md')).toBeNull()
  })
  it('the same parent grant still covers what is not protected', () => {
    expect(grantFor([g('Custard/Plugins/Spotify')], 'Custard/Plugins/Spotify/Listening/a.md')).toBe(
      'edit'
    )
    expect(grantFor([g('Custard')], 'Custard/Plugins/Spotify/Listening/a.md')).toBe('edit')
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
    expect(grantFor([g('Custard')], 'custard/SKILLS./x/SKILL.md', true)).toBeNull()
    expect(grantFor([g('Custard')], 'CUSTARD/plugins/x/OVERVIEW.MD', true)).toBeNull()
  })
  it('no grant can cover Overview.md, which is a note, not a folder', () => {
    for (const f of [
      'Custard',
      'Custard/Plugins',
      'Custard/Plugins/Spotify',
      'Custard/Plugins/Spotify/Overview.md'
    ])
      expect(grantFor([g(f)], 'Custard/Plugins/Spotify/Overview.md')).toBeNull()
  })
})

describe('separators and case', () => {
  it('a backslash is not a separator in a vault path: it is part of a name', () => {
    expect(grantFor([g('Notes')], 'Notes\\evil.md')).toBeNull()
    expect(grantFor([g('Notes')], 'Notes/ok.md')).toBe('edit')
    expect(protectedDepth('Custard\\Skills\\x')).toBe(0)
  })
  it('where the file system folds case, a grant covers any spelling; where it does not, only its own', () => {
    expect(grantFor([g('Notes')], 'notes/a.md')).toBe('edit')
    expect(grantFor([g('Notes')], 'Notes./a.md')).toBe('edit')
    expect(grantFor([g('Notes')], 'notes/a.md', true)).toBeNull()
    expect(grantFor([g('Notes')], 'Notes./a.md', true)).toBeNull()
    expect(grantFor([g('Notes')], 'Notes/a.md', true)).toBe('edit')
  })
  it('placeKind says whose text a place holds', () => {
    expect(placeKind('Custard/Memory.md')).toBe('own')
    expect(placeKind('custard/skills/x/SKILL.md')).toBe('own')
    expect(placeKind('Custard/Captures/a.md')).toBe('derived')
    expect(placeKind('Custard/Chats/a.md')).toBe('derived')
    expect(placeKind('Custard/Plugins/Spotify/Activity/a.md')).toBe('derived')
    expect(placeKind('Custard/Plugins/Spotify/Overview.md')).toBe('own')
    expect(placeKind('Custard/Plugins/Spotify/Listening/a.md')).toBeNull()
    expect(placeKind('Projects/a.md')).toBeNull()
  })
})

describe('levels in Settings', () => {
  it('lists the levels from narrowest to widest, each help line saying what it includes', () => {
    expect(GRANT_MODES.map((m) => [m.id, m.label])).toEqual([
      ['create', 'New notes'],
      ['append', 'Add to end'],
      ['edit', 'Edit text']
    ])
    for (let i = 1; i < GRANT_MODES.length; i++)
      expect(modeAllows(GRANT_MODES[i].id, GRANT_MODES[i - 1].id)).toBe(true)
    expect(GRANT_MODES[2].help).toMatch(/adding to the end/)
    expect(GRANT_MODES[1].help).toMatch(/New notes/)
  })
  it('names a mode by its level', () => {
    expect(grantLabel('create')).toBe('New notes')
    expect(grantLabel('append')).toBe('Add to end')
    expect(grantLabel('edit')).toBe('Edit text')
  })
  it('an edit grant covers append and create on the same folder', () => {
    const grants = [g('Notes', 'edit')]
    const mode = grantFor(grants, 'Notes/a.md')
    expect(mode).toBe('edit')
    expect(modeAllows(mode!, 'append')).toBe(true)
    expect(modeAllows(mode!, 'create')).toBe(true)
    expect(anyGrantAllows(grants, 'append')).toBe(true)
  })
})

describe('folders typed in Settings', () => {
  it('compares folders the way the saved list does', () => {
    expect(folderKey('Notes.')).toBe(folderKey('notes'))
    expect(folderKey('Projects/Notes ')).toBe(folderKey('projects/notes'))
    expect(folderKey('Notes')).not.toBe(folderKey('Notes2'))
  })
  it('drops trailing dots and spaces from each name, and tidies separators', () => {
    expect(cleanFolderInput('Notes.')).toBe('Notes')
    expect(cleanFolderInput(' Projects. /Notes.. ')).toBe(' Projects/Notes')
    expect(cleanFolderInput('a\\b//c/')).toBe('a/b/c')
  })
  it('keeps "." and ".." as typed, so they are still refused', () => {
    expect(cleanFolderInput('../outside')).toBe('../outside')
    expect(cleanFolderInput('a/./b')).toBe('a/./b')
    expect(cleanFolderInput('...')).toBe('...')
    for (const f of ['../outside', 'a/./b', '...', '.hidden.'])
      expect(normalizeGrants([{ folder: cleanFolderInput(f), mode: 'edit' }]).grants).toEqual([])
  })
})

describe('old or bad stored values grant no more than before', () => {
  it('a mode that is not exactly create, append or edit grants nothing', () => {
    const r = normalizeGrants([
      { folder: 'A', mode: 'Edit' },
      { folder: 'B', mode: ['append', 'edit'] },
      { folder: 'C', mode: 'edit+append' },
      { folder: 'D', mode: { append: true, edit: true } },
      { folder: 'E' },
      { folder: 'F', mode: 2 }
    ])
    expect(r.grants).toEqual([])
    expect(r.dropped).toBe(6)
  })
  it('a stored "Notes." keeps its old reach: covered without case, not with it', () => {
    const grants = normalizeGrants([{ folder: 'Notes.', mode: 'edit' }]).grants
    expect(grants).toEqual([{ folder: 'Notes.', mode: 'edit' }])
    expect(grantFor(grants, 'Notes/a.md')).toBe('edit')
    expect(grantFor(grants, 'Notes/a.md', true)).toBeNull()
  })
})

describe('protected places, at every level', () => {
  const places = [
    'Custard/Memory.md',
    'Custard/Skills/x/SKILL.md',
    'Custard/Captures/c.md',
    'Custard/Chats/c.md',
    'Custard/Plugins/Spotify/Activity/a.md',
    'Custard/Plugins/Spotify/Overview.md'
  ]
  for (const mode of ['create', 'append', 'edit'] as const)
    it(`a parent grant at ${mode} covers none of them`, () => {
      for (const parent of ['Custard', 'Custard/Plugins', 'Custard/Plugins/Spotify'])
        for (const p of places) expect(grantFor([g(parent, mode)], p)).toBeNull()
    })
})
