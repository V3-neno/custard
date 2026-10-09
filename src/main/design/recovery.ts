import type { Job } from '../../shared/design'
import type { JobTracker } from './jobs'

// Startup reconciliation (stabilization 2.1). Runs once, after providers are
// registered, in this order:
//
// 1. Finish interrupted chat deletions. A chat is deleted before its Design
//    outputs and job records (index.ts, conversations:delete); if Custard
//    stopped in between, the jobs of a chat that no longer exists are
//    forgotten now, so nothing below can bring them back.
// 2. Link results stored locally before Custard stopped (JobTracker.recover).
//    Lookups only: nothing is sent, retried or charged.
// 3. Tidy stored results Design no longer needs (images/index.ts), which
//    keeps anything a surviving job may still need, linked or not.
//
// A chat that can't be read is treated as existing: it is never deleted
// here by mistake.

export type ReconcileDeps = {
  jobs: Pick<JobTracker, 'list' | 'recover'>
  chatExists: (conversationId: string) => boolean
  // The full deletion of a chat's Design data (designChatDeleted).
  forgetChat: (conversationId: string) => void
  prune?: () => string[]
}

export async function reconcileDesign(
  d: ReconcileDeps
): Promise<{ forgotten: string[]; recovered: Job[]; pruned: string[] }> {
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
  const recovered = await d.jobs.recover()
  const pruned = d.prune?.() ?? []
  return { forgotten, recovered, pruned }
}
