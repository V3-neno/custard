import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { beforeEach, describe, expect, it } from 'vitest'
import { lineDiff } from './diff'
import { FILE_WRITES, previewFileChange } from './tools'

// What the user approves before a Code-mode file change: the whole change,
// with paths checked exactly as the change itself checks them.

let root: string
let outside: string
beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'custard-preview-'))
  root = join(base, 'ws')
  outside = join(base, 'outside')
  mkdirSync(root)
  mkdirSync(outside)
  writeFileSync(join(root, 'a.txt'), 'one\ntwo\nthree\n')
})
const b = (): { root: string } => ({ root })

describe('file change previews', () => {
  it('covers every file-changing tool and nothing that only reads', () => {
    expect([...FILE_WRITES].sort()).toEqual(['fs_delete', 'fs_rename', 'fs_write'])
  })

  it('shows a new file in full, however long', () => {
    const content = `${'x'.repeat(3000)}\nTAIL`
    const p = previewFileChange(b(), 'fs_write', { path: 'new/file.txt', content })
    expect(p.label).toBe('Create new/file.txt')
    expect(p.detail.endsWith(content)).toBe(true)
    expect(existsSync(join(root, 'new'))).toBe(false)
  })

  it('shows a replaced file as a whole-file diff', () => {
    const p = previewFileChange(b(), 'fs_write', { path: 'a.txt', content: 'one\n2\nthree\n' })
    expect(p.label).toBe('Replace a.txt')
    expect(p.detail).toContain('  one\n- two\n+ 2\n  three')
  })

  it('names what is deleted or renamed', () => {
    expect(previewFileChange(b(), 'fs_delete', { path: 'a.txt' }).label).toBe('Delete a.txt')
    expect(previewFileChange(b(), 'fs_rename', { from: 'a.txt', to: 'b/c.txt' }).label).toBe(
      'Rename a.txt to b/c.txt'
    )
  })

  it('refuses before asking when the change would be refused anyway', () => {
    symlinkSync(outside, join(root, 'link'))
    expect(() => previewFileChange(b(), 'fs_write', { path: 'link/x.txt', content: 'x' })).toThrow(
      /links/
    )
    expect(() => previewFileChange(b(), 'fs_write', { path: '../x.txt', content: 'x' })).toThrow()
    expect(() => previewFileChange(b(), 'fs_delete', { path: 'missing.txt' })).toThrow()
    expect(() => previewFileChange(b(), 'fs_write', { path: '.env', content: 'x' })).toThrow()
  })
})

describe('lineDiff', () => {
  it('keeps every line of the new text', () => {
    const d = lineDiff('a\nb\nc', 'a\nx\nc\nd')
    expect(d).toBe('  a\n- b\n+ x\n  c\n+ d')
    expect(
      d
        .split('\n')
        .filter((l) => !l.startsWith('- '))
        .map((l) => l.slice(2))
    ).toEqual(['a', 'x', 'c', 'd'])
  })

  it('falls back to the full new text when too large to compare', () => {
    const big = Array.from({ length: 3000 }, (_, i) => `l${i}`).join('\n')
    const d = lineDiff(big, `${big}\nend`)
    expect(d).toMatch(/^\(Too large to compare/)
    expect(d.endsWith('+ end')).toBe(true)
  })
})
