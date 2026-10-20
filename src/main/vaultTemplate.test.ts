import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listSkills } from './vault'
import { addMissingStarterSkills, createStarterVault } from './vaultTemplate'

let parent = ''
beforeEach(() => void (parent = mkdtempSync(join(tmpdir(), 'custard-tpl-'))))
afterEach(() => rmSync(parent, { recursive: true, force: true }))

describe('the starter vault', () => {
  it('holds the authoring skills and the reference notes they point to', () => {
    const root = createStarterVault(parent)
    for (const skill of ['skill-authoring', 'automation-skill-authoring']) {
      const text = readFileSync(join(root, 'Custard/Skills', skill, 'SKILL.md'), 'utf8')
      expect(text).toMatch(new RegExp(`^---\\nname: ${skill}\\ndescription: .+\\n`))
    }
    // Custard reads them as skills, with the folder as the name.
    const found = listSkills(root).filter((k) => /authoring$/.test(k.folder))
    expect(found.map((k) => [k.folder, k.name]).sort()).toEqual([
      ['automation-skill-authoring', 'automation-skill-authoring'],
      ['skill-authoring', 'skill-authoring']
    ])
    expect(existsSync(join(root, 'Resources/Custard Skill Authoring.md'))).toBe(true)
    expect(existsSync(join(root, 'Resources/Custard Automation Skill Authoring.md'))).toBe(true)
  })
  it('holds the efficiency skills, each listed where it should be and small enough to read at once', () => {
    const root = createStarterVault(parent)
    const skills = listSkills(root)
    const modesOf = (folder: string): string[] | undefined =>
      skills.find((k) => k.folder === folder && k.name === folder)?.modes
    for (const global of [
      'lean-work',
      'chat-recall',
      'chat-housekeeping',
      'chat-guard',
      'focus-planner'
    ])
      expect(modesOf(global)).toEqual([])
    expect(modesOf('plugin-blueprint')).toEqual(['code'])
    expect(modesOf('custard-tuneup')).toEqual(['skills'])
    expect(modesOf('spotify-preferences')).toEqual(['chat'])
    for (const k of skills)
      expect(readFileSync(join(root, k.path), 'utf8').length).toBeLessThan(4_500)
  })
  it('adds missing skills and Custard notes to an existing vault, and never overwrites', () => {
    const vault = join(parent, 'mine')
    mkdirSync(join(vault, 'Resources'), { recursive: true })
    mkdirSync(join(vault, 'Custard/Skills/skill-authoring'), { recursive: true })
    writeFileSync(join(vault, 'Custard/Skills/skill-authoring/SKILL.md'), 'mine')
    writeFileSync(join(vault, 'Resources/Custard Time and Time Zones.md'), 'edited')
    writeFileSync(join(vault, 'Resources/Sourdough Bread.md'), 'bread')
    const added = addMissingStarterSkills(vault)
    expect(added).toContain('Custard/Skills/automation-skill-authoring/SKILL.md')
    expect(added).toContain('Resources/Custard Skill Authoring.md')
    expect(added).not.toContain('Custard/Skills/skill-authoring/SKILL.md')
    expect(added).not.toContain('Resources/Custard Time and Time Zones.md')
    expect(readFileSync(join(vault, 'Custard/Skills/skill-authoring/SKILL.md'), 'utf8')).toBe(
      'mine'
    )
    expect(readFileSync(join(vault, 'Resources/Custard Time and Time Zones.md'), 'utf8')).toBe(
      'edited'
    )
    // Only skills and Custard's own notes: not the rest of the template.
    expect(added.every((r) => /^(Custard\/Skills\/|Resources\/Custard )/.test(r))).toBe(true)
    expect(addMissingStarterSkills(vault)).toEqual([])
  })
})
