import { app, BrowserWindow, dialog } from 'electron'
import { join } from 'path'
import { handle } from '../ipc'
import {
  ATTACHMENT_LIMITS,
  TEXT_EXTENSIONS,
  type Attachment,
  type AttachResult
} from '../../shared/attachments'
import { AttachmentStore } from './store'
import { conversationIds } from '../store'

// Attachments for Chat mode: picked, pasted or dropped files, checked and
// copied into app data (see store.ts). Drafts nobody sent are cleared after a
// day, and files of chats that no longer exist at startup.

const DRAFT_MAX_AGE = 86_400_000

let store: AttachmentStore | null = null
export const attachments = (): AttachmentStore =>
  (store ??= new AttachmentStore(join(app.getPath('userData'), 'attachments')))

const MAX_BYTES = Math.max(
  ATTACHMENT_LIMITS.imageBytes,
  ATTACHMENT_LIMITS.pdfBytes,
  ATTACHMENT_LIMITS.textBytes
)

export function registerAttachmentHandlers(): void {
  void attachments()
    .sweepDrafts(DRAFT_MAX_AGE)
    .then(() => attachments().sweepChats(new Set(conversationIds())))
    .catch((err) => console.error('Attachment cleanup:', err))
  handle('attachments:pick', async (e, draft: string) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const options = {
      title: 'Attach files',
      properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'>,
      filters: [
        {
          name: 'Images, PDFs and text',
          extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf', ...TEXT_EXTENSIONS]
        },
        { name: 'All files', extensions: ['*'] }
      ]
    }
    const r = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (r.canceled) return []
    const out: AttachResult[] = []
    for (const p of r.filePaths.slice(0, ATTACHMENT_LIMITS.perMessage + 1))
      out.push(await attachments().addPath(draft, p))
    return out
  })
  // Pasted or dropped files arrive as bytes; the renderer checks the size
  // first, and this checks it again.
  handle('attachments:add', (_, draft: string, name: string, bytes: Uint8Array) => {
    if (!(bytes instanceof Uint8Array) || bytes.length > MAX_BYTES)
      return {
        ok: false,
        name: String(name).slice(0, 120),
        error: `Attached files can be up to ${MAX_BYTES / 1_000_000} MB.`
      }
    return attachments().addBytes(draft, String(name), Buffer.from(bytes))
  })
  handle('attachments:remove', (_, draft: string, id: string) =>
    attachments().removeDraft(draft, id)
  )
  handle('attachments:discard', (_, draft: string) => attachments().discardDraft(draft))
  handle('attachments:list', (_, draft: string) => attachments().listDraft(draft))
  handle(
    'attachments:preview',
    (
      _,
      where: { chat?: string; draft?: string },
      a: Pick<Attachment, 'id' | 'ext' | 'mime' | 'kind'>
    ) => attachments().dataUrl(where, a)
  )
}
