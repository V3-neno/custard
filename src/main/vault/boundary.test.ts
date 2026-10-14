import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import type { VaultGrant } from '../../shared/vaultGrants'
import { runVaultTool } from '../vault'
import { caseSensitiveVault, resolveInVault } from '../memory/paths'
import { createGranted } from './edit'

// The trust boundary of the folder grants: whatever spelling a path takes
// (case, separators, trailing dots, doubled slashes), the grant check, the
// protected places and the file system must all see the same folder.

let root: string
let vault: string
let records: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'custard-boundary-'))
  vault = join(root, 'vault')
  records = join(root, 'records')
  mkdirSync(vault)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const note = (path: string, text: string): void => {
  mkdirSync(dirname(join(vault, path)), { recursive: true })
  writeFileSync(join(vault, path), text)
}
const text = (path: string): string => readFileSync(join(vault, path), 'utf8')
const files = (dir = vault): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)).map((f) => `${e.name}/${f}`) : [e.name]
  )

const run = (
  grants: VaultGrant[],
  name: string,
  input: Record<string, unknown>
): ReturnType<typeof runVaultTool> =>
  runVaultTool(vault, name, input, () => null, { grants, recordsDir: records, source: 'test' })

// Protected places, as existing notes, and the grants that sit above them.
const PROTECTED = [
  'Custard/Memory.md',
  'Custard/Skills/s/SKILL.md',
  'Custard/Captures/a.md',
  'Custard/Plugins/spotify/Activity/a.md',
  'Custard/Plugins/spotify/Overview.md'
]
const PARENT_GRANTS: VaultGrant[][] = [
  [{ folder: 'Custard', mode: 'edit' }],
  [{ folder: 'Custard/Plugins', mode: 'edit' }],
  [{ folder: 'Custard/Plugins/spotify', mode: 'edit' }],
  [
    { folder: 'Custard', mode: 'create' },
    { folder: 'Custard/Plugins/spotify', mode: 'append' }
  ]
]

