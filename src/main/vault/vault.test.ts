import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'fs'
import { promises as fsp } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import type { Conversation, VaultEdit, VaultRead } from '../../shared/chat'
import { TurnLog, type Call } from '../turn'
import {
  boundMemory,
  MEMORY_LIMITS,
  runVaultTool,
  vaultSystemPrompt,
  type VaultContext
} from '../vault'
import { fold, matchNote, parseQuery, search, searchVault, SEARCH_LIMITS, tagsOf } from './search'
import { addRange, READ_LIMITS, readPart, versionOf } from './read'
import { applyEdit, prepareEdit, shiftRanges, undoEdit, vaultKey, type EditDeps } from './edit'

let root: string
let vault: string
let history: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'custard-vault-'))
  vault = join(root, 'vault')
  history = join(root, 'app-data', 'vault-history')
  mkdirSync(vault)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const note = (path: string, text: string): void => {
  mkdirSync(dirname(join(vault, path)), { recursive: true })
  writeFileSync(join(vault, path), text)
}
const text = (path: string): string => readFileSync(join(vault, path), 'utf8')

// What the model would do: read, then edit, with the user saying yes.
function ctx(over: Partial<VaultContext> = {}): VaultContext & { asked: number } {
  const c = {
    reads: {} as Record<string, VaultRead>,
    edits: {} as Record<string, VaultEdit>,
    callId: 'tu_1',
    asked: 0,
    approveEdit: async () => {
      c.asked++
      return true
    },
    historyDir: history,
    ...over
  }
  return c
}

const run = (name: string, input: unknown, c: VaultContext): ReturnType<typeof runVaultTool> =>
  runVaultTool(vault, name, input, c)

// --- Search -------------------------------------------------------------------

