import { caseSensitiveVault, resolveInVault } from '../memory/paths'
import type { Conversation } from '../../shared/chat'
import { grantFor, placeKind, type VaultGrant } from '../../shared/vaultGrants'
import { toVaultPath } from './read'

// Which vault reads put text in a chat that Custard can't vouch for. A note
// may hold anything the user ever pasted into it (a web page, an email, a
// plugin's output), and a model that reads it can be steered by it just as by
// a web result. So reading a note counts as outside text (see
// shared/outsideText), except for places whose text Custard or the user put
// there on purpose:
//   - Custard/Memory.md and the skills, which only the user (or Skills mode,
//     with an approval card) writes;
//   - folders the user granted, which are where Custard's own flows write.
// Captures and plugin activity are never exempt, even under a grant: they are
// written from chats that may have held outside text.
//
// This is a rule about where a note is, not a check of what it says. A granted
// folder that the user pastes web text into is trusted by this rule.

export function noteReadIsOutside(
  vault: string,
  path: unknown,
  grants: readonly VaultGrant[]
): boolean {
  let full: string
  try {
    full = resolveInVault(vault, path)
  } catch {
    // Refused paths bring no text back.
    return false
  }
  const rel = toVaultPath(vault, full)
  const kind = placeKind(rel)
  if (kind === 'own') return false
  if (kind === 'derived') return true
  return grantFor(grants, rel, caseSensitiveVault(vault)) === null
}

// A search hit comes from any note in the vault, so a search that found
// something counts. One that found nothing brought back no note text.
export function searchIsOutside(result: string): boolean {
  return !/^(No notes matched|There are \d+ matches, so page|This scan found \d+ matches, so page)/.test(
    result
  )
}

// Records on the chat why it holds text Custard can't vouch for.
export function noteOutside(c: Conversation, why: 'notes' | 'memory' | 'chats'): void {
  if (!c.outside?.includes(why)) (c.outside ??= []).push(why)
}
