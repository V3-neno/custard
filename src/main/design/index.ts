import { app, protocol, type WebContents } from 'electron'
import { join } from 'path'
import {
  MEDIA_SCHEME,
  type Artifact,
  type ArtifactSummary,
  type CapabilityReport,
  type DesignEvent,
  type Job,
  type MediaReference,
  type ProviderListing
} from '../../shared/design'
import { attachments } from '../attachments'
import { getApiKey } from '../apiKey'
import { handle } from '../ipc'
import { getChatSettings, getConversation, getDesignSettings, setDesignSettings } from '../store'
import { providerOf } from '../../shared/chat'
import { discoverCapabilities } from './capabilities'
import { JobTracker, JobError } from './jobs'
import { mediaProvider, mediaProviders } from './registry'
import { ArtifactStore, JobStore } from './store'
import { jobAction, type DesignService } from './tools'
import { authorizations } from './authorization'
import { registerHtml } from './html'
import { forgetImageJobs, pruneImages, registerImages } from './images'
import type { ResultStore } from './images/results'
import { reconcileDesign } from './reconcile'
import { registerPluginMedia } from './plugin-media'

// Design's main-process service: stored outputs, jobs, settings, the
// capability report, and the read-only scheme the app window uses to show
// stored images and video. Integration-owned; workstreams add to it through
// the registry (providers) and tool handlers (tools.ts).

// Before the app is ready: a standard, secure scheme so <img> and <video>
// in the app window can use it. Registered on the app window's (default)
// session only; plugin, widget and preview sessions don't have it.
protocol.registerSchemesAsPrivileged([
  { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, stream: true } }
])

// A reference's bytes: only a file attached in the job's own chat, checked
// against the hash taken when it was attached.
async function readReference(job: Job, ref: MediaReference): Promise<Uint8Array> {
  const chat = job.requestedBy.conversationId
  const a = getConversation(chat)?.attachments?.find((x) => x.id === ref.attachmentId)
  if (!a || a.missing) throw new Error(`${ref.name} is no longer in this chat.`)
  // The approved content only (contract S3): the record must still be the
  // one approved, and read() checks the bytes against it.
  if (a.sha256 !== ref.sha256) throw new Error(`${ref.name} changed since it was approved.`)
  return new Uint8Array(await attachments().read(chat, a))
}

let service: DesignService | null = null
let jobStore: JobStore | null = null
const listeners = new Set<WebContents>()

export function design(): DesignService {
  if (service) return service
  const root = join(app.getPath('userData'), 'design')
  const jobs = (jobStore = new JobStore(join(root, 'jobs.json')))
  service = {
    artifacts: new ArtifactStore(root),
    jobs: new JobTracker(
      { provider: mediaProvider, save: (j) => jobs.save(j), read: readReference },
      jobs.load()
    ),
    providers: mediaProviders,
    settings: getDesignSettings,
    failures: [],
    emit: (e: DesignEvent) => {
      for (const wc of listeners) if (!wc.isDestroyed()) wc.send('design:event', e)
    }
  }
  return service
}

const summary = (a: Artifact): ArtifactSummary => ({
  id: a.id,
  name: a.name,
  kind: a.kind,
  selected: a.selected,
  versions: a.versions.length,
  latest: a.versions[a.versions.length - 1].status,
  updatedAt: Math.max(...a.versions.map((v) => v.createdAt))
})

export function capabilityReport(): CapabilityReport {
  const chat = getChatSettings()
  const provider = providerOf(chat.model)
  return discoverCapabilities({
    chat: { provider, model: chat.model, hasKey: getApiKey(provider) !== null },
    design: getDesignSettings(),
    providers: mediaProviders().map((p) => p.info()),
    failures: design().failures
  })
}

// A chat's outputs and job records go with it. Jobs already at a provider
// keep running there; deleting here can't cancel them.
let imageResults: ResultStore | null = null

export function designChatDeleted(chat: string): void {
  const s = design()
  // Stored provider results of the chat's jobs, linked or not, go too.
  if (imageResults) forgetImageJobs(imageResults, s.jobs.list(chat))
  s.artifacts.deleteChat(chat)
  s.jobs.forgetChat(chat)
  authorizations.forgetChat(chat)
  jobStore?.deleteChat(chat)
}

