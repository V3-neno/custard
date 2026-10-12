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
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import type { VaultGrant } from '../../shared/vaultGrants'
import { runVaultTool } from '../vault'
import { extensionRefusal, extensionTarget } from '../modes/extensions'
import {
  applyEdits,
  EDIT_LIMITS,
  KEEP_RECORDS,
  listEdits,
  previewChange,
  summarizeChange,
  undoEdit,
  VaultEditError
} from './edit'
import { versionOf } from './read'

let root: string
let vault: string
let records: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'custard-edit-'))
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

const run = (
  grants: VaultGrant[],
  name: string,
  input: Record<string, unknown>
): ReturnType<typeof runVaultTool> =>
  runVaultTool(
    vault,
    name,
    input,
    (real) => {
      const t = extensionTarget(real, vault, { plugin: [], app: [] })
      return t === 'skill' ? extensionRefusal(t, 'Chat') : null
    },
    { grants, recordsDir: records, source: 'test' }
  )
const edit = (
  grants: VaultGrant[],
  path: string,
  edits: unknown[],
  version?: string
): ReturnType<typeof runVaultTool> =>
  run(grants, 'vault_edit', { path, version: version ?? versionOf(text(path)), edits })

const EDIT: VaultGrant[] = [{ folder: 'Notes', mode: 'edit' }]
const APPEND: VaultGrant[] = [{ folder: 'Notes', mode: 'append' }]
const CREATE: VaultGrant[] = [{ folder: 'Notes', mode: 'create' }]

describe('applyEdits', () => {
  it('replaces text that appears exactly once', () => {
    expect(applyEdits('a b c', [{ type: 'replace', old_text: 'b', new_text: 'X' }])).toBe('a X c')
  })
  it('refuses text that is missing or repeated', () => {
    expect(() => applyEdits('a b', [{ type: 'replace', old_text: 'z', new_text: '' }])).toThrow(
      /not found/
    )
    expect(() => applyEdits('a a', [{ type: 'replace', old_text: 'a', new_text: '' }])).toThrow(
      /more than once/
    )
    expect(() => applyEdits('a', [{ type: 'replace', old_text: '', new_text: 'x' }])).toThrow()
  })
  it('matches every edit against the text as read, not the result of earlier edits', () => {
    // Edit 1 puts "b" in; edit 2 still sees only the one "b" that was read.
    expect(
      applyEdits('a b', [
        { type: 'replace', old_text: 'a', new_text: 'b b' },
        { type: 'replace', old_text: 'b', new_text: 'X' }
      ])
    ).toBe('b b X')
  })
  it('refuses overlapping edits', () => {
    expect(() =>
      applyEdits('abcdef', [
        { type: 'replace', old_text: 'abcd', new_text: '1' },
        { type: 'replace', old_text: 'cdef', new_text: '2' }
      ])
    ).toThrow(/overlapping/)
  })
  it('applies nothing when any one edit fails', () => {
    expect(() =>
      applyEdits('a b', [
        { type: 'replace', old_text: 'a', new_text: 'X' },
        { type: 'replace', old_text: 'missing', new_text: 'Y' }
      ])
    ).toThrow(VaultEditError)
  })
  it('appends at the end, on a new line', () => {
    expect(applyEdits('one', [{ type: 'append', text: 'two' }])).toBe('one\ntwo\n')
    expect(applyEdits('one\n', [{ type: 'append', text: 'two\n' }])).toBe('one\ntwo\n')
  })

  describe('insert_after_heading', () => {
    const doc = '# T\n\nintro\n\n## Log\n- a\n- b\n\n## Next\nx\n'
    it('lands at the end of the section, before the next heading and its blank line', () => {
      expect(
        applyEdits(doc, [{ type: 'insert_after_heading', heading: '## Log', text: '- c' }])
      ).toBe('# T\n\nintro\n\n## Log\n- a\n- b\n- c\n\n## Next\nx\n')
    })
    it('a higher-level heading ends the section; a lower one does not', () => {
      const d = '## Log\n- a\n### Sub\n- s\n\n## Next\n'
      expect(
        applyEdits(d, [{ type: 'insert_after_heading', heading: '## Log', text: '- z' }])
      ).toBe('## Log\n- a\n### Sub\n- s\n- z\n\n## Next\n')
    })
    it('goes right after an empty section heading', () => {
      expect(
        applyEdits('## A\n\n## B\n', [{ type: 'insert_after_heading', heading: '## A', text: 'x' }])
      ).toBe('## A\nx\n\n## B\n')
    })
    it('works at the end of the note, with or without a final newline', () => {
      expect(
        applyEdits('## Log\n- a', [
          { type: 'insert_after_heading', heading: '## Log', text: '- b' }
        ])
      ).toBe('## Log\n- a\n- b\n')
    })
    it('refuses a heading that is missing, repeated or not a heading line', () => {
      expect(() =>
        applyEdits(doc, [{ type: 'insert_after_heading', heading: '## Nope', text: 'x' }])
      ).toThrow(/no heading/)
      expect(() =>
        applyEdits('## A\n## A\n', [{ type: 'insert_after_heading', heading: '## A', text: 'x' }])
      ).toThrow(/2 times/)
      expect(() =>
        applyEdits(doc, [{ type: 'insert_after_heading', heading: 'Log', text: 'x' }])
      ).toThrow(/whole heading line/)
    })
    it('does not count headings inside code fences', () => {
      const d = '```\n## Log\n```\n## Log\nx\n'
      expect(applyEdits(d, [{ type: 'insert_after_heading', heading: '## Log', text: 'y' }])).toBe(
        '```\n## Log\n```\n## Log\nx\ny\n'
      )
    })
  })

  it('enforces the limits', () => {
    expect(() => applyEdits('a', [])).toThrow()
    expect(() =>
      applyEdits(
        'a',
        Array.from({ length: EDIT_LIMITS.edits + 1 }, () => ({ type: 'append', text: 'x' }))
      )
    ).toThrow(/At most/)
    expect(() =>
      applyEdits('a', [{ type: 'append', text: 'x'.repeat(EDIT_LIMITS.editChars + 1) }])
    ).toThrow(/over/)
    expect(() => applyEdits('a', [{ type: 'delete' } as never])).toThrow(/type must be/)
  })
})

