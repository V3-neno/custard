import { app } from 'electron'
import { join } from 'path'
import { getApiKey } from '../../apiKey'
import { openaiEndpoint } from '../../endpoints'
import { getDesignSettings } from '../../store'
import { design } from '..'
import { registerProviders } from '../registry'
import { chosenModel } from './chosen'
import { OpenAIImages } from './openai'
import { ResultStore } from './results'

// Workstream B: the built-in OpenAI image provider, registered with
// registerProviders('built-in', ...). Called once at startup.

export function registerImages(): void {
  const results = new ResultStore(join(app.getPath('userData'), 'design', 'openai-images'))
  const provider = new OpenAIImages({
    apiKey: () => getApiKey('openai'),
    endpoint: openaiEndpoint,
    model: () => chosenModel(getDesignSettings()),
    results
  })
  registerProviders('built-in', () => [provider])

  // Startup: drop stored images Design no longer needs. One is kept while a
  // job with its id still exists and that job's version is still pending
  // (its image hasn't been written to the version yet).
  try {
    const s = design()
    const waiting = new Set<string>()
    for (const j of s.jobs.list()) {
      if (!j.remoteId?.startsWith('oai-img-')) continue
      const a = s.artifacts.get(j.requestedBy.conversationId, j.target.artifactId)
      const v = a?.versions.find((x) => x.id === j.target.versionId)
      if (v?.status === 'pending') waiting.add(j.remoteId)
    }
    results.prune((id) => waiting.has(id))
  } catch (err) {
    console.error('OpenAI Images: tidying stored images failed:', err)
  }
}