const MEDIA_TYPES = /^(image\/(png|jpeg|webp|gif)|video\/(mp4|webm))$/

export function registerDesignHandlers(): void {
  registerHtml()
  const images = registerImages()
  registerPluginMedia()
  // Startup reconciliation (reconcile.ts), before any handler can run:
  // interrupted chat deletions, then results Custard stored before it
  // stopped, then tidying. Local files only: no provider request, no plugin
  // tool, no resubmission.
  imageResults = images
  const s = design()
  try {
    reconcileDesign({
      service: s,
      chatExists: (chat) => getConversation(chat) !== null,
      forgetChat: designChatDeleted,
      prune: () => pruneImages(images, s.jobs.list(), (c, a) => s.artifacts.get(c, a))
    })
  } catch (err) {
    console.error('Design: startup reconciliation failed:', err)
  }
  handle('design:subscribe', (e) => {
    listeners.add(e.sender)
    e.sender.once('destroyed', () => listeners.delete(e.sender))
  })
  handle('design:list', (_, chat: string) => design().artifacts.list(chat).map(summary))
  handle('design:get', (_, chat: string, artifactId: string) =>
    design().artifacts.get(chat, artifactId)
  )
  handle('design:select', (_, chat: string, artifactId: string, versionId: string) => {
    const a = design().artifacts.get(chat, artifactId)
    if (!a || !a.versions.some((v) => v.id === versionId && v.status === 'succeeded'))
      throw new Error('That version can’t be shown.')
    const next = { ...a, selected: versionId }
    design().artifacts.save(next)
    design().emit({ type: 'artifact', conversationId: chat, artifact: next })
    return next
  })
  handle('design:jobs', (_, chat: string) => design().jobs.list(chat))
  handle('design:job', async (_, chat: string, action: 'check' | 'cancel' | 'stop', id: string) => {
    if (action !== 'check' && action !== 'cancel' && action !== 'stop')
      throw new Error('Unknown action.')
    try {
      // A cancel from the workspace is the user's own click, confirmed in
      // the workspace (Thread 1 adds that confirmation).
      return await jobAction(design(), chat, action, id, undefined, async () => true)
    } catch (err) {
      if (err instanceof JobError) return { error: err.message }
      throw err
    }
  })
  handle('design:settings:get', () => getDesignSettings())
  handle('design:settings:set', (_, s: unknown) => setDesignSettings(s))
  handle('design:capabilities', () => capabilityReport())
  // Every registered provider, ready or not, for the Design settings tab.
  handle('design:providers', (): ProviderListing[] =>
    mediaProviders().map((p) => {
      const i = p.info()
      let models: ProviderListing['models']
      try {
        models = p.models?.()
      } catch {
        models = undefined
      }
      return {
        id: i.id,
        name: i.name,
        source: i.source,
        state: i.state,
        ...(i.needs ? { needs: i.needs } : {}),
        operations: i.capabilities.map((c) => c.operation),
        ...(models ? { models } : {})
      }
    })
  )

  // custard-media://<chat>/<artifact>/<version>/<file path>: only files
  // recorded on a version, only image and video types, checked against their
  // recorded hash.
  protocol.handle(MEDIA_SCHEME, (req) => {
    const url = new URL(req.url)
    const [artifact, version, ...rest] = url.pathname
      .split('/')
      .filter(Boolean)
      .map(decodeURIComponent)
    const chat = url.hostname
    try {
      const f = design().artifacts.file(chat, artifact ?? '', version ?? '', rest.join('/'))
      if (!f || !MEDIA_TYPES.test(f.record.mime)) return new Response(null, { status: 404 })
      const bytes = design().artifacts.read(chat, artifact, version, f.record.path)
      if (!bytes) return new Response(null, { status: 404 })
      return new Response(new Uint8Array(bytes), {
        headers: {
          'content-type': f.record.mime,
          'x-content-type-options': 'nosniff',
          'cache-control': 'no-store'
        }
      })
    } catch {
      return new Response(null, { status: 404 })
    }
  })
}