describe('summarizeChange', () => {
  it('shows only the part that changed', () => {
    expect(summarizeChange('keep OLD keep', 'keep NEW keep')).toEqual({
      removed: 'OLD',
      added: 'NEW',
      truncated: false
    })
  })
})

describe('grants decide what runs', () => {
  it('append in a granted folder adds to the end and records it', async () => {
    note('Notes/a.md', 'one\n')
    const r = await run(APPEND, 'vault_append', { path: 'Notes/a.md', text: 'two' })
    expect(r.isError).toBe(false)
    expect(text('Notes/a.md')).toBe('one\ntwo\n')
    expect(listEdits(records)[0]).toMatchObject({ kind: 'append', path: 'Notes/a.md' })
  })
  it('refuses outside any grant, and writes nothing', async () => {
    note('Other/a.md', 'one\n')
    const r = await run(APPEND, 'vault_append', { path: 'Other/a.md', text: 'two' })
    expect(r).toMatchObject({ isError: true, outcome: 'not-run' })
    expect(text('Other/a.md')).toBe('one\n')
    expect(listEdits(records)).toHaveLength(0)
  })
  it('an append grant does not allow vault_edit, a create grant does not allow append', async () => {
    note('Notes/a.md', 'one\n')
    expect(
      await edit(APPEND, 'Notes/a.md', [{ type: 'replace', old_text: 'one', new_text: 'X' }])
    ).toMatchObject({ isError: true, outcome: 'not-run' })
    expect(await run(CREATE, 'vault_append', { path: 'Notes/a.md', text: 'x' })).toMatchObject({
      isError: true
    })
    expect(text('Notes/a.md')).toBe('one\n')
  })
  it('an edit grant includes append', async () => {
    note('Notes/a.md', 'one\n')
    expect((await run(EDIT, 'vault_append', { path: 'Notes/a.md', text: 'two' })).isError).toBe(
      false
    )
  })
  it('a note that does not exist is not created by append or edit', async () => {
    const r = await run(EDIT, 'vault_append', { path: 'Notes/new.md', text: 'x' })
    expect(r.isError).toBe(true)
    expect(existsSync(join(vault, 'Notes/new.md'))).toBe(false)
  })
  it('create in a granted folder never overwrites', async () => {
    note('Notes/a.md', 'mine\n')
    const r = await run(CREATE, 'vault_create_note', { path: 'Notes/a.md', content: 'x' })
    expect(r.isError).toBe(true)
    expect(text('Notes/a.md')).toBe('mine\n')
    const made = await run(CREATE, 'vault_create_note', { path: 'Notes/b.md', content: 'x' })
    expect(made.isError).toBe(false)
    expect(listEdits(records)[0]).toMatchObject({ kind: 'create', path: 'Notes/b.md' })
  })
  it('refuses a protected place under a parent grant, and the skills folder in Chat', async () => {
    note('Custard/Captures/a.md', 'c\n')
    note('Custard/Skills/s/SKILL.md', 's\n')
    note('Custard/Memory.md', 'm\n')
    const parent: VaultGrant[] = [{ folder: 'Custard', mode: 'edit' }]
    for (const p of ['Custard/Captures/a.md', 'Custard/Skills/s/SKILL.md', 'Custard/Memory.md'])
      expect(await run(parent, 'vault_append', { path: p, text: 'x' })).toMatchObject({
        isError: true
      })
    // Granted by name: Captures can be changed, but skills stay out of Chat's reach.
    const own: VaultGrant[] = [
      { folder: 'Custard/Captures', mode: 'append' },
      { folder: 'Custard/Skills', mode: 'edit' }
    ]
    expect(
      (await run(own, 'vault_append', { path: 'Custard/Captures/a.md', text: 'x' })).isError
    ).toBe(false)
    expect(
      (await run(own, 'vault_append', { path: 'Custard/Skills/s/SKILL.md', text: 'x' })).isError
    ).toBe(true)
    expect(text('Custard/Skills/s/SKILL.md')).toBe('s\n')
  })
  it('a link inside a granted folder cannot reach a place the grants do not cover', async () => {
    note('Other/a.md', 'secret\n')
    mkdirSync(join(vault, 'Notes'), { recursive: true })
    symlinkSync(join(vault, 'Other'), join(vault, 'Notes/link'))
    const r = await run(EDIT, 'vault_append', { path: 'Notes/link/a.md', text: 'x' })
    expect(r.isError).toBe(true)
    expect(text('Other/a.md')).toBe('secret\n')
  })
  it('without grants, nothing existing can be changed', async () => {
    note('Notes/a.md', 'one\n')
    expect((await run([], 'vault_append', { path: 'Notes/a.md', text: 'x' })).isError).toBe(true)
    expect(text('Notes/a.md')).toBe('one\n')
  })
})