describe('vault search', () => {
  it('parses words, phrases, folders and tags', () => {
    expect(
      parseQuery('Red "big  Fox" folder:"Area/Sub dir" path:Projects tag:#Music #work/deep 10:30')
    ).toEqual({
      terms: ['red', '10:30'],
      phrases: ['big fox'],
      folders: ['Area/Sub dir', 'Projects'],
      tags: ['music', 'work/deep']
    })
    expect(parseQuery('"solo"').terms).toEqual(['solo'])
  })

  it('ranks notes with every word above notes with some, and titles above text', async () => {
    note('a.md', 'apple only, apple apple apple')
    note('b.md', 'apple and banana')
    note('Banana apple.md', 'nothing else')
    note('c.md', 'banana alone')
    note('d.md', 'neither')
    const out = await search(vault, { query: 'apple banana' })
    const lines = out.split('\n').filter((l) => l.startsWith('- '))
    expect(lines.map((l) => l.split(' ')[1])).toEqual(['Banana', 'b.md', 'a.md', 'c.md'])
    expect(out).toMatch(/^4 notes matched apple banana \(2 with every term, listed first\)/)
    expect(lines[2]).toContain('(1 of 2 terms)')
    expect(lines[0]).not.toContain('terms)')
  })

  it('matches quoted phrases across spacing and line breaks, in order only', async () => {
    note('yes.md', 'the red\n  fox jumped')
    note('no.md', 'the fox was red')
    const r = await searchVault(vault, parseQuery('"red fox"'))
    expect(r.hits.map((h) => h.path)).toEqual(['yes.md'])
  })

  it('filters by folder, including quoted names with spaces, and refuses folders outside', async () => {
    note('Area/Sub dir/one.md', 'plan')
    note('Area/two.md', 'plan')
    note('three.md', 'plan')
    expect(
      (await searchVault(vault, parseQuery('plan folder:"Area/Sub dir"'))).hits.map((h) => h.path)
    ).toEqual(['Area/Sub dir/one.md'])
    expect((await searchVault(vault, parseQuery('plan folder:Area'))).total).toBe(2)
    const c = ctx()
    const out = await run('vault_search', { query: 'plan folder:../..' }, c)
    expect(out).toMatchObject({ isError: true, content: 'Path is outside the vault.' })
  })

  it('filters by frontmatter and inline tags, with nested tags', async () => {
    note('a.md', '---\ntags: [music, work]\n---\nsong')
    note('b.md', '---\ntags:\n  - "#Music/Jazz"\n---\nsong')
    note('c.md', 'a #music note about a song')
    note('d.md', 'song without tags, # heading not a tag, issue#music no')
    expect(tagsOf('---\ntag: one, two\n---\n#three and #4 #x4')).toEqual(
      new Set(['one', 'two', 'three', 'x4'])
    )
    const r = await searchVault(vault, parseQuery('song tag:music'))
    expect(r.hits.map((h) => h.path).sort()).toEqual(['a.md', 'b.md', 'c.md'])
    expect((await searchVault(vault, parseQuery('#music/jazz'))).hits.map((h) => h.path)).toEqual([
      'b.md'
    ])
  })

  it('ignores accents and case both ways, and quotes the note as written', async () => {
    note('Café.md', 'Crème BRÛLÉE at the café')
    note('plain.md', 'creme brulee at the cafe')
    expect(fold('Ångström Ça')).toBe('angstrom ca')
    const r = await searchVault(vault, parseQuery('CAFÉ "creme brulee"'))
    expect(r.hits.map((h) => h.path).sort()).toEqual(['Café.md', 'plain.md'])
    const hit = r.hits.find((h) => h.path === 'Café.md')!
    expect(hit.all).toBe(true)
    expect(hit.snippets.join(' ')).toContain('Crème BRÛLÉE')
  })

  it('pages results with totals and says what comes next', async () => {
    for (let i = 0; i < 45; i++) note(`n${String(i).padStart(2, '0')}.md`, 'term')
    const p1 = await search(vault, { query: 'term' })
    expect(p1).toMatch(
      /^45 notes matched term\. Showing 1–20; for more, search again with page 2\./
    )
    const p3 = await search(vault, { query: 'term', page: 3 })
    expect(p3).toMatch(/Showing 41–45\./)
    expect(p3.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(5)
    expect(await search(vault, { query: 'term', page: 4 })).toMatch(
      /page 4 is past the end \(last page: 3\)/
    )
  })

  it('keeps snippets short and at most two per note', () => {
    const long = `${'lorem ipsum '.repeat(100)}needle ${'dolor sit '.repeat(100)}needle ${'amet '.repeat(100)}other ${'x '.repeat(100)}third`
    const hit = matchNote('n.md', long, parseQuery('needle other third'))!
    expect(hit.snippets).toHaveLength(SEARCH_LIMITS.snippets)
    for (const s of hit.snippets)
      expect(s.length).toBeLessThanOrEqual(SEARCH_LIMITS.snippetChars + 2)
    expect(hit.snippets[0]).toMatch(/^….*needle.*…$/)
  })

  it('never follows links, into or out of the vault', async () => {
    const outside = join(root, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'secret.md'), 'secret')
    symlinkSync(outside, join(vault, 'linked'))
    symlinkSync(join(outside, 'secret.md'), join(vault, 'file.md'))
    note('.hidden/h.md', 'secret')
    note('ok.md', 'secret')
    const r = await searchVault(vault, parseQuery('secret'))
    expect(r.hits.map((h) => h.path)).toEqual(['ok.md'])
  })

  it('stays responsive on a 5,000-note vault and reads a bounded number at once', async () => {
    for (let i = 0; i < 5000; i++)
      note(
        `f${i % 50}/n${i}.md`,
        i % 100 === 0 ? `alpha beta ${i}` : `filler text ${i} ${'z '.repeat(50)}`
      )
    let inFlight = 0
    let most = 0
    const readFile = async (p: string): Promise<string> => {
      inFlight++
      most = Math.max(most, inFlight)
      try {
        return await fsp.readFile(p, 'utf8')
      } finally {
        inFlight--
      }
    }
    // The longest the event loop goes without running a timer.
    let last = performance.now()
    let worst = 0
    const timer = setInterval(() => {
      const t = performance.now()
      worst = Math.max(worst, t - last)
      last = t
    }, 5)
    const r = await searchVault(vault, parseQuery('alpha beta'), { readFile })
    clearInterval(timer)
    expect(r.searched).toBe(5000)
    expect(r.total).toBe(50)
    expect(r.stopped).toBeNull()
    expect(most).toBeLessThanOrEqual(SEARCH_LIMITS.concurrency)
    expect(most).toBeGreaterThan(1)
    expect(worst).toBeLessThan(250)
  }, 60_000)

  it('stops at the time limit and says the results are partial', async () => {
    for (let i = 0; i < 30; i++) note(`n${i}.md`, 'word')
    let t = 0
    const out = await search(vault, { query: 'word' }, { now: () => (t += 500) })
    expect(out).toMatch(
      /Search stopped after 5 seconds \(\d+ notes searched\), so there may be more matches/
    )
  })

  it('skips notes too large to search and says so', async () => {
    note('big.md', 'word')
    note('small.md', 'word')
    const out = await search(
      vault,
      { query: 'word' },
      {
        size: async (p) => (p.endsWith('big.md') ? SEARCH_LIMITS.maxFileBytes + 1 : 10)
      }
    )
    expect(out).toContain('1 note was over 2 MB and not searched.')
    expect(out).toContain('- small.md')
    expect(out).not.toContain('- big.md')
  })
})

