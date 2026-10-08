import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  existsSync,
  symlinkSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { beforeEach, describe, expect, it } from 'vitest'
import { resolveInside } from './paths'
import { runFileTool, runReferenceTool } from './tools'

let base: string
let root: string
let outside: string

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'custard-ws-'))
  root = join(base, 'workspace')
  outside = join(base, 'outside')
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(outside)
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1\n')
  writeFileSync(join(outside, 'secret.txt'), 'top secret\n')
})

const b = (): { root: string; deny?: string[] } => ({ root })
const run = (name: string, input: unknown): { content: string; isError: boolean } =>
  runFileTool(b(), name, input)

describe('resolveInside', () => {
  it('resolves plain relative paths', () => {
    expect(resolveInside(b(), 'src/a.ts', { mustExist: true })).toBe(join(root, 'src', 'a.ts'))
    expect(resolveInside(b(), './src//a.ts')).toBe(join(root, 'src', 'a.ts'))
  })

  it.each([
    ['../outside/secret.txt'],
    ['src/../../outside/secret.txt'],
    ['..\\outside\\secret.txt'],
    ['/etc/passwd'],
    ['C:\\Windows\\win.ini'],
    ['\\\\server\\share\\x'],
    ['~/x'],
    ['src/a.ts:stream'],
    ['src/a.ts.'],
    ['a\0b']
  ])('refuses %j', (p) => {
    expect(() => resolveInside(b(), p)).toThrow()
  })

  it('refuses a symlink to a folder outside', () => {
    symlinkSync(outside, join(root, 'link'), 'dir')
    expect(() => resolveInside(b(), 'link/secret.txt')).toThrow(/link/i)
    expect(run('fs_read', { path: 'link/secret.txt' }).isError).toBe(true)
    expect(run('fs_write', { path: 'link/new.txt', content: 'x' }).isError).toBe(true)
    expect(existsSync(join(outside, 'new.txt'))).toBe(false)
  })

  it('refuses a symlinked file, even when it points inside', () => {
    symlinkSync(join(outside, 'secret.txt'), join(root, 'leak.txt'))
    symlinkSync(join(root, 'src', 'a.ts'), join(root, 'inner.ts'))
    expect(run('fs_read', { path: 'leak.txt' }).isError).toBe(true)
    expect(run('fs_read', { path: 'inner.ts' }).isError).toBe(true)
    expect(run('fs_write', { path: 'leak.txt', content: 'x' }).isError).toBe(true)
    expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('top secret\n')
  })

  it('refuses a symlinked workspace subfolder used as a parent for new files', () => {
    symlinkSync(outside, join(root, 'src', 'out'), 'dir')
    expect(run('fs_write', { path: 'src/out/deep/x.txt', content: 'x' }).isError).toBe(true)
    expect(existsSync(join(outside, 'deep'))).toBe(false)
  })

  it('refuses writing to a hard-linked file', () => {
    linkSync(join(outside, 'secret.txt'), join(root, 'hard.txt'))
    expect(run('fs_write', { path: 'hard.txt', content: 'changed' }).content).toMatch(/hard-linked/)
    expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('top secret\n')
  })

  it('refuses secret-looking files and VCS folders', () => {
    for (const p of [
      '.env',
      '.env.local',
      'certs/server.key',
      '.git/config',
      'node_modules/x/index.js'
    ])
      expect(() => resolveInside(b(), p)).toThrow(/off limits/)
  })

  it('refuses credential files and folders tools commonly keep in a project (L16)', () => {
    for (const p of [
      '.ssh/config',
      '.aws/credentials',
      '.npmrc',
      'sub/.netrc',
      '.docker/config.json',
      '.kube/config',
      '.gnupg/pubring.kbx',
      'id_rsa',
      'keys/id_ed25519.pub',
      'id_ecdsa',
      '.pypirc',
      '.git-credentials'
    ])
      expect(() => resolveInside(b(), p), p).toThrow(/off limits/)
    expect(resolveInside(b(), 'docs/ssh-setup.md')).toBe(join(root, 'docs', 'ssh-setup.md'))
  })

  it('refuses Windows short-name aliases, which could name a protected file (L22)', () => {
    for (const p of ['ENV~1', 'GIT~1/config', 'NODE_M~1/x.js', 'src/FILE~12.TXT'])
      expect(() => resolveInside(b(), p), p).toThrow(/short/)
    expect(resolveInside(b(), 'notes~draft.txt')).toBe(join(root, 'notes~draft.txt'))
  })

  it('refuses denied folders inside the root', () => {
    mkdirSync(join(root, 'core'))
    writeFileSync(join(root, 'core', 'main.ts'), 'x')
    const denied = { root, deny: [join(root, 'core')] }
    expect(() => resolveInside(denied, 'core/main.ts')).toThrow(/protected/)
    expect(runFileTool(denied, 'fs_search', { query: 'x' }).content).not.toMatch(/core/)
  })
})

describe('file tools', () => {
  it('creates, edits, renames and deletes inside the workspace', () => {
    expect(run('fs_write', { path: 'src/new/b.ts', content: 'b' }).content).toBe(
      'Created src/new/b.ts'
    )
    expect(run('fs_write', { path: 'src/new/b.ts', content: 'bb' }).content).toBe(
      'Updated src/new/b.ts'
    )
    expect(run('fs_rename', { from: 'src/new/b.ts', to: 'src/c.ts' }).isError).toBe(false)
    expect(readFileSync(join(root, 'src', 'c.ts'), 'utf8')).toBe('bb')
    expect(run('fs_rename', { from: 'src/c.ts', to: '../outside/c.ts' }).isError).toBe(true)
    expect(run('fs_delete', { path: 'src/c.ts' }).isError).toBe(false)
    expect(existsSync(join(root, 'src', 'c.ts'))).toBe(false)
  })

  it('does not delete folders, the root, or anything outside', () => {
    expect(run('fs_delete', { path: 'src' }).isError).toBe(true)
    expect(run('fs_delete', { path: '' }).isError).toBe(true)
    expect(run('fs_delete', { path: '../outside/secret.txt' }).isError).toBe(true)
    expect(existsSync(join(outside, 'secret.txt'))).toBe(true)
  })

  it('lists and searches without following links', () => {
    symlinkSync(outside, join(root, 'link'), 'dir')
    expect(run('fs_list', {}).content).toContain('link (link, not followed)')
    expect(run('fs_search', { query: 'secret' }).content).toBe('No files matched.')
    expect(run('fs_search', { query: 'const a' }).content).toContain('src/a.ts')
  })

  it('serves read-only reference roots', () => {
    const refs = { docs: join(root, 'src') }
    expect(runReferenceTool(refs, 'reference_list', {}).content).toBe('docs/')
    expect(runReferenceTool(refs, 'reference_read', { path: 'docs/a.ts' }).content).toContain(
      'const a'
    )
    expect(
      runReferenceTool(refs, 'reference_read', { path: 'docs/../../outside/secret.txt' }).isError
    ).toBe(true)
  })
})
