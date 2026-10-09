import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
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
import type { Conversation } from '../../shared/chat'
import { TurnLog, type Call } from '../turn'
import { resolveInVault, VaultPathError } from '../memory/paths'
import {
  boundMemory,
  MEMORY_LIMITS,
  previewNote,
  runVaultTool,
  vaultSystemPrompt,
  vaultTools
} from '../vault'
import { fold, matchNote, parseQuery, search, searchVault, SEARCH_LIMITS, tagsOf } from './search'
import { READ_LIMITS, readPart, versionOf } from './read'

let root: string
let vault: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'custard-vault-'))
  vault = join(root, 'vault')
  mkdirSync(vault)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const note = (path: string, text: string): void => {
  mkdirSync(dirname(join(vault, path)), { recursive: true })
  writeFileSync(join(vault, path), text)
}
const text = (path: string): string => readFileSync(join(vault, path), 'utf8')

const run = (name: string, input: unknown): ReturnType<typeof runVaultTool> =>
  runVaultTool(vault, name, input)

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
    const out = await run('vault_search', { query: 'plan folder:../..' })
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

  it('labels a scan stopped by the time limit as partial, not a vault total', async () => {
    for (let i = 0; i < 30; i++) note(`n${String(i).padStart(2, '0')}.md`, 'word')
    let t = 0
    const out = await search(vault, { query: 'word' }, { now: () => (t += 500) })
    expect(out).toMatch(
      /^\d+ notes? matched word in a partial scan \(not a total for the whole vault\)\./
    )
    expect(out).toMatch(
      /This was a partial scan: it stopped after 5 seconds, with \d+ notes searched, so notes it didn't reach may also match\. Each page runs a new scan, which may stop at a different point, so pages can repeat or miss notes\./
    )
    t = 0
    const none = await search(vault, { query: 'absent' }, { now: () => (t += 500) })
    expect(none).toMatch(/^No notes matched absent in the part of the vault searched\./)
  })

  it('labels a scan stopped by the file limit the same way', async () => {
    const was = SEARCH_LIMITS.maxFiles
    SEARCH_LIMITS.maxFiles = 10
    try {
      for (let i = 0; i < 25; i++) note(`n${String(i).padStart(2, '0')}.md`, 'word')
      const out = await search(vault, { query: 'word' })
      expect(out).toMatch(/^\d+ notes matched word in a partial scan/)
      expect(out).toContain('it stopped after 10 notes')
      expect(await search(vault, { query: 'word', page: 9 })).toMatch(
        /^This scan found \d+ matches, so page 9 is past the end[\s\S]*partial scan/
      )
    } finally {
      SEARCH_LIMITS.maxFiles = was
    }
  })

  it('says nothing about partial results for a complete scan', async () => {
    note('a.md', 'word')
    const out = await search(vault, { query: 'word' })
    expect(out).toMatch(/^1 note matched word\. Showing 1–1\./)
    expect(out).not.toContain('partial')
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
    let offset = 0
    let version: string | undefined
    let got = ''
    for (let i = 0; i < 10 && offset < body.length; i++) {
      const out = await readPart(vault, { path: 'long.md', offset, version })
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
  })

  it('says when a short note is complete', async () => {
    note('s.md', 'short')
    expect(await readPart(vault, { path: 's.md' })).toBe(
      `[s.md · version ${versionOf('short')} · the whole note, 5 characters]\nshort`
    )
  })

  it('reports a change between parts', async () => {
    note('long.md', lines(1000))
    const first = await run('vault_read', { path: 'long.md' })
    const [, off, ver] = /offset (\d+) and version "(\w+)"/.exec(first.content)!
    note('long.md', `changed\n${lines(1000)}`)
    const second = await run('vault_read', { path: 'long.md', offset: Number(off), version: ver })
    expect(second.isError).toBe(true)
    expect(second.content).toMatch(
      /long\.md changed since the part you read .* Read it again from the start/
    )
  })

  it('refuses offsets past the end and bad offsets', async () => {
    note('s.md', 'short')
    await expect(readPart(vault, { path: 's.md', offset: 9 })).rejects.toThrow(/past the end/)
    await expect(readPart(vault, { path: 's.md', offset: -1 })).rejects.toThrow(/whole number/)
  })
})

