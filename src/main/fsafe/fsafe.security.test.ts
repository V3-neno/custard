import {
  existsSync,
  lstatSync,
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
import { FsafeError, writeNew, writeReplace, type Guard } from '.'

// Finding D3 (docs/design/SECURITY-REVIEW.md): the link-swap race. These run
// on Linux with real symlinks. The races are simulated by swapping a folder
// for a link at the exact moment the file is opened. Windows (junctions, no
// O_NOFOLLOW) has not been run.

let base: string
let work: string
let secret: string

const guardOut: Guard = (real) =>
  real === secret || real.startsWith(secret + sep) ? 'protected' : null

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'custard-fsafe-'))
  work = join(base, 'work')
  secret = join(base, 'secret')
  mkdirSync(work)
  mkdirSync(secret)
})

afterEach(() => vi.restoreAllMocks())

describe('writeNew', () => {
  it('creates a new file and returns its real path', async () => {
    const p = await writeNew(join(work, 'a.html'), 'hi')
    expect(readFileSync(p, 'utf8')).toBe('hi')
  })

  it('refuses an existing name', async () => {
    writeFileSync(join(work, 'a.html'), 'old')
    await expect(writeNew(join(work, 'a.html'), 'new')).rejects.toBeInstanceOf(FsafeError)
    expect(readFileSync(join(work, 'a.html'), 'utf8')).toBe('old')
  })

  it('refuses a link at the final name, even a dangling one', async () => {
    symlinkSync(join(secret, 'x.md'), join(work, 'x.md'))
    await expect(writeNew(join(work, 'x.md'), 'evil')).rejects.toBeInstanceOf(FsafeError)
    expect(existsSync(join(secret, 'x.md'))).toBe(false)
  })

  it('asks the guard about the real location, so a linked folder is caught', async () => {
    symlinkSync(secret, join(work, 'linked'))
    await expect(
      writeNew(join(work, 'linked', 'x.md'), 'evil', { guard: guardOut })
    ).rejects.toThrow('protected')
    expect(readdirSync(secret)).toEqual([])
  })

  it('writes nothing into a folder swapped for a link after the check', async () => {
    const dir = join(work, 'out')
    mkdirSync(dir)
    const open = fsp.open.bind(fsp)
    vi.spyOn(fsp, 'open').mockImplementation((async (...args: Parameters<typeof fsp.open>) => {
      // The race: the checked folder becomes a link into the protected one.
      renameSync(dir, join(work, 'gone'))
      symlinkSync(secret, dir)
      return open(...args)
    }) as typeof fsp.open)
    await expect(writeNew(join(dir, 'x.md'), 'evil', { guard: guardOut })).rejects.toThrow(
      /folder changed/
    )
    // The empty file it opened was found through the link and removed.
    expect(readdirSync(secret)).toEqual([])
  })

  it('residual risk: a swap that is undone before the check can leave an EMPTY file', async () => {
    const dir = join(work, 'out')
    mkdirSync(dir)
    const open = fsp.open.bind(fsp)
    vi.spyOn(fsp, 'open').mockImplementation((async (...args: Parameters<typeof fsp.open>) => {
      renameSync(dir, join(work, 'gone'))
      symlinkSync(secret, dir)
      const fh = await open(...args)
      // Swapped back before Custard checks.
      renameSync(dir, join(work, 'link'))
      renameSync(join(work, 'gone'), dir)
      return fh
    }) as typeof fsp.open)
    await expect(writeNew(join(dir, 'x.md'), 'evil', { guard: guardOut })).rejects.toThrow(
      /folder changed/
    )
    // Detected and nothing written, but the stray file can't be found by
    // path any more, so it stays (empty).
    expect(readdirSync(secret)).toEqual(['x.md'])
    expect(readFileSync(join(secret, 'x.md'), 'utf8')).toBe('')
  })
})

describe('writeReplace', () => {
  it('replaces an existing file', async () => {
    writeFileSync(join(work, 'a.html'), 'old')
    await writeReplace(join(work, 'a.html'), 'new')
    expect(readFileSync(join(work, 'a.html'), 'utf8')).toBe('new')
    expect(readdirSync(work)).toEqual(['a.html'])
  })

  it('replaces a link at the target instead of writing through it', async () => {
    writeFileSync(join(secret, 'x.md'), 'keep')
    symlinkSync(join(secret, 'x.md'), join(work, 'x.md'))
    await writeReplace(join(work, 'x.md'), 'new')
    expect(readFileSync(join(secret, 'x.md'), 'utf8')).toBe('keep')
    expect(lstatSync(join(work, 'x.md')).isSymbolicLink()).toBe(false)
    expect(readFileSync(join(work, 'x.md'), 'utf8')).toBe('new')
  })

  it('refuses a protected real target', async () => {
    symlinkSync(secret, join(work, 'linked'))
    await expect(
      writeReplace(join(work, 'linked', 'x.md'), 'evil', { guard: guardOut })
    ).rejects.toThrow('protected')
    expect(readdirSync(secret)).toEqual([])
  })

  it('refuses a folder at the target', async () => {
    mkdirSync(join(work, 'd'))
    await expect(writeReplace(join(work, 'd'), 'x')).rejects.toBeInstanceOf(FsafeError)
  })
})
