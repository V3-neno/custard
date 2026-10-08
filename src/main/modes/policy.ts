import type { Mode } from '../../shared/chat'
import type { Workspace } from '../../shared/plugins'

// What each mode may do, enforced by the app rather than asked of the model.
// Every tool the model is offered, and every call it makes, goes through
// these rules (see chat.ts): a tool kind a mode doesn't allow is never
// offered, and a call to one is refused before anything runs or any approval
// is asked for. Nothing a skill, a note, a plugin result or the model says
// changes them: they depend only on the chat's mode and workspace.

// What a tool can do, by where it comes from.
export type ToolKind =
  | 'vault-read' // vault_search, vault_list, vault_read
  | 'vault-write' // vault_create_note (vault_append is turned off)
  | 'web' // web_search, web_read
  | 'plugin' // an enabled plugin's tool, <plugin>__<tool>
  | 'widget' // widget_show, widget_hide
  | 'workspace' // Code mode's file tools
  | 'unknown' // anything else: never allowed

// Extensions are plugins (code that adds capabilities) and skills
// (instructions in the vault's Custard/Skills folder).
export type ModePolicy = {
  mode: Mode
  tools: ReadonlySet<ToolKind>
  // May write into the skills folder (through vault_create_note).
  authorSkills: boolean
  // May change plugin source (Code's Plugins workspace, through its file
  // tools). No mode may write plugin files through the vault tools.
  authorPlugins: boolean
}

const USE: ToolKind[] = ['vault-read', 'vault-write', 'web', 'plugin', 'widget']

export function modePolicy(mode: Mode, workspace?: Workspace): ModePolicy {
  switch (mode) {
    // Chat and Design use extensions; they never make or change them.
    case 'chat':
    case 'design':
      return { mode, tools: new Set(USE), authorSkills: false, authorPlugins: false }
    case 'skills':
      return { mode, tools: new Set(USE), authorSkills: true, authorPlugins: false }
    case 'code': {
      // General Code gets no plugin tools: only the Plugins workspace does.
      const internal = workspace?.kind === 'internal'
      const tools: ToolKind[] = ['vault-read', 'vault-write', 'web', 'workspace']
      if (internal) tools.push('plugin', 'widget')
      return { mode, tools: new Set(tools), authorSkills: true, authorPlugins: internal }
    }
  }
}

export type ToolSources = {
  isWorkspace: (name: string) => boolean
  isWeb: (name: string) => boolean
}

export function toolKind(name: string, sources: ToolSources): ToolKind {
  if (/^vault_(search|list|read)$/.test(name)) return 'vault-read'
  if (/^vault_(create_note|append)$/.test(name)) return 'vault-write'
  if (sources.isWorkspace(name)) return 'workspace'
  if (sources.isWeb(name)) return 'web'
  if (name === 'widget_show' || name === 'widget_hide') return 'widget'
  if (/^[a-z][a-z0-9-]{1,30}__[a-z][a-z0-9_]{0,40}$/.test(name)) return 'plugin'
  return 'unknown'
}

const MODE_NAMES: Record<Mode, string> = {
  chat: 'Chat',
  code: 'Code',
  design: 'Design',
  skills: 'Skills'
}
export const modeName = (m: Mode): string => MODE_NAMES[m]

// Why a call is refused in this mode, or null when the mode allows its kind.
export function refuseKind(policy: ModePolicy, name: string, kind: ToolKind): string | null {
  if (policy.tools.has(kind)) return null
  return `${name} can't be used in ${modeName(policy.mode)} mode, so nothing was done.`
}
