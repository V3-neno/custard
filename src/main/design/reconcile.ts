import type { Job } from '../../shared/design'
import type { JobTracker } from './jobs'
import { localResults } from './recovery'
import { settleJobVersion, type DesignService } from './tools'

// Startup reconciliation (stabilization 2.1, contract S2). Runs once, before
// any IPC handler is registered, on Custard's own files only: no provider
// network request, no plugin tool, no resubmission. In order:
//
// 1. Finish interrupted chat deletions. A chat is deleted before its Design
//    outputs and job records (index.ts, conversations:delete); if Custard
//    stopped in between, the Design data of a chat that no longer exists is
//    deleted now, so nothing below can bring it back.
// 2. Link jobs to results Custard's built-in stores saved before it stopped
//    (JobTracker.linkLocal; the constructor already did this, this catches
//    a store registered after the tracker was made).
// 3. Fill pending versions from those local results, through the same save
//    path as a normal check (tools.ts settleJobVersion).
// 4. Tidy stored results (images/index.ts pruneImages).
//
// A chat that can't be read is treated as existing: never deleted here by
// mistake. Remote checks stay the user's explicit action.

export type ReconcileDeps = {
  service: Pick<DesignService, 'artifacts' | 'emit'> & {
    jobs: Pick<JobTracker, 'list' | 'linkLocal'>
  }
  chatExists: (conversationId: string) => boolean
  // The full deletion of a chat's Design data (designChatDeleted).
  forgetChat: (conversationId: string) => void
  prune?: () => string[]
}

export function reconcileDesign(d: ReconcileDeps): {
  forgotten: string[]
  linked: Job[]
  filled: string[]
  pruned: string[]
} {
  const s = d.service
  const forgotten: string[] = []
  for (const chat of new Set(s.jobs.list().map((j) => j.requestedBy.conversationId))) {
    let exists = true
    try {
      exists = d.chatExists(chat)
    } catch {
      exists = true
    }
    if (exists) continue
    d.forgetChat(chat)
    forgotten.push(chat)
  }
  const linked = s.jobs.linkLocal()
  const filled: string[] = []
  for (const job of s.jobs.list()) {
    if (job.state !== 'completed' || !job.remoteId) continue
    const chat = job.requestedBy.conversationId
    const v = s.artifacts
      .get(chat, job.target.artifactId)
      ?.versions.find((x) => x.id === job.target.versionId)
    if (v?.status !== 'pending') continue
    const files = localResults(job.providerId)?.read(job.remoteId)
    if (!files?.length) continue
    try {
      settleJobVersion(s, chat, job, files)
      filled.push(job.id)
    } catch (err) {
      // Left pending; a Check can try again.
      console.error('Design: restoring a saved result failed:', err)
    }
  }
  const pruned = d.prune?.() ?? []
  return { forgotten, linked, filled, pruned }
}