// --- Safeguards ----------------------------------------------------------------

describe('vault note creation (race-resistant)', () => {
  it("re-checks the real place against the caller's guard just before creating", async () => {
    mkdirSync(join(vault, 'Custard', 'Skills'), { recursive: true })
    const r = await runVaultTool(
      vault,
      'vault_create_note',
      { path: 'Custard/Skills/x/SKILL.md', content: 'hi' },
      (real) => (real.includes(join('Custard', 'Skills')) ? 'No skills here.' : null)
    )
    expect(r).toMatchObject({ isError: true, outcome: 'not-run' })
    expect(r.content).toMatch(/No skills here\. Nothing was written\./)
    // The guard is asked before each missing folder is made too (2.2), so not
    // even the empty folder is left in the protected place.
    expect(readdirSync(join(vault, 'Custard', 'Skills'))).toEqual([])
  })

  it('creates a note normally and never replaces one', async () => {
    expect((await run('vault_create_note', { path: 'a.md', content: 'one' })).isError).toBe(false)
    expect(readFileSync(join(vault, 'a.md'), 'utf8')).toBe('one\n')
    const again = await run('vault_create_note', { path: 'a.md', content: 'two' })
    expect(again.isError).toBe(true)
    expect(readFileSync(join(vault, 'a.md'), 'utf8')).toBe('one\n')
  })
})