describe('vault_edit', () => {
  it('applies several edits together', async () => {
    note('Notes/a.md', '# A\n\nhello world\n\n## Log\n- 1\n')
    const r = await edit(EDIT, 'Notes/a.md', [
      { type: 'replace', old_text: 'hello', new_text: 'goodbye' },
      { type: 'insert_after_heading', heading: '## Log', text: '- 2' }
    ])
    expect(r.isError).toBe(false)
    expect(text('Notes/a.md')).toBe('# A\n\ngoodbye world\n\n## Log\n- 1\n- 2\n')
  })
  it('one bad edit writes nothing at all', async () => {
    note('Notes/a.md', 'hello\n')
    const r = await edit(EDIT, 'Notes/a.md', [
      { type: 'replace', old_text: 'hello', new_text: 'X' },
      { type: 'replace', old_text: 'nope', new_text: 'Y' }
    ])
    expect(r).toMatchObject({ isError: true, outcome: 'not-run' })
    expect(text('Notes/a.md')).toBe('hello\n')
    expect(listEdits(records)).toHaveLength(0)
  })
  it('refuses a stale version', async () => {
    note('Notes/a.md', 'hello\n')
    const r = await edit(
      EDIT,
      'Notes/a.md',
      [{ type: 'replace', old_text: 'hello', new_text: 'X' }],
      'deadbeef0000'
    )
    expect(r).toMatchObject({
      isError: true,
      content: expect.stringMatching(/changed since you read/)
    })
    expect(text('Notes/a.md')).toBe('hello\n')
  })
  it('requires a version', async () => {
    note('Notes/a.md', 'hello\n')
    const r = await run(EDIT, 'vault_edit', {
      path: 'Notes/a.md',
      edits: [{ type: 'append', text: 'x' }]
    })
    expect(r.isError).toBe(true)
    expect(text('Notes/a.md')).toBe('hello\n')
  })
  it('keeps the frontmatter valid', async () => {
    note('Notes/a.md', '---\ntags: [a]\n---\nbody\n')
    const broke = await edit(EDIT, 'Notes/a.md', [
      { type: 'replace', old_text: '---\ntags: [a]\n---\n', new_text: 'tags: [a]\n' }
    ])
    expect(broke).toMatchObject({ isError: true, content: expect.stringMatching(/frontmatter/) })
    const junk = await edit(EDIT, 'Notes/a.md', [
      { type: 'replace', old_text: 'tags: [a]', new_text: 'tags: [a]\nthis is not yaml' }
    ])
    expect(junk.isError).toBe(true)
    const ok = await edit(EDIT, 'Notes/a.md', [
      { type: 'replace', old_text: 'tags: [a]', new_text: 'tags: [a, b]' }
    ])
    expect(ok.isError).toBe(false)
    expect(text('Notes/a.md')).toBe('---\ntags: [a, b]\n---\nbody\n')
  })
  it('refuses a change that changes nothing, and notes that are too long', async () => {
    note('Notes/a.md', 'hello\n')
    expect(
      (await edit(EDIT, 'Notes/a.md', [{ type: 'replace', old_text: 'hello', new_text: 'hello' }]))
        .isError
    ).toBe(true)
    note('Notes/big.md', 'x'.repeat(EDIT_LIMITS.noteChars + 1))
    expect((await run(EDIT, 'vault_append', { path: 'Notes/big.md', text: 'y' })).isError).toBe(
      true
    )
  })
  it('leaves no temporary file behind', async () => {
    note('Notes/a.md', 'hello\n')
    await edit(EDIT, 'Notes/a.md', [{ type: 'append', text: 'x' }])
    expect(readdirSync(join(vault, 'Notes')).filter((f) => f !== 'a.md')).toEqual([])
  })
})

