export const MEMORY_NOTE = 'Custard/Memory.md'

// One line of the activity list for Claude's changes to notes.
export type VaultEditEntry = {
  id: string
  time: number
  kind: 'create' | 'append' | 'edit'
  path: string
  // Who made it: a chat, or an automation.
  source: string
  change?: { removed: string; added: string; truncated: boolean }
  undoable: boolean
  undone: boolean
}

export type VaultInfo = { path: string; isObsidian: boolean; skills: string[] } | null

// A short human-readable line for a tool call, used in the chat UI.
export function toolLabel(name: string, input: unknown, labels?: Record<string, string>): string {
  const i = (input ?? {}) as Record<string, unknown>
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  switch (name) {
    case 'vault_search':
      return `Searched notes for "${str(i.query)}"${typeof i.page === 'number' && i.page > 1 ? ` (page ${i.page})` : ''}`
    case 'vault_list':
      return `Looked in ${str(i.folder) || 'the vault'}`
    case 'vault_read':
      return `Read ${str(i.path)}${typeof i.offset === 'number' && i.offset > 0 ? ' (continued)' : ''}`
    case 'vault_create_note':
      return `Created ${str(i.path)}`
    case 'vault_append':
      return str(i.path) === MEMORY_NOTE ? 'Saved to memory' : `Added to ${str(i.path)}`
    case 'vault_edit':
      return `Edited ${str(i.path)}`
    case 'fs_list':
      return `Looked in ${str(i.path) || 'the workspace'}`
    case 'fs_read':
      return `Read ${str(i.path)}`
    case 'fs_search':
      return `Searched files for "${str(i.query)}"`
    case 'fs_write':
      return `Wrote ${str(i.path)}`
    case 'fs_delete':
      return `Deleted ${str(i.path)}`
    case 'fs_rename':
      return `Renamed ${str(i.from)} to ${str(i.to)}`
    case 'widget_show':
      return `Showed the ${str(i.widget) || 'plugin'} widget`
    case 'widget_hide':
      return 'Hid the widget'
    case 'web_search':
      return `Searched the web for "${str(i.query).slice(0, 80)}"`
    case 'web_read': {
      let host = str(i.url)
      try {
        host = new URL(host).hostname
      } catch {
        // Keep it as written.
      }
      return `Read ${host}`
    }
    case 'reference_list':
      return `Looked in the plugin docs${str(i.path) ? `: ${str(i.path)}` : ''}`
    case 'reference_read':
      return `Read the plugin docs: ${str(i.path)}`
    case 'plugin_validate':
      return 'Validated the plugin'
    case 'plugin_test':
      return 'Ran the plugin tests'
    default: {
      const template = labels?.[name]
      if (template) return formatLabel(template, i)
      const plugin = /^([a-z][a-z0-9-]*)__(\w+)$/.exec(name)
      return plugin ? `${plugin[1]}: ${plugin[2].replace(/_/g, ' ')}` : name
    }
  }
}

// Plugin tool labels come from their manifests, e.g. 'Searched Spotify for "{query}"'.
export function formatLabel(template: string, input: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => {
    const v = input[k]
    return Array.isArray(v)
      ? String(v.length)
      : v === undefined || v === null
        ? ''
        : String(v).slice(0, 60)
  })
}