// --- Reading in parts ----------------------------------------------------------

describe('vault read', () => {
  const lines = (count: number): string =>
    Array.from({ length: count }, (_, i) => `line ${i} ${'x'.repeat(90)}`).join('\n') + '\n'

  it('reads a long note in parts cut at line breaks, with version and what follows', async () => {
    const body = lines(1000)
    note('long.md', body)
    const reads: Record<string, VaultRead> = {}
    let offset = 0
    let version: string | undefined
    let got = ''
    for (let i = 0; i < 10 && offset < body.length; i++) {
      const out = await readPart(vault, { path: 'long.md', offset, version }, reads)
      const [head, ...rest] = out.split('\n')
      expect(head).toMatch(new RegExp(`^\\[long\\.md · version ${versionOf(body)} · characters `))
      const next = /offset (\d+) and version "(\w+)"/.exec(out)
      const part = next ? rest.join('\n').replace(/\n\[Part ends at[^\n]*\]$/, '') : rest.join('\n')
      if (next) {
        expect(head).toContain('more follows')
        expect(part.endsWith('\n')).toBe(true)
        expect(part.length).toBeLessThanOrEqual(READ_LIMITS.part)
        offset = Number(next[1])
        version = next[2]
      } else {
        expect(head).toContain('end of note')
        offset = body.length
      }
      got += part
    }
    expect(got).toBe(body)
    expect(reads['long.md']).toMatchObject({ version: versionOf(body), ranges: [[0, body.length]] })
  })

  it('says when a short note is complete', async () => {
    note('s.md', 'short')
    expect(await readPart(vault, { path: 's.md' }, {})).toBe(
      `[s.md · version ${versionOf('short')} · the whole note, 5 characters]\nshort`
    )
  })

  it('reports a change between parts and drops the stale read', async () => {
    note('long.md', lines(1000))
    const c = ctx()
    const first = await run('vault_read', { path: 'long.md' }, c)
    const [, off, ver] = /offset (\d+) and version "(\w+)"/.exec(first.content)!
    note('long.md', `changed\n${lines(1000)}`)
    const second = await run(
      'vault_read',
      { path: 'long.md', offset: Number(off), version: ver },
      c
    )
    expect(second.isError).toBe(true)
    expect(second.content).toMatch(
      /long\.md changed since the part you read .* Read it again from the start/
    )
    // A fresh read at the new version starts a new record.
    await run('vault_read', { path: 'long.md' }, c)
    expect(c.reads['long.md'].version).not.toBe(ver)
    expect(c.reads['long.md'].ranges).toHaveLength(1)
  })

  it('refuses offsets past the end and bad offsets', async () => {
    note('s.md', 'short')
    await expect(readPart(vault, { path: 's.md', offset: 9 }, {})).rejects.toThrow(/past the end/)
    await expect(readPart(vault, { path: 's.md', offset: -1 }, {})).rejects.toThrow(/whole number/)
  })

  it('merges read ranges', () => {
    expect(
      addRange(
        [
          [0, 10],
          [20, 30]
        ],
        [5, 25]
      )
    ).toEqual([[0, 30]])
    expect(addRange([[0, 10]], [40, 50])).toEqual([
      [0, 10],
      [40, 50]
    ])
  })
})

