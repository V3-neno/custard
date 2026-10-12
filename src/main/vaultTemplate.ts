import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'

// The starter vault in /vault-template, bundled into the app at build time.
const PREFIX = '../../vault-template/'
const templateFiles = import.meta.glob('../../vault-template/**/*.md', {
  query: '?raw',
  import: 'default',
  eager: true
}) as Record<string, string>

// Obsidian settings so new notes go to Inbox and the Templates and Daily notes
// core plugins point at the right folders once they're turned on.
const obsidianConfig: Record<string, unknown> = {
  'app.json': { newFileLocation: 'folder', newFileFolderPath: 'Inbox' },
  'templates.json': { folder: 'Templates' },
  'daily-notes.json': { folder: 'Daily', template: 'Templates/Daily' }
}

export const STARTER_VAULT_NAME = 'Custard Brain'

export function createStarterVault(parent: string): string {
  const root = join(parent, STARTER_VAULT_NAME)
  if (existsSync(root) && readdirSync(root).length > 0) {
    throw new Error(`"${STARTER_VAULT_NAME}" already exists in that folder. Choose another folder.`)
  }
  for (const [key, content] of Object.entries(templateFiles)) {
    const file = join(root, key.slice(PREFIX.length))
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, content, { flag: 'wx' })
  }
  mkdirSync(join(root, '.obsidian'), { recursive: true })
  for (const [name, value] of Object.entries(obsidianConfig)) {
    writeFileSync(join(root, '.obsidian', name), JSON.stringify(value, null, 2))
  }
  return root
}

// Copies the starter skills, and the Custard reference notes the skills point
// to (Resources/Custard *.md), that an existing vault doesn't have yet. Never
// overwrites: files that exist are left alone, so a note the user edited stays
// and a newer version of one they already have is not delivered.
const STARTER_SKILL_FILES = /^(Custard\/Skills\/|Resources\/Custard [^/]+\.md$)/

export function addMissingStarterSkills(vault: string): string[] {
  const added: string[] = []
  for (const [key, content] of Object.entries(templateFiles)) {
    const rel = key.slice(PREFIX.length)
    if (!STARTER_SKILL_FILES.test(rel)) continue
    const file = join(vault, rel)
    if (existsSync(file)) continue
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, content, { flag: 'wx' })
    added.push(rel)
  }
  return added
}

// Folder names of the starter skills.
export function starterSkillFolders(): Set<string> {
  const names = new Set<string>()
  for (const key of Object.keys(templateFiles)) {
    const m = /^Custard\/Skills\/([^/]+)\//.exec(key.slice(PREFIX.length))
    if (m) names.add(m[1])
  }
  return names
}
