import { existsSync } from 'fs'
import { join } from 'path'

// Obsidian's own download page. Custard can't ship Obsidian: its terms forbid
// distributing the app (https://obsidian.md/terms).
export const OBSIDIAN_DOWNLOAD = 'https://obsidian.md/download'

// The link that opens a vault in Obsidian. Obsidian looks for the vault that
// holds `path` (https://obsidian.md/help/uri), so it points at the starter
// vault's Home note when there is one. Whether Obsidian also opens a folder it
// has never opened as a vault is unverified.
export function obsidianOpenUrl(vault: string): string {
  const home = join(vault, 'Home.md')
  return 'obsidian://open?path=' + encodeURIComponent(existsSync(home) ? home : vault)
}
