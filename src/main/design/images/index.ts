import { app } from 'electron'
import { join } from 'path'
import type { Artifact, Job, RemoteStatus } from '../../../shared/design'
import { getApiKey } from '../../apiKey'
import { openaiEndpoint } from '../../endpoints'
import { getDesignSettings } from '../../store'
import { registerProviders } from '../registry'
import { chosenModel } from './chosen'
import { OPENAI_IMAGES_ID } from './models'
import { OpenAIImages, remoteIdFor, sniffImage } from './openai'
import { ResultStore } from './results'

// Workstream B: the built-in OpenAI image provider, registered with
// registerProviders('built-in', ...). Called once at startup; returns the
// store so startup reconciliation (../recovery.ts) can prune it after
// recovering jobs.

export function registerImages(): ResultStore {
  const results = new ResultStore(join(app.getPath('userData'), 'design', 'openai-images'))
  const provider = new OpenAIImages({
    apiKey: () => getApiKey('openai'),
    endpoint: openaiEndpoint,
    model: () => chosenModel(getDesignSettings()),
    results
  })
  registerProviders('built-in', () => [provider])
  return results
}

// Startup, local only (stabilization 2.1, Amendment 2): the image stored on
// this computer for a job that was being sent when Custard stopped, before
// the job recorded it. Reads local files; no network, no plugin, no resend.
export function localImageResult(
  results: ResultStore
): (job: Job) => { remoteId: string; status: RemoteStatus } | null {
  return (job) => {
    if (job.providerId !== OPENAI_IMAGES_ID) return null
    const remoteId = remoteIdFor(job.idempotencyKey)
    if (!results.recoverLocal(remoteId, job.id)) return null
    // The same check submit() made before storing it: the bytes are the
    // image type recorded, or the entry isn't used.
    const stored = results.get(remoteId)
    if (!stored || sniffImage(stored.file.bytes) !== stored.meta.mime) return null
    return { remoteId, status: { state: 'completed' } }
  }
}

// Drops stored images Design no longer needs. One is kept while a job for it
// still exists and that job's version is still pending (its image hasn't been
// written to the version yet). The job is matched by its recorded remote id
// or, when Custard stopped before recording one, by the id derived from it, so
// a paid image whose job wasn't linked yet is never pruned as an orphan.
export function pruneImages(
  results: ResultStore,
  jobs: Job[],
  artifact: (chat: string, id: string) => Artifact | null
): string[] {
  const waiting = new Set<string>()
  for (const j of jobs) {
    if (j.providerId !== OPENAI_IMAGES_ID && !j.remoteId?.startsWith('oai-img-')) continue
    const v = artifact(j.requestedBy.conversationId, j.target.artifactId)?.versions.find(
      (x) => x.id === j.target.versionId
    )
    if (v?.status !== 'pending') continue
    if (j.remoteId) waiting.add(j.remoteId)
    waiting.add(remoteIdFor(j.idempotencyKey))
  }
  return results.prune((id) => waiting.has(id))
}
