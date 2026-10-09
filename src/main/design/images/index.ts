import { app } from 'electron'
import { join } from 'path'
import type { Artifact, Job } from '../../../shared/design'
import { getApiKey } from '../../apiKey'
import { openaiEndpoint } from '../../endpoints'
import { getDesignSettings } from '../../store'
import { registerProviders } from '../registry'
import { registerLocalResults, type LocalResultIndex } from '../recovery'
import { chosenModel } from './chosen'
import { MAX_RESULT_BYTES, OPENAI_IMAGES_ID } from './models'
import { OpenAIImages, sniffImage } from './openai'
import { ResultStore } from './results'

// Workstream B: the built-in OpenAI image provider, registered with
// registerProviders('built-in', ...). Called once at startup. It also
// registers its local result index (contract S2) and returns the store so
// startup reconciliation (../reconcile.ts) can tidy it.

export function registerImages(): ResultStore {
  const results = new ResultStore(join(app.getPath('userData'), 'design', 'openai-images'))
  const provider = new OpenAIImages({
    apiKey: () => getApiKey('openai'),
    endpoint: openaiEndpoint,
    model: () => chosenModel(getDesignSettings()),
    results
  })
  registerProviders('built-in', () => [provider])
  registerLocalResults(localImageIndex(results))
  return results
}

// The same checks submit() made before storing an image: within the size
// limit and really the image type recorded. An entry that fails them is
// never used as a result.
function valid(file: { mime: string; bytes: Uint8Array }): boolean {
  return file.bytes.byteLength <= MAX_RESULT_BYTES && sniffImage(file.bytes) === file.mime
}

// Contract S2: OpenAI images stored on this computer, by Custard's job id.
// Local files only: no network, no plugin, no resubmission.
export function localImageIndex(results: ResultStore): LocalResultIndex {
  return {
    providerId: OPENAI_IMAGES_ID,
    find: (correlationId) => {
      const r = results.findJob(correlationId)
      return r && valid(r.file) ? { remoteId: r.remoteId } : null
    },
    read: (remoteId) => {
      const r = results.get(remoteId)
      return r && valid(r.file) ? [r.file] : null
    }
  }
}

// Drops stored images Design no longer needs:
// - kept while a job for it (by remote id, or by job id when the job was
//   never linked) exists and that job's version is still pending;
// - removed once its job's version is settled (its files were copied into
//   the version) or gone (the user deleted it);
// - an image no job refers to at all is never removed automatically. That
//   happens only when the job records are lost (jobs.json unreadable and
//   moved aside, say), and such an image may have been paid for (contract
//   S2: potentially paid results are never pruned). Deleted chats remove
//   theirs at once (forgetImageJobs).
export function pruneImages(
  results: ResultStore,
  jobs: Job[],
  artifact: (chat: string, id: string) => Artifact | null
): string[] {
  const known = new Map<string, Job>()
  for (const j of jobs) {
    known.set(`job:${j.id}`, j)
    if (j.remoteId) known.set(`remote:${j.remoteId}`, j)
  }
  const pending = (j: Job): boolean =>
    artifact(j.requestedBy.conversationId, j.target.artifactId)?.versions.find(
      (x) => x.id === j.target.versionId
    )?.status === 'pending'
  const keep = new Set<string>()
  for (const e of results.entries()) {
    const j = known.get(`remote:${e.remoteId}`) ?? (e.job ? known.get(`job:${e.job}`) : undefined)
    if (!j || pending(j)) keep.add(e.remoteId)
  }
  return results.prune((id) => keep.has(id))
}

// A deleted chat's stored images go with it, linked or not.
export function forgetImageJobs(results: ResultStore, jobs: Job[]): void {
  const ids = new Set(jobs.map((j) => j.id))
  const remote = new Set(jobs.flatMap((j) => (j.remoteId ? [j.remoteId] : [])))
  for (const e of results.entries())
    if (remote.has(e.remoteId) || (e.job && ids.has(e.job))) results.remove(e.remoteId)
}