describe('vault safeguards', () => {
  it('never writes through a broken link, at the note or any folder above it', async () => {
    const outside = join(root, 'outside')
    mkdirSync(outside)
    // The note itself is a link to a file that doesn't exist yet.
    symlinkSync(join(outside, 'planted.md'), join(vault, 'Planted.md'))
    // A folder in the path is a link to a folder that doesn't exist yet.
    symlinkSync(join(outside, 'later'), join(vault, 'Inbox'))
    // A folder in the path is a link to an existing folder outside.
    symlinkSync(outside, join(vault, 'Out'))
    for (const path of ['Planted.md', 'Inbox/x.md', 'Inbox/deeper/x.md', 'Out/x.md'])
      expect(await run('vault_create_note', { path, content: 'escaped' }), path).toMatchObject({
        isError: true,
        outcome: 'not-run'
      })
    for (const path of ['Planted.md', 'Inbox/x.md', 'Out/x.md'])
      expect(() => resolveInVault(vault, path), path).toThrow(VaultPathError)
    expect(readdirSync(outside)).toEqual([])
    // A link that stays inside the vault is still fine.
    mkdirSync(join(vault, 'Real'))
    symlinkSync(join(vault, 'Real'), join(vault, 'Alias'))
    expect(await run('vault_create_note', { path: 'Alias/ok.md', content: 'ok' })).toMatchObject({
      isError: false
    })
  })

  it('reports a disconnected vault as not run for every tool', async () => {
    rmSync(vault, { recursive: true })
    for (const name of [
      'vault_search',
      'vault_list',
      'vault_read',
      'vault_create_note',
      'vault_append'
    ])
      expect(await run(name, { query: 'x', path: 'a.md', content: 'x' })).toMatchObject({
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
    const r = await run('vault_list', {})
    expect(r.content).toBe(
      'a.md\ndir/\ninner/\n(2 links to places outside the vault, or broken, not shown)'
    )
  })

  it('reports create failures with the right outcome, and refuses appends', async () => {
    note('exists.md', 'x')
    mkdirSync(join(vault, 'dir.md'))
    expect(await run('vault_create_note', { path: 'exists.md', content: 'y' })).toMatchObject({
      outcome: 'not-run'
    })
    // Appending is off: nothing is done, whatever the path.
    expect(await run('vault_append', { path: 'exists.md', content: 'y' })).toMatchObject({
      outcome: 'not-run'
    })
    writeFileSync(join(vault, 'blocker'), '')
    expect(await run('vault_create_note', { path: 'blocker/new.md', content: 'y' })).toMatchObject({
      outcome: 'failed'
    })
    expect(await run('vault_create_note', { path: 'new.md', content: 'y' })).toMatchObject({
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
    const part = await readPart(vault, { path: 'Custard/Memory.md', offset: Number(from) })
    const firstMissing = part.split('\n')[1]
    expect(bounded).not.toContain(firstMissing)
    expect(memory.slice(Number(from))).toMatch(
      new RegExp(`^${firstMissing.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}`)
    )
    expect(boundMemory('short')).toBe('short')
  })

  it('builds the prompt when the Skills or Captures folder is not a folder (L6)', () => {
    note('Custard/Skills', 'a file where the folder should be')
    note('Custard/Captures', 'also a file')
    expect(() => vaultSystemPrompt(vault, 'chat')).not.toThrow()
    expect(vaultSystemPrompt(vault, 'chat')).toContain('<memory>')
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
  })

  it('offers no edit or append tool: notes can only be created', () => {
    expect(vaultTools.map((t) => t.name)).toEqual([
      'vault_search',
      'vault_list',
      'vault_read',
      'vault_create_note'
    ])
  })

  it('previews a new note in full, warns for folders read into chats, and refuses existing ones', () => {
    const long = `${'z'.repeat(5000)}\nEND-OF-NOTE`
    const p = previewNote(vault, { path: 'Inbox/New.md', content: long })
    expect(p.label).toBe('Create note Inbox/New.md')
    expect(p.detail.endsWith(long)).toBe(true)
    expect(p.detail).not.toMatch(/instructions/)
    expect(previewNote(vault, { path: 'Custard/Captures/x.md', content: 'x' }).detail).toMatch(
      /reads notes in this folder into every chat's instructions/
    )
    note('exists.md', 'x')
    expect(() => previewNote(vault, { path: 'exists.md', content: 'y' })).toThrow(/already exists/)
    symlinkSync(join(root, 'nowhere.md'), join(vault, 'dangling.md'))
    expect(() => previewNote(vault, { path: 'dangling.md', content: 'y' })).toThrow()
  })

  it('automatic memory capture never goes through the vault tools', () => {
    // Capture writes notes only through memory/write (exclusive create).
    const dir = join(__dirname, '..', 'memory')
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))) {
      const src = readFileSync(join(dir, f), 'utf8')
      expect(src, f).not.toMatch(/runVaultTool|from '\.\.\/vault'/)
    }
  })

  it('records vault tool outcomes the Step 1 way', async () => {
    note('exists.md', 'x')
    mkdirSync(join(vault, 'dir.md'))
    const conv: Conversation = {
      id: 'c',
      mode: 'chat',
      title: 't',
      createdAt: 0,
      updatedAt: 0,
      messages: [{ role: 'user', content: 'go' }]
    }
    const log = new TurnLog(conv, () => undefined)
    const calls: Call[] = [
      {
        id: 'a',
        name: 'vault_create_note',
        input: { path: 'exists.md', content: 'y' },
        label: 'c',
        write: true
      },
      {
        id: 'b',
        name: 'vault_append',
        input: { path: 'dir.md', content: 'y' },
        label: 'a',
        write: true
      },
      { id: 'c', name: 'vault_read', input: { path: 'exists.md' }, label: 'r', write: false }
    ]
    const results = await log.runRound(
      calls,
      (call) => run(call.name, call.input),
      new AbortController().signal
    )
    expect(results.map((r) => String(r.content).split(':')[0])).toEqual([
      'Not run',
      'Not run',
      '[exists.md · version ' + versionOf('x') + ' · the whole note, 1 characters]\nx'
    ])
    expect(Object.values(conv.actions ?? {}).map((a) => a.status)).toEqual([
      'not-run',
      'not-run',
      'completed'
    ])
  })
})
