import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  symlinkSync,
  writeFileSync,
  promises as fsp
} from 'fs'
import { tmpdir } from 'os'
import { join, sep } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FsafeError, writeNew, writeReplace, type Guard } from '../../../src/main/fsafe'

// Stabilization 4.2: fsafe (src/main/fsafe) on native Windows, with
// junctions, which any user can make (no Developer Mode or admin), and the
// path forms Windows accepts besides plain ones. The Linux versions of these
// checks are src/main/fsafe/fsafe.security.test.ts. Run on Windows only:
//   npx vitest run --config test/platform/vitest.platform.config.ts
// Each `it` states what Custard intends; a failure is a finding to report,
// not something to loosen. Results go in docs/design/PLATFORM-CHECKLIST.md.

const win = process.platform === 'win32'
let base: string
let work: string
let secret: string
const guardOut: Guard = (real) =>
  real.toLowerCase() === secret.toLowerCase() ||
  real.toLowerCase().startsWith(secret.toLowerCase() + sep)
    ? 'protected'
    : null
const junction = (target: string, at: string): void => symlinkSync(target, at, 'junction')
// File symlinks need Developer Mode or admin; those cases skip without it.
const canFileLink = (): boolean => {
  try {
    symlinkSync(join(secret, 'probe'), join(work, 'probe-link'), 'file')
    return true
  } catch {
    return false
  }
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'custard-fsafe-win-'))
  work = join(base, 'work')
  secret = join(base, 'secret')
  mkdirSync(work)
  mkdirSync(secret)
})
afterEach(() => vi.restoreAllMocks())

describe.skipIf(!win)('fsafe on Windows: junctions', () => {
  it('asks the guard about the real location through a junction', async () => {
    junction(secret, join(work, 'linked'))
    await expect(
      writeNew(join(work, 'linked', 'x.md'), 'evil', { guard: guardOut })
    ).rejects.toThrow('protected')
    expect(readdirSync(secret)).toEqual([])
  })

  it('writes nothing through a folder swapped for a junction after the check', async () => {
    const dir = join(work, 'out')
    mkdirSync(dir)
    const open = fsp.open.bind(fsp)
    vi.spyOn(fsp, 'open').mockImplementation((async (...args: Parameters<typeof fsp.open>) => {
      renameSync(dir, join(work, 'gone'))
      junction(secret, dir)
      return open(...args)
    }) as typeof fsp.open)
    await expect(writeNew(join(dir, 'x.md'), 'evil', { guard: guardOut })).rejects.toBeInstanceOf(
      FsafeError
    )
    // Content never lands; record whether an empty file was left behind.
    const left = readdirSync(secret)
    if (left.length) expect(readFileSync(join(secret, left[0]), 'utf8')).toBe('')
    console.log(`[4.2] swap to junction: left in protected folder: ${JSON.stringify(left)}`)
  })

  it('replace: a junction at the target name is refused, not written through', async () => {
    junction(secret, join(work, 'x.md'))
    await expect(writeReplace(join(work, 'x.md'), 'new')).rejects.toBeInstanceOf(Error)
    expect(readdirSync(secret)).toEqual([])
  })

  it('replace: a folder swapped for a junction before the rename writes nothing there', async () => {
    const dir = join(work, 'out')
    mkdirSync(dir)
    writeFileSync(join(dir, 'a.html'), 'old')
    const rename = fsp.rename.bind(fsp)
    vi.spyOn(fsp, 'rename').mockImplementation((async (...args: Parameters<typeof fsp.rename>) => {
      renameSync(dir, join(work, 'gone'))
      junction(secret, dir)
      return rename(...args)
    }) as typeof fsp.rename)
    await writeReplace(join(dir, 'a.html'), 'new', { guard: guardOut }).catch(() => undefined)
    expect(existsSync(join(secret, 'a.html'))).toBe(false)
  })

  it('records: mkdir -p through a junction (outside fsafe today)', () => {
    junction(secret, join(work, 'linked'))
    mkdirSync(join(work, 'linked', 'a', 'b'), { recursive: true })
    // Not a guarantee fsafe makes: this shows what parent creation does.
    console.log(`[4.2] mkdir -p through a junction created: ${JSON.stringify(readdirSync(secret))}`)
  })
})

describe.skipIf(!win)('fsafe on Windows: path forms', () => {
  it('a final-name file symlink is refused (Developer Mode only)', async (ctx) => {
    if (!canFileLink()) return ctx.skip()
    symlinkSync(join(secret, 'x.md'), join(work, 'x.md'), 'file')
    await expect(writeNew(join(work, 'x.md'), 'evil')).rejects.toBeInstanceOf(FsafeError)
    expect(existsSync(join(secret, 'x.md'))).toBe(false)
  })

  it('the guard sees through a different letter case', async () => {
    await expect(
      writeNew(join(secret.toUpperCase(), 'x.md'), 'evil', { guard: guardOut })
    ).rejects.toThrow('protected')
  })

  it('the guard sees through the \\\\?\\ prefix', async () => {
    await expect(
      writeNew(`\\\\?\\${join(secret, 'x.md')}`, 'evil', { guard: guardOut })
    ).rejects.toThrow()
    expect(readdirSync(secret)).toEqual([])
  })

  it('the guard sees through an 8.3 short name, where the volume has them', async () => {
    const long = join(base, 'a very long protected folder name')
    mkdirSync(long)
    const g: Guard = (r) => (r.toLowerCase().startsWith(long.toLowerCase()) ? 'protected' : null)
    const { execFileSync } = await import('child_process')
    const short = execFileSync('cmd', ['/c', `for %I in ("${long}") do @echo %~sI`])
      .toString()
      .trim()
    if (short.toLowerCase() === long.toLowerCase()) return
    await expect(writeNew(join(short, 'x.md'), 'evil', { guard: g })).rejects.toThrow('protected')
  })

  it('the guard sees through a \\\\localhost\\c$ administrative share path', async () => {
    const drive = secret.slice(0, 1)
    const unc = `\\\\localhost\\${drive}$${secret.slice(2)}`
    if (!existsSync(unc)) return
    await expect(writeNew(join(unc, 'x.md'), 'evil', { guard: guardOut })).rejects.toThrow()
    expect(readdirSync(secret)).toEqual([])
  })

  it('an alternate data stream name writes nowhere unexpected', async () => {
    writeFileSync(join(work, 'a.md'), 'keep')
    await writeNew(join(work, 'a.md:hidden'), 'evil').catch(() => undefined)
    expect(readFileSync(join(work, 'a.md'), 'utf8')).toBe('keep')
    console.log(`[4.2] after an ADS name: ${JSON.stringify(readdirSync(work))}`)
  })

  it('a trailing dot or space is not a second name for an existing file', async () => {
    writeFileSync(join(work, 'a.md'), 'keep')
    for (const n of ['a.md.', 'a.md ']) await writeNew(join(work, n), 'evil').catch(() => undefined)
    expect(readFileSync(join(work, 'a.md'), 'utf8')).toBe('keep')
  })

  it('reserved device names are not written', async () => {
    for (const n of ['CON', 'nul.md', 'COM1.txt'])
      await expect(writeNew(join(work, n), 'x')).rejects.toBeInstanceOf(Error)
  })
})

describe.skipIf(win)('fsafe Windows checks (not Windows)', () => {
  it('skipped: run on native Windows', () => expect(win).toBe(false))
})
