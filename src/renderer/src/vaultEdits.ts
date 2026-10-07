import { createContext } from 'react'
import type { VaultEdit } from '../../shared/chat'

// This chat's note edits, and how to undo one (see components/chat/MessageView).
export const VaultEditsContext = createContext<{
  edits: Record<string, VaultEdit>
  undo: (callId: string) => Promise<{ ok: boolean; message: string }>
}>({ edits: {}, undo: async () => ({ ok: false, message: '' }) })
