import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import type { VaultGrant } from '../../shared/vaultGrants'
import { noteOutside, noteReadIsOutside, searchIsOutside } from './outside'

let root: string
let vault: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'custard-outside-'))
  vault = join(root, 'vault')
  mkdirSync(vault)
  for (const p of [
    'Inbox/clip.md',
    'Custard/Memory.md',
    'Custard/Skills/s/SKILL.md',
    'Custard/Captures/a.md',
    'Custard/Plugins/spotify/Activity/a.md',
    'Custard/Plugins/spotify/Overview.md',
    'Custard/Plugins/spotify/Listening/2026.md'
  ]) {
    mkdirSync(dirname(join(vault, p)), { recursive: true })
    writeFileSync(join(vault, p), 'x\n')
  }
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const listening: VaultGrant[] = [{ folder: 'Custard/Plugins/spotify/Listening', mode: 'edit' }]

describe('which note reads bring outside text', () => {
  it('a note anywhere in the vault does, even when it sits beside granted folders', () => {
    expect(noteReadIsOutside(vault, 'Inbox/clip.md', listening)).toBe(true)
    expect(noteReadIsOutside(vault, 'Inbox/clip.md', [])).toBe(true)
  })
  it('memory, skills and the plugin overview do not: someone wrote them on purpose', () => {
    for (const p of [
      'Custard/Memory.md',
      'Custard/Skills/s/SKILL.md',
      'Custard/Plugins/spotify/Overview.md'
    ])
      expect(noteReadIsOutside(vault, p, []), p).toBe(false)
  })
  it('captures and plugin activity do, even under a grant that names them', () => {
    const named: VaultGrant[] = [
      { folder: 'Custard/Captures', mode: 'edit' },
      { folder: 'Custard/Plugins/spotify/Activity', mode: 'edit' }
    ]
    for (const p of ['Custard/Captures/a.md', 'Custard/Plugins/spotify/Activity/a.md']) {
      expect(noteReadIsOutside(vault, p, []), p).toBe(true)
      expect(noteReadIsOutside(vault, p, named), p).toBe(true)
    }
  })
  it('a granted folder does not: it is where Custard and the user write on purpose', () => {
    expect(noteReadIsOutside(vault, 'Custard/Plugins/spotify/Listening/2026.md', listening)).toBe(
      false
    )
  })
  it('the path is read the way the vault reads it', () => {
    expect(noteReadIsOutside(vault, 'custard\\captures\\a.md', [])).toBe(true)
    expect(
      noteReadIsOutside(vault, 'Custard\\Plugins\\spotify\\Listening\\2026.md', listening)
    ).toBe(false)
  })
  it('a path the vault refuses brings nothing', () => {
    expect(noteReadIsOutside(vault, '../x.md', [])).toBe(false)
    expect(noteReadIsOutside(vault, undefined, [])).toBe(false)
  })
  it('a search counts when it found something', () => {
    expect(searchIsOutside('3 matches for "x" …')).toBe(true)
    expect(searchIsOutside('No notes matched "x".')).toBe(false)
    expect(searchIsOutside('There are 4 matches, so page 9 is past the end (last page: 1).')).toBe(
      false
    )
  })
  it('records why once', () => {
    const c = {} as never as { outside?: ('notes' | 'memory')[] }
    noteOutside(c as never, 'notes')
    noteOutside(c as never, 'notes')
    noteOutside(c as never, 'memory')
    expect(c.outside).toEqual(['notes', 'memory'])
  })
})