// The same note written every way a model, a file system or an attacker might.
const spellings = (p: string): string[] => {
  const [first, ...rest] = p.split('/')
  return [
    p,
    p.toLowerCase(),
    p.toUpperCase(),
    p.replace(/\//g, '\\'),
    `${first}\\${rest.join('/')}`,
    p.replace('/', '//'),
    `/${p}`,
    `./${p}`,
    `${first}/./${rest.join('/')}`,
    // Windows ignores trailing dots and spaces on a folder name.
    `${first}./${rest.join('/')}`,
    `${first} /${rest.join('/')}`,
    p.replace(/\//g, '\\').toLowerCase()
  ]
}

describe('protected places under every spelling and every parent grant', () => {
  beforeEach(() => {
    for (const p of PROTECTED) note(p, 'original\n')
    note('Elsewhere/keep.md', 'keep\n')
  })

  it('append and edit are refused, and nothing changes', async () => {
    const before = Object.fromEntries(PROTECTED.map((p) => [p, text(p)]))
    const names = files()
    for (const grants of PARENT_GRANTS)
      for (const target of PROTECTED)
        for (const path of spellings(target)) {
          const a = await run(grants, 'vault_append', { path, text: 'x' })
          expect(a.isError, `append ${JSON.stringify(path)}`).toBe(true)
          const e = await run(grants, 'vault_edit', {
            path,
            version: '000000000000',
            edits: [{ type: 'append', text: 'x' }]
          })
          expect(e.isError, `edit ${JSON.stringify(path)}`).toBe(true)
        }
    for (const p of PROTECTED) expect(text(p)).toBe(before[p])
    expect(files()).toEqual(names)
  })

  it('a new note there is not counted as granted, so chat asks first', () => {
    for (const grants of PARENT_GRANTS)
      for (const target of PROTECTED.filter((p) => !/(Memory|Overview)\.md$/.test(p))) {
        const fresh = target.replace(/[^/]+$/, 'new.md')
        for (const path of spellings(fresh))
          expect(createGranted(vault, path, grants), `create ${JSON.stringify(path)}`).toBe(false)
      }
    // Memory.md and Overview.md are notes, not folders: nothing is "inside" them, and
    // a new note beside Overview.md is not protected (only Overview.md itself is).
    for (const grants of PARENT_GRANTS)
      expect(createGranted(vault, 'Custard/Memory.md/x.md', grants)).toBe(false)
  })

  it('a grant that names the protected folder itself still works, in any spelling of the path', async () => {
    const own: VaultGrant[] = [{ folder: 'Custard/Captures', mode: 'append' }]
    for (const path of [
      'Custard/Captures/a.md',
      'Custard\\Captures\\a.md',
      'Custard//Captures/a.md',
      './Custard/Captures/a.md'
    ]) {
      const r = await run(own, 'vault_append', { path, text: 'x\n' })
      expect(r.isError, path).toBe(false)
    }
    expect(text('Custard/Captures/a.md').match(/x/g)).toHaveLength(4)
  })

  it('Overview.md and Activity are covered by no grant on Custard or Custard/Plugins', () => {
    for (const folder of ['Custard', 'Custard/Plugins', 'Custard/Plugins/spotify']) {
      const g: VaultGrant[] = [{ folder, mode: 'edit' }]
      expect(createGranted(vault, 'Custard/Plugins/spotify/Overview.md', g)).toBe(false)
      expect(createGranted(vault, 'Custard/Plugins/spotify/Activity/x.md', g)).toBe(false)
      expect(createGranted(vault, 'Custard/Plugins/spotify/Listening/x.md', g)).toBe(true)
    }
  })
})

describe('a backslash is a separator everywhere', () => {
  const G: VaultGrant[] = [{ folder: 'Custard/Plugins/Spotify/Listening', mode: 'edit' }]

  it('stays inside the granted folder, where the check said it was', async () => {
    const r = await run(G, 'vault_create_note', {
      path: 'Custard/Plugins/Spotify/Listening\\2027-01\\win.md',
      content: 'a\n'
    })
    expect(r.isError).toBe(false)
    expect(existsSync(join(vault, 'Custard/Plugins/Spotify/Listening/2027-01/win.md'))).toBe(true)
    // Nothing named with a backslash, and nothing one level up.
    expect(files().filter((f) => f.includes('\\'))).toEqual([])
    expect(files(join(vault, 'Custard/Plugins/Spotify'))).toEqual(['Listening/2027-01/win.md'])
  })

  it('cannot climb out of the granted folder', () => {
    const g: VaultGrant[] = [{ folder: 'Notes', mode: 'edit' }]
    for (const path of ['Notes\\..\\evil.md', 'Notes/..\\evil.md', 'Notes\\../evil.md'])
      expect(createGranted(vault, path, g), path).toBe(false)
    expect(createGranted(vault, 'Notes\\fine.md', g)).toBe(true)
  })

  it('resolves to the same file as the slash form', () => {
    note('Notes/a.md', 'x')
    expect(resolveInVault(vault, 'Notes\\a.md')).toBe(resolveInVault(vault, 'Notes/a.md'))
  })
})

describe('names the file system treats as the same, and one that does not', () => {
  it('refuses a folder or note name ending in a dot or a space, everywhere', () => {
    for (const p of ['Notes./a.md', 'Notes /a.md', 'Notes/a.md.', 'Notes/a. ', 'Notes\\sub.\\a.md'])
      expect(() => resolveInVault(vault, p), p).toThrow(/end in a dot or a space/)
    expect(() => resolveInVault(vault, 'Notes/a.b.md')).not.toThrow()
  })

  it('on a case-sensitive file system a grant covers only its own spelling', () => {
    note('Notes/a.md', 'x')
    if (!caseSensitiveVault(vault)) return
    const g: VaultGrant[] = [{ folder: 'Notes', mode: 'edit' }]
    expect(createGranted(vault, 'Notes/new.md', g)).toBe(true)
    expect(createGranted(vault, 'notes/new.md', g)).toBe(false)
    expect(createGranted(vault, 'NOTES/new.md', g)).toBe(false)
  })

  it('knows this file system is case-sensitive or not by trying it', () => {
    note('Notes/a.md', 'x')
    expect(caseSensitiveVault(vault)).toBe(process.platform === 'linux')
  })
})
