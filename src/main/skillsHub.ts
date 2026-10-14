import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import type { SkillEntry, SkillText } from '../shared/vault'
import { resolveInVault } from './memory/paths'
import { SKILLS_DIR } from './modes/extensions'
import { listSkills } from './vault'
import { pluginIdFrom } from '../shared/plugins'
import { createNote } from './memory/write'

// The Skills hub's view of Custard/Skills. It reads, and makes a new skill's
// folder with a draft SKILL.md when the user asks (Add a skill, or Yes on a
// hub chat's offer); the skill itself is written in its workspace chat.

const MAX_FOLDERS = 500
const MAX_FILES = 20
// Bigger than any sensible skill; the hub says when it shows only the start.
export const MAX_SKILL_CHARS = 200_000

const FOLDER = /^[^\\/:\0]+$/

function listFiles(vault: string, folder: string): { files: string[]; more: number } {
  const files: string[] = []
  let more = 0
  const walk = (rel: string, depth: number): void => {
    let entries: import('fs').Dirent[]
    try {
      entries = readdirSync(join(vault, rel), { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith('.')) continue
      const path = `${rel}/${e.name}`
      if (e.isDirectory()) {
        if (depth < 3) walk(path, depth + 1)
      } else if (path !== `${SKILLS_DIR}/${folder}/SKILL.md`) {
        if (files.length < MAX_FILES) files.push(path)
        else more++
      }
    }
  }
  walk(`${SKILLS_DIR}/${folder}`, 0)
  return { files, more }
}

export function skillEntries(vault: string, starters: Set<string>): SkillEntry[] {
  const dir = join(vault, SKILLS_DIR)
  if (!existsSync(dir)) return []
  let folders: string[]
  try {
    folders = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .slice(0, MAX_FOLDERS)
  } catch {
    return []
  }
  const usable = new Map(listSkills(vault).map((s) => [s.folder, s]))
  return folders
    .map((folder): SkillEntry => {
      const path = `${SKILLS_DIR}/${folder}/SKILL.md`
      const skill = usable.get(folder)
      let updatedAt: number | null = null
      let exists = false
      try {
        const st = statSync(join(vault, path))
        exists = st.isFile()
        updatedAt = st.mtimeMs
      } catch {
        // No SKILL.md.
      }
      const { files, more } = listFiles(vault, folder)
      return {
        folder,
        name: skill?.name ?? folder,
        description: skill?.description ?? '',
        modes: skill?.modes ?? [],
        path,
        files,
        moreFiles: more,
        starter: starters.has(folder),
        updatedAt,
        ...(skill
          ? {}
          : {
              problem: exists
                ? "SKILL.md has no description in its frontmatter, so chats don't see this skill."
                : "This folder has no SKILL.md, so chats don't see it."
            })
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function readSkill(vault: string, folder: unknown): SkillText {
  if (typeof folder !== 'string' || !FOLDER.test(folder) || folder.startsWith('.'))
    throw new Error('That is not a skill folder.')
  const path = `${SKILLS_DIR}/${folder}/SKILL.md`
  const full = resolveInVault(vault, path)
  if (!existsSync(full)) throw new Error(`${path} doesn't exist.`)
  const text = readFileSync(full, 'utf8')
  return {
    path,
    text: text.length > MAX_SKILL_CHARS ? text.slice(0, MAX_SKILL_CHARS) : text,
    truncated: text.length > MAX_SKILL_CHARS
  }
}

// Whether `folder` is a skill folder in Custard/Skills (with or without its
// SKILL.md yet).
export function skillExists(vault: string, folder: unknown): boolean {
  if (typeof folder !== 'string' || !FOLDER.test(folder) || folder.startsWith('.')) return false
  try {
    return statSync(resolveInVault(vault, `${SKILLS_DIR}/${folder}`, false)).isDirectory()
  } catch {
    return false
  }
}

// A new skill: its folder, named from `name` like a plugin's id, and a draft
// SKILL.md that loads only in Skills mode until it is written. Never
// replaces anything that is there. Returns the folder.
export function createSkill(vault: string, name: string): string {
  const clean = name
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, 60)
  const dir = join(vault, SKILLS_DIR)
  let taken: string[] = []
  try {
    taken = readdirSync(dir).map((f) => f.toLowerCase())
  } catch {
    // No skills folder yet.
  }
  const folder = pluginIdFrom(clean, new Set(taken))
  if (!folder)
    throw new Error(
      'Use at least one letter from a to z in the name; Custard makes the folder name from it.'
    )
  const text = [
    '---',
    `name: ${JSON.stringify(clean)}`,
    'description: "Draft. Say in one sentence when to use this skill."',
    'modes: skills',
    '---',
    '',
    `# ${clean}`,
    '',
    'A draft. Write this skill with Custard in its workspace in Skills mode, then set the description and the modes it is for (leave `modes` out for every mode).'
  ].join('\n')
  createNote(vault, resolveInVault(vault, `${SKILLS_DIR}/${folder}/SKILL.md`), text)
  return folder
}
