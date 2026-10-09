import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  symlinkSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { join, sep } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FsafeError,
  FsafeExistsError,
  io,
  makeDirs,
  writeNew,
  writeNewSync,
  writeReplace,
  type Guard
} from '.'

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
    const open = io.open
    vi.spyOn(io, 'open').mockImplementation((...args) => {
      // The race: the checked folder becomes a link into the protected one.
      renameSync(dir, join(work, 'gone'))
      symlinkSync(secret, dir)
      return open(...args)
    })
    await expect(writeNew(join(dir, 'x.md'), 'evil', { guard: guardOut })).rejects.toThrow(
      /folder changed/
    )
    // The empty file it opened was found through the link and removed.
    expect(readdirSync(secret)).toEqual([])
  })

  // D3 / 2.3: the swap undone before Custard checks. The stray file can't be
  // found by path any more; on Linux the open handle still names it.
  const swapAndBack = (dir: string): void => {
    const open = io.open
    vi.spyOn(io, 'open').mockImplementation((...args) => {
      renameSync(dir, join(work, 'gone'))
      symlinkSync(secret, dir)
      const fd = open(...args)
      // Swapped back before Custard checks.
      renameSync(dir, join(work, 'link'))
      renameSync(join(work, 'gone'), dir)
      return fd
    })
  }

  it.runIf(process.platform === 'linux')(
    'a swap undone before the check: refused, and the empty stray file is removed (Linux)',
    async () => {
      const dir = join(work, 'out')
      mkdirSync(dir)
      swapAndBack(dir)
      await expect(writeNew(join(dir, 'x.md'), 'evil', { guard: guardOut })).rejects.toThrow(
        /folder changed/
      )
      expect(readdirSync(secret)).toEqual([])
      expect(readdirSync(dir)).toEqual([])
    }
  )

  it('residual risk off Linux: the same swap can leave an EMPTY file, never content', async () => {
    // Simulates a platform without /proc/self/fd.
    const real = process.platform
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    try {
      const dir = join(work, 'out')
      mkdirSync(dir)
      swapAndBack(dir)
      await expect(writeNew(join(dir, 'x.md'), 'evil', { guard: guardOut })).rejects.toThrow(
        /folder changed/
      )
      expect(readdirSync(secret)).toEqual(['x.md'])
      expect(readFileSync(join(secret, 'x.md'), 'utf8')).toBe('')
    } finally {
      Object.defineProperty(process, 'platform', { value: real })
    }
  })

  it('an existing name is reported as such (sync and async)', async () => {
    writeFileSync(join(work, 'a.md'), 'old')
    expect(() => writeNewSync(join(work, 'a.md'), 'new')).toThrow(FsafeExistsError)
    await expect(writeNew(join(work, 'a.md'), 'new')).rejects.toBeInstanceOf(FsafeExistsError)
  })

  it('refuses names that are paths', () => {
    expect(() => writeNewSync(join(work, '..'), 'x')).toThrow(FsafeError)
  })
})

describe('makeDirs (in place of mkdir -p)', () => {
  it('makes nested folders and returns the real deepest one', () => {
    const made = makeDirs(work, ['a', 'b', 'c'])
    expect(made).toBe(join(realpathSync(work), 'a', 'b', 'c'))
    expect(lstatSync(made).isDirectory()).toBe(true)
  })

  it('accepts existing folders', () => {
    mkdirSync(join(work, 'a'))
    expect(makeDirs(work, ['a', 'b'])).toBe(join(realpathSync(work), 'a', 'b'))
  })

  it('follows an existing link only where the guard allows its real target', () => {
    symlinkSync(secret, join(work, 'linked'))
    expect(() => makeDirs(work, ['linked', 'x'], { guard: guardOut })).toThrow('protected')
    expect(readdirSync(secret)).toEqual([])
    mkdirSync(join(base, 'fine'))
    symlinkSync(join(base, 'fine'), join(work, 'ok'))
    expect(makeDirs(work, ['ok', 'x'], { guard: guardOut })).toBe(
      join(realpathSync(base), 'fine', 'x')
    )
  })

  it('refuses a file where a folder should be', () => {
    writeFileSync(join(work, 'f'), '')
    expect(() => makeDirs(work, ['f', 'x'])).toThrow(/not a folder/)
  })

  it('a parent swapped for a link while folders are made: refused, nothing made inside', () => {
    mkdirSync(join(work, 'a'))
    const mkdir = io.mkdir
    vi.spyOn(io, 'mkdir').mockImplementation((p, mode) => {
      if (p.endsWith(`${sep}b`)) {
        renameSync(join(work, 'a'), join(work, 'gone'))
        symlinkSync(secret, join(work, 'a'))
      }
      return mkdir(p, mode)
    })
    expect(() => makeDirs(work, ['a', 'b', 'c'], { guard: guardOut })).toThrow(/folder changed/)
    // Residual: the empty folder "b" was made where the link pointed, but
    // nothing was made inside it.
    expect(readdirSync(secret)).toEqual(['b'])
    expect(readdirSync(join(secret, 'b'))).toEqual([])
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
