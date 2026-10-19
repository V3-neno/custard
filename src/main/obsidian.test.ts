import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { obsidianOpenUrl } from './obsidian'

describe('obsidianOpenUrl', () => {
  const root = mkdtempSync(join(tmpdir(), 'custard-obsidian-'))

  it('opens the Home note when the vault has one, with the path encoded', () => {
    const vault = join(root, 'Custard Brain & co')
    mkdirSync(vault)
    writeFileSync(join(vault, 'Home.md'), '# Home\n')
    const url = obsidianOpenUrl(vault)
    expect(url.startsWith('obsidian://open?path=')).toBe(true)
    expect(decodeURIComponent(url.slice('obsidian://open?path='.length))).toBe(
      join(vault, 'Home.md')
    )
    expect(url).not.toMatch(/[ &]/)
  })

  it('opens the folder itself when there is no Home note', () => {
    const vault = join(root, 'Other')
    mkdirSync(vault)
    expect(new URL(obsidianOpenUrl(vault)).searchParams.get('path')).toBe(vault)
  })
})
