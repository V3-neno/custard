import { deleteConversation, oldChatIds } from './store'

// Deleting a chat: its file, then its widget records, its attached files and
// its Design outputs, as conversations:delete has done since before B3.
// Nothing in the vault (memory, notes in Custard/Chats, captures), usage
// totals or settings. The cleanups are passed in so this can be tested
// without Electron.
export type ChatCleanup = {
  // Sets the chat's widget records to none (widgets().conversationDeleted).
  widgets: (id: string) => void
  // Removes the chat's folder of attached files (attachments().deleteChat).
  attachments: (id: string) => Promise<void>
  // Removes its Design outputs, jobs and stored results (designChatDeleted).
  design: (id: string) => void
}

export async function deleteChat(id: string, c: ChatCleanup): Promise<void> {
  deleteConversation(id)
  c.widgets(id)
  await c.attachments(id)
  c.design(id)
}

// Every old chat (store.ts), each deleted the way Delete deletes one. One
// that fails is left for the next try; the rest still go. Returns how many
// were deleted.
export async function deleteOldChats(
  c: ChatCleanup
): Promise<{ deleted: number; failed: string[] }> {
  let deleted = 0
  const failed: string[] = []
  for (const id of oldChatIds())
    try {
      await deleteChat(id, c)
      deleted++
    } catch (err) {
      console.error(`Deleting old chat ${id}:`, err)
      failed.push(id)
    }
  return { deleted, failed }
}
