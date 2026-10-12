import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import type { SkillEntry, SkillText } from '../shared/vault'
import { resolveInVault } from './memory/paths'
import { SKILLS_DIR } from './modes/extensions'
import { listSkills } from './vault'

// The Skills hub's view of Custard/Skills. It only reads: skills are added and
// improved in a Skills chat, which asks before writing as it always has.

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
