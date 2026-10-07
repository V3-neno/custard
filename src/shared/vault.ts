export const MEMORY_NOTE = 'Custard/Memory.md'

export type VaultInfo = { path: string; isObsidian: boolean } | null

// A short human-readable line for a vault tool call, used in the chat UI.
export function toolLabel(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  switch (name) {
    case 'vault_search':
      return `Searched notes for "${str(i.query)}"`
    case 'vault_list':
      return `Looked in ${str(i.folder) || 'the vault'}`
    case 'vault_read':
      return `Read ${str(i.path)}`
    case 'vault_create_note':
      return `Created ${str(i.path)}`
    case 'vault_append':
      return str(i.path) === MEMORY_NOTE ? 'Saved to memory' : `Added to ${str(i.path)}`
    default:
      return name
  }
}