describe('previewChange', () => {
  it('shows what an edit would remove and add, and writes nothing', async () => {
    note('Notes/a.md', 'hello world\n')
    const p = await previewChange(
      vault,
      'vault_edit',
      {
        path: 'Notes/a.md',
        version: versionOf(text('Notes/a.md')),
        edits: [{ type: 'replace', old_text: 'hello', new_text: 'goodbye' }]
      },
      { grants: EDIT }
    )
    expect(p).toMatchObject({ label: expect.stringContaining('Notes/a.md') })
    expect(JSON.stringify(p)).toContain('hello')
    expect(JSON.stringify(p)).toContain('goodbye')
    expect(text('Notes/a.md')).toBe('hello world\n')
    expect(listEdits(records)).toHaveLength(0)
  })
  it('shows an append', async () => {
    note('Notes/a.md', 'x\n')
    const p = await previewChange(
      vault,
      'vault_append',
      { path: 'Notes/a.md', text: 'ADDED-LINE' },
      { grants: APPEND }
    )
    expect(JSON.stringify(p)).toContain('ADDED-LINE')
    expect(text('Notes/a.md')).toBe('x\n')
  })
  it('refuses outside the grants, and on a stale version', async () => {
    note('Notes/a.md', 'hello\n')
    note('Other/b.md', 'hello\n')
    const out = await previewChange(
      vault,
      'vault_append',
      { path: 'Other/b.md', text: 'x' },
      { grants: APPEND }
    )
    expect(out).toMatchObject({ isError: true, outcome: 'not-run' })
    const stale = await previewChange(
      vault,
      'vault_edit',
      {
        path: 'Notes/a.md',
        version: 'deadbeef0000',
        edits: [{ type: 'replace', old_text: 'hello', new_text: 'X' }]
      },
      { grants: EDIT }
    )
    expect(stale).toMatchObject({ isError: true, outcome: 'not-run' })
  })
})

describe('undo', () => {
  it('restores the note as it was', async () => {
    note('Notes/a.md', 'one\n')
    await run(APPEND, 'vault_append', { path: 'Notes/a.md', text: 'two' })
    const id = listEdits(records)[0].id
    expect(undoEdit(vault, records, id)).toMatchObject({ ok: true })
    expect(text('Notes/a.md')).toBe('one\n')
    expect(listEdits(records)[0].undone).toBeTruthy()
    expect(undoEdit(vault, records, id)).toMatchObject({ ok: false })
  })
  it('refuses when the note changed since, and leaves it alone', async () => {
    note('Notes/a.md', 'one\n')
    await run(APPEND, 'vault_append', { path: 'Notes/a.md', text: 'two' })
    writeFileSync(join(vault, 'Notes/a.md'), 'one\ntwo\nthree by hand\n')
    const r = undoEdit(vault, records, listEdits(records)[0].id)
    expect(r.ok).toBe(false)
    expect(text('Notes/a.md')).toBe('one\ntwo\nthree by hand\n')
  })
  it('has nothing to undo for a created note, and keeps only the newest records', async () => {
    await run(CREATE, 'vault_create_note', { path: 'Notes/n.md', content: 'x' })
    expect(undoEdit(vault, records, listEdits(records)[0].id).ok).toBe(false)
    note('Notes/a.md', 'one\n')
    for (let i = 0; i < KEEP_RECORDS + 5; i++)
      await run(APPEND, 'vault_append', { path: 'Notes/a.md', text: `l${i}` })
    expect(listEdits(records).length).toBe(KEEP_RECORDS)
  })
})

describe('what the model is told', () => {
  it('has no way to overwrite, delete or rename', async () => {
    const { vaultTools, vaultChangeTools } = await import('../vault')
    const names = [...vaultTools, ...vaultChangeTools].map((t) => t.name)
    expect(names.filter((n) => /write|delete|rename|overwrite|replace_note/.test(n))).toEqual([])
    expect(names).toContain('vault_edit')
  })
})
