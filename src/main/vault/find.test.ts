import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { readPart, versionOf } from './read'

let root: string
let vault: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'custard-find-'))
  vault = join(root, 'vault')
  mkdirSync(vault)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const filler = (topic: string): string =>
  Array.from({ length: 80 }, (_, i) => `Line ${i} of notes about ${topic}, kept long enough.`).join(
    '\n\n'
  )
const long = [
  '# Garden plan',
  filler('soil and beds'),
  '## Budget',
  'The budget for the season is 4,000 kronor, most of it for seeds.',
  filler('tools to borrow')
].join('\n\n')

describe('vault_read with find', () => {
  it('returns the matching parts, the headings and the version to read on with', async () => {
    writeFileSync(join(vault, 'long.md'), long)
    const out = await readPart(vault, { path: 'long.md', find: 'season budget kronor' })
    expect(out).toContain('the parts matching "season budget kronor"')
    expect(out).toContain('4,000 kronor')
    expect(out).toContain('under "Garden plan > Budget"')
    expect(out).toContain('- Budget (offset ')
    expect(out).toContain(`version "${versionOf(long)}"`)
    expect(out.length).toBeLessThan(long.length / 2)
  })

  it('reads from the start, saying so, when nothing matches', async () => {
    writeFileSync(join(vault, 'long.md'), long)
    const out = await readPart(vault, { path: 'long.md', find: 'kubernetes' })
    expect(out.startsWith('[Nothing in long.md matched "kubernetes"; here is its start.]')).toBe(
      true
    )
    expect(out).toContain('# Garden plan')
  })

  it('is ignored with an offset, and for a short note', async () => {
    writeFileSync(join(vault, 'long.md'), long)
    const at = await readPart(vault, { path: 'long.md', offset: 0, find: 'budget' })
    expect(at.startsWith('[long.md · version')).toBe(true)
    writeFileSync(join(vault, 'short.md'), 'The budget is small.')
    const short = await readPart(vault, { path: 'short.md', find: 'budget' })
    expect(short).toContain('the whole note')
  })
})
