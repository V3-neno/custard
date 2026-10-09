import { app, BrowserWindow, dialog } from 'electron'
import { basename, isAbsolute, join, relative } from 'path'
import { handle, on, refuseContents } from '../../ipc'
import { attachments } from '../../attachments'
import { getConversation, getVaultPath } from '../../store'
import { listSkills } from '../../vault'
import { extensionTarget } from '../../modes/extensions'
import { protectedRoots } from '../../plugins'
import { design } from '..'
import { setDesignToolHandler } from '../tools'
import { skillChanges } from '../skills'
import { HtmlError } from './document'
import { exportVersion } from './export'
import { htmlHandler } from './handler'
import { checkVersion, hidePreview, isPreviewContents, previewBounds, showPreview } from './preview'
import { htmlSchema } from './schema'

// Workstream A: HTML outputs (design_html), the sandboxed preview
// (docs/design/SANDBOX.md), export and skill changes. Called once at startup.

const inside = (p: string, root: string): boolean => {
  const rel = relative(root, p)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

// Why an export target is refused: skills, plugin folders, Custard's own
// source, and Custard's app data (settings, chats, stored outputs).
export function exportRefusal(full: string): string | null {
  const vault = getVaultPath()
  const kind = extensionTarget(
    full,
    vault ?? join(app.getPath('userData'), '.no-vault'),
    protectedRoots()
  )
  if (kind === 'skill')
    return "That's inside the skills folder, which exports can't write to. Choose another place."
  if (kind === 'plugin')
    return "That's inside a plugin folder, which exports can't write to. Choose another place."
  if (kind === 'app' || inside(full, app.getPath('userData')))
    return "That's inside Custard's own files, which exports can't write to. Choose another place."
  return null
}

const canShow = (chat: string, artifactId: string, versionId: string): boolean => {
  const a = design().artifacts.get(chat, artifactId)
  const v = a?.versions.find((x) => x.id === versionId)
  return !!a && a.kind === 'html' && v?.status === 'succeeded'
}

export function registerHtml(): void {
  refuseContents(isPreviewContents)

  setDesignToolHandler(
    'design_html',
    htmlHandler({
      vault: getVaultPath,
      skills: (vault) =>
        listSkills(vault).filter((s) => !s.modes.length || s.modes.includes('design')),
      attachment: async (chat, idOrName) => {
        const all = getConversation(chat)?.attachments ?? []
        const byId = all.find((a) => a.id === idOrName)
        const byName = all.filter((a) => a.name === idOrName)
        if (!byId && byName.length > 1)
          throw new HtmlError(
            `More than one attached file is called ${idOrName}; nothing was used.`
          )
        const a = byId ?? byName[0]
        if (!a) throw new HtmlError(`There is no attached file "${idOrName}" in this chat.`)
        if (a.missing) throw new HtmlError(`${a.name} is no longer available.`)
        if (a.kind !== 'image') throw new HtmlError(`${a.name} isn't an image.`)
        const bytes = await attachments().read(chat, a)
        return { id: a.id, name: a.name, mime: a.mime, bytes: new Uint8Array(bytes) }
      },
      check: (chat, artifactId, versionId) =>
        checkVersion(design().artifacts, { chat, artifactId, versionId })
    }),
    htmlSchema
  )

  // The document's text, for the Code view.
  handle('design:source', (_, chat: string, artifactId: string, versionId: string) => {
    if (!canShow(String(chat), String(artifactId), String(versionId))) return null
    const bytes = design().artifacts.read(chat, artifactId, versionId, 'index.html')
    return bytes ? bytes.toString('utf8') : null
  })

  handle('design:skills', (_, chat: string, artifactId: string, versionId: string) => {
    const v = design()
      .artifacts.get(String(chat), String(artifactId))
      ?.versions.find((x) => x.id === versionId)
    const vault = getVaultPath()
    if (!v || !v.skills.length) return []
    if (!vault)
      return v.skills.map((s) => ({ path: s.path, name: s.name, state: 'missing' as const }))
    return skillChanges(vault, v.skills)
  })

  handle('design:export', async (e, chat: string, artifactId: string, versionId: string) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    return exportVersion(
      {
        artifacts: design().artifacts,
        pick: async ({ defaultName, folder, ext }) => {
          const opts: Electron.SaveDialogOptions = {
            title: folder ? 'Export as a new folder' : 'Export',
            defaultPath: join(app.getPath('downloads'), defaultName),
            buttonLabel: 'Export',
            ...(folder ? {} : { filters: [{ name: ext.toUpperCase(), extensions: [ext] }] })
          }
          const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
          return r.canceled || !r.filePath ? null : r.filePath
        },
        confirmReplace: async (path) => {
          const opts: Electron.MessageBoxOptions = {
            type: 'question',
            buttons: ['Replace', 'Cancel'],
            defaultId: 1,
            cancelId: 1,
            message: `Replace ${basename(path)}?`,
            detail: 'A file with that name already exists there.'
          }
          const r = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
          return r.response === 0
        },
        refuse: exportRefusal
      },
      String(chat),
      String(artifactId),
      String(versionId)
    )
  })

  // One preview at a time, in the app window that asked.
  handle(
    'design:preview:show',
    async (e, p: { chat: string; artifactId: string; versionId: string; width: number }) => {
      const win = BrowserWindow.fromWebContents(e.sender)
      if (!win || !p || !canShow(String(p.chat), String(p.artifactId), String(p.versionId))) {
        hidePreview()
        return
      }
      const width = Number.isFinite(p.width) ? Math.max(0, Math.min(3840, Math.round(p.width))) : 0
      await showPreview(
        design().artifacts,
        win,
        { chat: p.chat, artifactId: p.artifactId, versionId: p.versionId },
        width,
        (s) => !e.sender.isDestroyed() && e.sender.send('design:preview:state', s)
      )
    }
  )
  on('design:preview:bounds', (_, r: { x: number; y: number; width: number; height: number }) => {
    if (!r || ![r.x, r.y, r.width, r.height].every(Number.isFinite)) return
    previewBounds(r)
  })
  handle('design:preview:hide', () => hidePreview())
}
