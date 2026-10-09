import type { Job, RemoteStatus } from '../../shared/design'
import type { JobTracker } from './jobs'

// Startup reconciliation (stabilization 2.1). Runs once, after providers are
// registered, in this order:
//
// 1. Finish interrupted chat deletions. A chat is deleted before its Design
//    outputs and job records (index.ts, conversations:delete); if Custard
//    stopped in between, the jobs of a chat that no longer exists are
//    forgotten now, so nothing below can bring them back.
// 2. Link results Custard itself stored before it stopped
//    (JobTracker.reconcileLocal with a local-file lookup). No provider
//    network request, no plugin tool, no resubmission.
// 3. Tidy stored results Design no longer needs (images/index.ts), which
//    keeps anything a surviving job may still need, linked or not.
//
// A chat that can't be read is treated as existing: it is never deleted
// here by mistake.

export type ReconcileDeps = {
  jobs: Pick<JobTracker, 'list' | 'reconcileLocal'>
  // Custard's own stored result for a job, read from local files only.
  localResult: (job: Job) => { remoteId: string; status: RemoteStatus } | null
  chatExists: (conversationId: string) => boolean
  // The full deletion of a chat's Design data (designChatDeleted).
  forgetChat: (conversationId: string) => void
  prune?: () => string[]
}

export function reconcileDesign(d: ReconcileDeps): {
  forgotten: string[]
  recovered: Job[]
  pruned: string[]
} {
  const forgotten: string[] = []
  for (const chat of new Set(d.jobs.list().map((j) => j.requestedBy.conversationId))) {
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
  const recovered = d.jobs.reconcileLocal(d.localResult)
  const pruned = d.prune?.() ?? []
  return { forgotten, recovered, pruned }
}
