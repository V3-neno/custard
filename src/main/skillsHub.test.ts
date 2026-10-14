import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { aboveRoot, SKILLS_DIR, writesInside } from './modes/extensions'
import { createSkill, MAX_SKILL_CHARS, readSkill, skillEntries, skillExists } from './skillsHub'
import { listSkills } from './vault'

let vault: string
const skill = (folder: string, text?: string, extra: Record<string, string> = {}): void => {
  const dir = join(vault, SKILLS_DIR, folder)
  mkdirSync(dir, { recursive: true })
  if (text !== undefined) writeFileSync(join(dir, 'SKILL.md'), text)
  for (const [f, t] of Object.entries(extra)) {
    mkdirSync(join(dir, f, '..'), { recursive: true })
    writeFileSync(join(dir, f), t)
  }
}

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), 'custard-hub-'))
})
afterEach(() => rmSync(vault, { recursive: true, force: true }))

describe('Skills hub list', () => {
  it('lists usable skills with their fields, sorted by name', () => {
    skill(
      'weekly',
      '---\nname: Weekly review\ndescription: Use weekly.\nmodes: plugins, chat\n---\nBody'
    )
    skill('daily', '---\ndescription: Use daily.\n---\nBody', { 'templates/day.md': 'x' })
    const list = skillEntries(vault, new Set(['daily']))
    expect(list.map((s) => s.name)).toEqual(['daily', 'Weekly review'])
    expect(list[0]).toMatchObject({
      folder: 'daily',
      description: 'Use daily.',
      modes: [],
      path: `${SKILLS_DIR}/daily/SKILL.md`,
      files: [`${SKILLS_DIR}/daily/templates/day.md`],
      starter: true
    })
    expect(list[0].problem).toBeUndefined()
    expect(list[1]).toMatchObject({ modes: ['code', 'chat'], starter: false })
  })

  it('shows folders chats cannot use, saying why', () => {
    skill('empty')
    skill('nodesc', '---\nname: x\n---\nBody')
    const list = skillEntries(vault, new Set())
    expect(list.find((s) => s.folder === 'empty')?.problem).toMatch(/no SKILL.md/)
    expect(list.find((s) => s.folder === 'nodesc')?.problem).toMatch(/no description/)
  })

  it('caps the files it lists', () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < 25; i++) files[`f${String(i).padStart(2, '0')}.md`] = 'x'
    skill('big', '---\ndescription: d\n---\n', files)
    const [s] = skillEntries(vault, new Set())
    expect(s.files).toHaveLength(20)
    expect(s.moreFiles).toBe(5)
  })

  it('gives nothing when there is no Skills folder', () => {
    expect(skillEntries(vault, new Set())).toEqual([])
  })
})

describe('Skills hub read', () => {
  it("reads a skill's SKILL.md", () => {
    skill('daily', '---\ndescription: d\n---\nSteps')
    expect(readSkill(vault, 'daily')).toEqual({
      path: `${SKILLS_DIR}/daily/SKILL.md`,
      text: '---\ndescription: d\n---\nSteps',
      truncated: false
    })
  })

  it('shows only the start of a huge one, and says so', () => {
    skill('huge', 'x'.repeat(MAX_SKILL_CHARS + 10))
    const r = readSkill(vault, 'huge')
    expect(r.text).toHaveLength(MAX_SKILL_CHARS)
    expect(r.truncated).toBe(true)
  })

  it('reads nothing outside a skill folder', () => {
    writeFileSync(join(vault, 'secret.md'), 'no')
    for (const f of ['..', '../..', 'a/b', 'a\\b', '.hidden', '', 'x:y', 42])
      expect(() => readSkill(vault, f)).toThrow()
  })

  it("won't follow a link out of the vault", () => {
    const outside = mkdtempSync(join(tmpdir(), 'custard-out-'))
    writeFileSync(join(outside, 'SKILL.md'), 'outside')
    mkdirSync(join(vault, SKILLS_DIR), { recursive: true })
    symlinkSync(outside, join(vault, SKILLS_DIR, 'linked'))
    expect(() => readSkill(vault, 'linked')).toThrow()
    rmSync(outside, { recursive: true, force: true })
  })
})

describe('a new skill and its workspace', () => {
  it('makes a folder from the name with a draft that loads only in Skills mode', () => {
    const folder = createSkill(vault, 'Meeting notes')
    expect(folder).toBe('meeting-notes')
    expect(skillExists(vault, folder)).toBe(true)
    const text = readFileSync(join(vault, SKILLS_DIR, folder, 'SKILL.md'), 'utf8')
    expect(text).toContain('name: "Meeting notes"')
    expect(listSkills(vault).find((x) => x.folder === folder)?.modes).toEqual(['skills'])
  })
  it('numbers a name that is taken and never replaces a skill', () => {
    skill('meeting-notes', '---\ndescription: Mine.\n---\nKeep me')
    expect(createSkill(vault, 'Meeting notes')).toBe('meeting-notes-2')
    expect(readFileSync(join(vault, SKILLS_DIR, 'meeting-notes', 'SKILL.md'), 'utf8')).toContain(
      'Keep me'
    )
  })
  it('only knows real skill folders', () => {
    skill('daily', '---\ndescription: d\n---\n')
    for (const bad of ['../x', 'daily/..', '', '.hidden', 'nope', 7])
      expect(skillExists(vault, bad)).toBe(false)
  })
  it("a skill's chat writes only inside its folder, by name and by link", () => {
    skill('daily', 'x')
    skill('weekly', 'x')
    const root = join(vault, SKILLS_DIR, 'daily')
    expect(writesInside(join(root, 'SKILL.md'), root)).toBe(true)
    expect(writesInside(join(root, 'sub', 'new.md'), root)).toBe(true)
    expect(writesInside(join(vault, SKILLS_DIR, 'weekly', 'SKILL.md'), root)).toBe(false)
    expect(writesInside(join(root, '..', 'weekly', 'SKILL.md'), root)).toBe(false)
    expect(writesInside(join(vault, SKILLS_DIR, 'daily-extra', 'a.md'), root)).toBe(false)
    // A link inside the folder that leads elsewhere.
    symlinkSync(join(vault, SKILLS_DIR, 'weekly'), join(root, 'out'))
    expect(writesInside(join(root, 'out', 'SKILL.md'), root)).toBe(false)
  })
  it('lets a note walk through the folders above the skill, and only those', () => {
    skill('daily', 'x')
    const root = join(vault, SKILLS_DIR, 'daily')
    expect(aboveRoot(vault, root)).toBe(true)
    expect(aboveRoot(join(vault, SKILLS_DIR), root)).toBe(true)
    expect(aboveRoot(root, root)).toBe(false)
    expect(aboveRoot(join(vault, SKILLS_DIR, 'weekly'), root)).toBe(false)
    expect(aboveRoot(join(vault, 'Notes'), root)).toBe(false)
  })
})