// --- Targeted edits ------------------------------------------------------------

const BODY = '# Plan\n\nStatus: draft\n\nOwner: Neno\n\nStatus: draft (copy)\n'

async function readAll(c: VaultContext, path = 'p.md'): Promise<string> {
  const out = await run('vault_read', { path }, c)
  return /version (\w+)/.exec(out.content)![1]
}

describe('vault edit: refusals change nothing', () => {
  it('needs a read in this chat at the same version', async () => {
    note('p.md', BODY)
    const c = ctx()
    const edit = {
      path: 'p.md',
      version: versionOf(BODY),
      old_text: 'Owner: Neno',
      new_text: 'Owner: Sam'
    }
    expect(await run('vault_edit', edit, c)).toMatchObject({
      outcome: 'not-run',
      content: expect.stringMatching(/hasn't been read in this chat/)
    })
    await readAll(c)
    expect(await run('vault_edit', { ...edit, version: 'abc' }, c)).toMatchObject({
      outcome: 'not-run',
      content: expect.stringMatching(/version must be the one from your latest vault_read/)
    })
    expect(text('p.md')).toBe(BODY)
    expect(c.asked).toBe(0)
  })

  it('refuses a stale read', async () => {
    note('p.md', BODY)
    const c = ctx()
    const v = await readAll(c)
    note('p.md', BODY.replace('Neno', 'Neno (typed in Obsidian)'))
    const r = await run(
      'vault_edit',
      { path: 'p.md', version: v, old_text: 'Owner:', new_text: 'Lead:' },
      c
    )
    expect(r).toMatchObject({ outcome: 'not-run' })
    expect(r.content).toMatch(/has changed since you read it .* Read it again/)
    expect(text('p.md')).toContain('typed in Obsidian')
  })

  it('needs exactly one match, and says how many it found', async () => {
    note('p.md', BODY)
    const c = ctx()
    const v = await readAll(c)
    const none = await run(
      'vault_edit',
      { path: 'p.md', version: v, old_text: 'Owner:  Neno', new_text: 'x' },
      c
    )
    expect(none.content).toMatch(/doesn't appear in p\.md exactly as given/)
    const two = await run(
      'vault_edit',
      { path: 'p.md', version: v, old_text: 'Status: draft', new_text: 'x' },
      c
    )
    expect(two.content).toMatch(/appears 2 times in p\.md\. Include more of the surrounding text/)
    expect([none.outcome, two.outcome]).toEqual(['not-run', 'not-run'])
    expect(text('p.md')).toBe(BODY)
  })

  it('refuses a passage outside what was read', async () => {
    const big = `${'filler line\n'.repeat(5000)}Target: here\n`
    note('big.md', big)
    const c = ctx()
    const out = await run('vault_read', { path: 'big.md' }, c)
    const v = /version (\w+)/.exec(out.content)![1]
    const r = await run(
      'vault_edit',
      { path: 'big.md', version: v, old_text: 'Target: here', new_text: 'Target: there' },
      c
    )
    expect(r.outcome).toBe('not-run')
    expect(r.content).toMatch(
      /outside what you read of big\.md \(0–[\d,]+\)\. Read that part first/
    )
    expect(text('big.md')).toBe(big)
  })

  it('never replaces a whole note or a very long passage', async () => {
    note('p.md', BODY)
    note('long.md', `start\n${'y'.repeat(5000)}\nend`)
    const c = ctx()
    const v = await readAll(c)
    expect(
      (await run('vault_edit', { path: 'p.md', version: v, old_text: BODY, new_text: 'gone' }, c))
        .content
    ).toMatch(/never overwrites a whole note/)
    const v2 = await readAll(c, 'long.md')
    expect(
      (
        await run(
          'vault_edit',
          { path: 'long.md', version: v2, old_text: 'y'.repeat(4001), new_text: '' },
          c
        )
      ).content
    ).toMatch(/at most 4,000 can be replaced/)
    expect(text('p.md')).toBe(BODY)
  })

  it("refuses Custard's capture records, unsafe paths and links", async () => {
    note('Custard/Captures/2026-10-07 1200 Chat.md', 'Decided: x')
    note('Custard/Plugins/Spotify/Activity/a.md', 'played')
    const outside = join(root, 'outside.md')
    writeFileSync(outside, 'outside')
    symlinkSync(outside, join(vault, 'out.md'))
    note('real.md', 'inside text here')
    symlinkSync(join(vault, 'real.md'), join(vault, 'alias.md'))
    const c = ctx()
    for (const path of [
      'Custard/./Captures/2026-10-07 1200 Chat.md',
      'Custard/Captures/2026-10-07 1200 Chat.md',
      'Custard/Plugins/Spotify/Activity/a.md'
    ])
      expect(
        (await run('vault_edit', { path, version: 'x', old_text: 'x', new_text: 'y' }, c)).content
      ).toMatch(/memory records, which are never edited/)
    expect(
      (await run('vault_edit', { path: '../x.md', version: 'x', old_text: 'a', new_text: 'b' }, c))
        .content
    ).toBe('Path is outside the vault.')
    expect(
      (await run('vault_edit', { path: 'out.md', version: 'x', old_text: 'a', new_text: 'b' }, c))
        .content
    ).toMatch(/outside the vault through a link/)
    const v = await readAll(c, 'alias.md')
    const r = await run(
      'vault_edit',
      { path: 'alias.md', version: v, old_text: 'inside', new_text: 'in' },
      c
    )
    expect(r).toMatchObject({
      outcome: 'not-run',
      content: expect.stringMatching(/is a link to another file/)
    })
    expect(readFileSync(outside, 'utf8')).toBe('outside')
    expect(text('real.md')).toBe('inside text here')
    expect(c.asked).toBe(0)
  })

  it('does nothing when the user says no', async () => {
    note('p.md', BODY)
    const c = ctx({ approveEdit: async () => false })
    const v = await readAll(c)
    const r = await run(
      'vault_edit',
      { path: 'p.md', version: v, old_text: 'Owner: Neno', new_text: 'Owner: Sam' },
      c
    )
    expect(r).toMatchObject({
      outcome: 'not-run',
      content: expect.stringMatching(/didn't approve/)
    })
    expect(text('p.md')).toBe(BODY)
    expect(existsSync(history)).toBe(false)
  })
})

describe('vault edit: writing', () => {
  it('replaces the one passage, keeps a copy outside the vault, and carries the read forward', async () => {
    note('p.md', BODY)
    const c = ctx()
    const v = await readAll(c)
    const r = await run(
      'vault_edit',
      { path: 'p.md', version: v, old_text: 'Owner: Neno', new_text: 'Owner: Neno and Sam' },
      c
    )
    expect(r).toMatchObject({ isError: false, outcome: 'completed' })
    const after = BODY.replace('Owner: Neno', 'Owner: Neno and Sam')
    expect(text('p.md')).toBe(after)
    const e = c.edits.tu_1
    expect(e).toMatchObject({
      path: 'p.md',
      before: v,
      after: versionOf(after),
      vault: vaultKey(vault)
    })
    expect(e.backup.startsWith(history)).toBe(true)
    expect(readFileSync(e.backup, 'utf8')).toBe(BODY)
    expect(c.reads['p.md']).toMatchObject({
      version: versionOf(after),
      ranges: [[0, after.length]]
    })
    // No temporary file is left next to the note.
    expect(readdirSync(vault)).toEqual(['p.md'])
    // A second edit works from the carried-over read.
    const r2 = await run(
      'vault_edit',
      { path: 'p.md', version: versionOf(after), old_text: '# Plan', new_text: '# The plan' },
      { ...c, callId: 'tu_2' }
    )
    expect(r2.outcome).toBe('completed')
  })

  it('keeps Windows line endings', async () => {
    const crlf = 'one\r\ntwo\r\nthree\r\n'
    note('w.md', crlf)
    const c = ctx()
    const v = await readAll(c, 'w.md')
    const r = await run(
      'vault_edit',
      { path: 'w.md', version: v, old_text: 'one\ntwo', new_text: 'one\n1.5\ntwo' },
      c
    )
    expect(r.outcome).toBe('completed')
    expect(text('w.md')).toBe('one\r\n1.5\r\ntwo\r\nthree\r\n')
  })

  // Another program writes at each point where it could.
  const prep = async (): Promise<{
    c: ReturnType<typeof ctx>
    p: Awaited<ReturnType<typeof prepareEdit>>
  }> => {
    note('p.md', BODY)
    const c = ctx()
    const v = await readAll(c)
    const p = await prepareEdit(
      vault,
      { path: 'p.md', version: v, old_text: 'Owner: Neno', new_text: 'Owner: Sam' },
      c.reads
    )
    return { c, p }
  }
  const OTHER = BODY.replace('# Plan', '# Plan (Obsidian)')
  const writer = (step: string): EditDeps => ({
    at: async (s) => {
      if (s === step) writeFileSync(join(vault, 'p.md'), OTHER)
    }
  })

  it('refuses when the note changes while waiting for approval', async () => {
    const { c, p } = await prep()
    const r = await applyEdit(vault, p, c.reads, history, writer('approved'))
    expect(r.run).toMatchObject({
      outcome: 'not-run',
      content: expect.stringMatching(/changed while the edit waited/)
    })
    expect(r.edit).toBeUndefined()
    expect(text('p.md')).toBe(OTHER)
  })

  it('refuses when the note changes just before the write, and leaves no temporary file or copy', async () => {
    const { c, p } = await prep()
    const r = await applyEdit(vault, p, c.reads, history, writer('temp'))
    expect(r.run).toMatchObject({
      outcome: 'not-run',
      content: expect.stringMatching(/changed just before the write/)
    })
    expect(text('p.md')).toBe(OTHER)
    expect(readdirSync(vault)).toEqual(['p.md'])
    expect(readdirSync(join(history, vaultKey(vault)))).toEqual([])
  })

  it('reports outcome unknown when the read-back shows another change, and keeps the copy', async () => {
    const { c, p } = await prep()
    const r = await applyEdit(vault, p, c.reads, history, writer('written'))
    expect(r.run).toMatchObject({
      outcome: 'unknown',
      content: expect.stringMatching(/doesn't match the edit/)
    })
    expect(r.edit).toMatchObject({ unknown: true })
    expect(readFileSync(r.edit!.backup, 'utf8')).toBe(BODY)
  })

  it('fails without touching the note when the copy, the new file or the rename fails', async () => {
    const boom = async (): Promise<void> => {
      throw new Error('disk full')
    }
    for (const deps of [
      { writeFile: boom },
      {
        writeFile: async (p: string, t: string, flag?: string) =>
          p.includes('vault-history') ? fsp.writeFile(p, t, { flag }) : boom()
      },
      { rename: boom }
    ] as EditDeps[]) {
      const { c, p } = await prep()
      const r = await applyEdit(vault, p, c.reads, history, deps)
      expect(r.run).toMatchObject({
        outcome: 'failed',
        content: expect.stringMatching(/disk full.*wasn't changed/)
      })
      expect(text('p.md')).toBe(BODY)
      expect(readdirSync(vault)).toEqual(['p.md'])
    }
  })

  it('reports outcome unknown when the note cannot be read back', async () => {
    const { c, p } = await prep()
    const r = await applyEdit(vault, p, c.reads, history, {
      readFile: async () => {
        throw new Error('EIO')
      }
    })
    expect(r.run.outcome).toBe('unknown')
  })
})

describe('vault edit: Undo', () => {
  async function edited(): Promise<{ c: ReturnType<typeof ctx>; e: VaultEdit }> {
    note('p.md', BODY)
    const c = ctx()
    const v = await readAll(c)
    await run(
      'vault_edit',
      { path: 'p.md', version: v, old_text: 'Owner: Neno', new_text: 'Owner: Sam' },
      c
    )
    return { c, e: c.edits.tu_1 }
  }

  it('puts the note back when nothing changed since', async () => {
    const { e } = await edited()
    expect(await undoEdit(vault, e)).toEqual({
      ok: true,
      message: 'Undone: p.md is back to the version from before the edit.'
    })
    expect(text('p.md')).toBe(BODY)
  })

  it('refuses after an intervening edit and leaves the newer note alone', async () => {
    const { e } = await edited()
    const newer = text('p.md') + '\nAdded later in Obsidian\n'
    writeFileSync(join(vault, 'p.md'), newer)
    const r = await undoEdit(vault, e)
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(
      /has changed since this edit, so Undo would overwrite the newer changes/
    )
    expect(r.message).toContain(e.backup)
    expect(text('p.md')).toBe(newer)
  })

  it('refuses for another vault, a changed copy, or twice', async () => {
    const { e } = await edited()
    const other = join(root, 'other')
    mkdirSync(other)
    expect((await undoEdit(other, e)).message).toMatch(/different vault/)
    writeFileSync(e.backup, 'tampered')
    expect((await undoEdit(vault, e)).message).toMatch(/isn't the version from before the edit/)
    expect((await undoEdit(vault, { ...e, undone: 1 })).message).toMatch(/already undone/)
    expect(text('p.md')).toBe(BODY.replace('Owner: Neno', 'Owner: Sam'))
  })

  it('refuses if the note changes just before its write', async () => {
    const { e } = await edited()
    const r = await undoEdit(vault, e, {
      at: async (s) => {
        if (s === 'temp') writeFileSync(join(vault, 'p.md'), 'typed meanwhile')
      }
    })
    expect(r).toMatchObject({
      ok: false,
      message: expect.stringMatching(/changed just before the write/)
    })
    expect(text('p.md')).toBe('typed meanwhile')
  })

  it('moves read ranges to match an edit', () => {
    expect(
      shiftRanges(
        [
          [0, 10],
          [20, 30],
          [40, 50]
        ],
        22,
        25,
        5
      )
    ).toEqual([
      [0, 10],
      [20, 35],
      [45, 55]
    ])
  })
})

// --- Safeguards ----------------------------------------------------------------

describe('vault safeguards', () => {
  it('reports a disconnected vault as not run for every tool', async () => {
    const c = ctx()
    rmSync(vault, { recursive: true })
    for (const name of [
      'vault_search',
      'vault_list',
      'vault_read',
      'vault_create_note',
      'vault_append',
      'vault_edit'
    ])
      expect(await run(name, { query: 'x', path: 'a.md', content: 'x' }, c)).toMatchObject({
        outcome: 'not-run',
        content: expect.stringMatching(/can't be reached right now, so nothing was done/)
      })
  })

  it('lists links inside the vault but not ones leading out', async () => {
    note('a.md', 'x')
    mkdirSync(join(vault, 'dir'))
    const outside = join(root, 'outside')
    mkdirSync(outside)
    symlinkSync(outside, join(vault, 'escape'))
    symlinkSync(join(vault, 'dir'), join(vault, 'inner'))
    symlinkSync(join(root, 'missing'), join(vault, 'broken.md'))
    const r = await run('vault_list', {}, ctx())
    expect(r.content).toBe(
      'a.md\ndir/\ninner/\n(2 links to places outside the vault, or broken, not shown)'
    )
  })

  it('reports create and append failures with the right outcome', async () => {
    note('exists.md', 'x')
    mkdirSync(join(vault, 'dir.md'))
    const c = ctx()
    expect(await run('vault_create_note', { path: 'exists.md', content: 'y' }, c)).toMatchObject({
      outcome: 'not-run'
    })
    expect(await run('vault_append', { path: 'dir.md', content: 'y' }, c)).toMatchObject({
      outcome: 'failed'
    })
    writeFileSync(join(vault, 'blocker'), '')
    expect(
      await run('vault_create_note', { path: 'blocker/new.md', content: 'y' }, c)
    ).toMatchObject({ outcome: 'failed' })
    expect(await run('vault_create_note', { path: 'new.md', content: 'y' }, c)).toMatchObject({
      isError: false
    })
    expect(text('exists.md')).toBe('x')
  })

  it('bounds Memory.md in the prompt and says how to read the gap', async () => {
    const lines = Array.from(
      { length: 600 },
      (_, i) => `- 2026-10-07: memory line ${i} ${'m'.repeat(20)}`
    )
    const memory = lines.join('\n')
    const bounded = boundMemory(memory)
    expect(bounded.length).toBeLessThan(MEMORY_LIMITS.chars + 300)
    expect(bounded.startsWith(lines[0])).toBe(true)
    expect(bounded.endsWith(lines[599])).toBe(true)
    const [, from] = /offset (\d+)/.exec(bounded)!
    // The offset in the marker is where the left-out text starts in the file.
    note('Custard/Memory.md', memory)
    const part = await readPart(vault, { path: 'Custard/Memory.md', offset: Number(from) }, {})
    const firstMissing = part.split('\n')[1]
    expect(bounded).not.toContain(firstMissing)
    expect(memory.slice(Number(from))).toMatch(
      new RegExp(`^${firstMissing.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}`)
    )
    expect(boundMemory('short')).toBe('short')
  })

  it('says how many skills and capture items it left out', () => {
    for (let i = 0; i < 65; i++)
      note(`Custard/Skills/s${i}/SKILL.md`, `---\nname: s${i}\ndescription: Skill ${i}\n---\nbody`)
    for (let i = 0; i < 25; i++)
      note(
        `Custard/Captures/2026-10-${String(i + 1).padStart(2, '0')} 1200 C${i}.md`,
        `# C\n\n## Preferences\n\n- Pref ${i} ${'p'.repeat(200)}\n`
      )
    const prompt = vaultSystemPrompt(vault, 'chat')
    expect(prompt).toContain(
      "5 more skills aren't listed here; vault_list Custard/Skills shows them all."
    )
    expect(prompt).toMatch(
      /Left out above for length: \d+ more remembered or activity items and 5 older capture notes\. Find them with vault_search folder:Custard\/Captures/
    )
    expect(prompt).toContain('Use vault_edit only to make a change the user asked for')
  })

  it('automatic memory capture never reaches the edit tool', () => {
    // Capture code writes notes only through memory/write (exclusive create).
    const dir = join(__dirname, '..', 'memory')
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))) {
      const src = readFileSync(join(dir, f), 'utf8')
      expect(src, f).not.toMatch(/vault_edit|vault\/edit|runVaultTool|applyEdit|from '\.\.\/vault'/)
    }
  })

  it('records edit outcomes the Step 1 way and guards a repeat of an unknown one', async () => {
    note('p.md', BODY)
    const conv: Conversation = {
      id: 'c',
      mode: 'chat',
      title: 't',
      createdAt: 0,
      updatedAt: 0,
      messages: []
    }
    const log = new TurnLog(conv, () => undefined)
    const c = ctx()
    const v = await readAll(c)
    const input = { path: 'p.md', version: v, old_text: 'Owner: Neno', new_text: 'Owner: Sam' }
    const calls: Call[] = [
      {
        id: 'a',
        name: 'vault_edit',
        input: { ...input, old_text: 'nope' },
        label: 'Edited p.md',
        write: true
      },
      { id: 'b', name: 'vault_edit', input, label: 'Edited p.md', write: true }
    ]
    conv.messages.push({ role: 'user', content: 'edit it' })
    const prepared = await prepareEdit(vault, input, c.reads)
    const results = await log.runRound(
      calls,
      (call) =>
        call.id === 'b'
          ? applyEdit(
              vault,
              // Prepared as runVaultTool would, then a write lands at the read-back.
              prepared,
              c.reads,
              history,
              {
                at: async (s) =>
                  void (s === 'written' && writeFileSync(join(vault, 'p.md'), 'other'))
              }
            ).then((r) => r.run)
          : run(call.name, call.input, c),
      new AbortController().signal
    )
    expect(results.map((r) => String(r.content).split(':')[0])).toEqual([
      'Not run',
      'Outcome unknown'
    ])
    expect(conv.actions?.a.status).toBe('not-run')
    expect(conv.actions?.b.status).toBe('unknown')
    expect(log.unknownRepeat({ ...calls[1], id: 'c' })).toBe(true)
  })
})
