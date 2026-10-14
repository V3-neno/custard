import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { beforeEach, describe, expect, it } from 'vitest'
import { isAtomicTemp } from '../fsafe'
import { readSources } from '../plugins/build'
import { runFileTool } from './tools'

let root: string
beforeEach(() => {
  root = join(mkdtempSync(join(tmpdir(), 'custard-tools-')), 'ws')
  mkdirSync(root)
})
const b = (): { root: string } => ({ root })
const write = (path: string, content: string): ReturnType<typeof runFileTool> =>
  runFileTool(b(), 'fs_write', { path, content })

describe('fs_write is atomic', () => {
  it('creates and replaces a file, and leaves nothing beside it', () => {
    expect(write('a/b.txt', 'one\n')).toMatchObject({ isError: false, content: 'Created a/b.txt' })
    expect(write('a/b.txt', 'two\n')).toMatchObject({ isError: false, content: 'Updated a/b.txt' })
    expect(readFileSync(join(root, 'a/b.txt'), 'utf8')).toBe('two\n')
    expect(readdirSync(join(root, 'a'))).toEqual(['b.txt'])
  })
  it('keeps the file mode of the file it replaces', () => {
    write('run.sh', '#!/bin/sh\n')
    chmodSync(join(root, 'run.sh'), 0o750)
    write('run.sh', '#!/bin/sh\necho hi\n')
    expect(statSync(join(root, 'run.sh')).mode & 0o777).toBe(0o750)
  })
  it('tells what went wrong in plain words when the target is a folder', () => {
    mkdirSync(join(root, 'dir'))
    const r = write('dir', 'x')
    expect(r.isError).toBe(true)
    expect(r.content).toBe('Not a file.')
  })
  it('knows the name of the temporary file an interrupted write leaves', () => {
    expect(isAtomicTemp('.index.ts.0123456789ab.tmp')).toBe(true)
    expect(isAtomicTemp('.a.txt.0123456789AB.tmp')).toBe(false)
    expect(isAtomicTemp('notes.tmp')).toBe(false)
    expect(isAtomicTemp('.env')).toBe(false)
  })
  it('a leftover temporary file is not listed, searched, or read as plugin source', () => {
    write('src/index.ts', 'export const needle = 1\n')
    writeFileSync(join(root, 'src/.index.ts.0123456789ab.tmp'), 'export const needle = HALF')
    writeFileSync(join(root, 'plugin.json'), '{}')
    expect(runFileTool(b(), 'fs_list', { path: 'src' }).content).toBe('index.ts')
    const found = runFileTool(b(), 'fs_search', { query: 'needle' }).content
    expect(found).toContain('src/index.ts')
    expect(found).not.toContain('.tmp')
    expect(readSources(root).map((f) => f.path)).toEqual(['plugin.json', 'src/index.ts'])
  })
})

describe('fs_search says when it stopped', () => {
  it('after 30 matches, with a note', () => {
    for (let i = 0; i < 40; i++) write(`f${String(i).padStart(2, '0')}.txt`, 'needle\n')
    const out = runFileTool(b(), 'fs_search', { query: 'needle' }).content
    expect(out.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(30)
    expect(out).toContain('[Stopped at 30 matches; there may be more. Narrow the search.]')
  })
  it('with fewer matches, no note', () => {
    write('one.txt', 'needle\n')
    expect(runFileTool(b(), 'fs_search', { query: 'needle' }).content).toBe('- one.txt: needle')
  })
  it('still says when nothing matched', () => {
    write('one.txt', 'hay\n')
    expect(runFileTool(b(), 'fs_search', { query: 'needle' }).content).toBe('No files matched.')
  })
})
