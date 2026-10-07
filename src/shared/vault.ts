export const MEMORY_NOTE = 'Custard/Memory.md'

export type VaultInfo = { path: string; isObsidian: boolean; skills: string[] } | null

// A short human-readable line for a tool call, used in the chat UI.
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
    case 'spotify_search':
      return `Searched Spotify for "${str(i.query)}"`
    case 'spotify_now_playing':
      return 'Checked what is playing'
    case 'spotify_devices':
      return 'Listed Spotify devices'
    case 'spotify_add_to_queue': {
      const n = Array.isArray(i.uris) ? i.uris.length : 0
      return `Spotify queue: ${n} ${n === 1 ? 'track' : 'tracks'}`
    }
    case 'spotify_open':
      return 'Opened Spotify'
    case 'spotify_transfer_playback':
      return i.play === true ? 'Started playback on a device' : 'Moved playback to a device'
    default:
      return name
  }
}
