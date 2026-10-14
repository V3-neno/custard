import {
  capabilities,
  type Capability,
  type CapabilityEntry,
  type ModelCapabilities,
  type ModelInfo
} from '../../shared/adapter'
import { hasHostedSearch, profileOf, type ModelProfile } from '../../shared/models'
import { providers, responsesFeatures } from '../../shared/providers'
import { kindRefusal } from '../attachments/request'
import { limitsFor } from '../context'

// What each model Custard offers can do: the rules below, applied to the
// model's profile (shared/models.ts), the same profile a request is built
// from. Files go through the attachment rules that refuse a file, and web
// search through the same check that gives a chat web_search. So the list
// can't say yes to something a chat would then refuse.

function derive(m: ModelProfile): Record<Capability, Omit<CapabilityEntry, 'evidence'>> {
  const anthropic = providers[m.provider].api === 'anthropic'
  const features = responsesFeatures(m.provider)
  const refuses = (kind: 'image' | 'pdf'): Omit<CapabilityEntry, 'evidence'> => {
    const why = kindRefusal(m, kind)
    return why ? { supported: false, note: why } : { supported: true }
  }
  return {
    text: { supported: true },
    streaming: { supported: true },
    // Every provider gets Custard's tools as function tools.
    tool_use: { supported: true },
    // Background summaries ask every provider for JSON by schema.
    json_schema: { supported: true },
    vision: refuses('image'),
    pdf: refuses('pdf'),
    // Claude thinks only on models whose profile turns thinking on; a
    // Responses model always reasons.
    reasoning: { supported: anthropic ? m.thinking : true },
    reasoning_summary: anthropic
      ? { supported: m.thinking }
      : features.reasoningSummary
        ? { supported: true }
        : { supported: false, note: 'Shows its raw reasoning instead.' },
    effort: { supported: m.effort !== null },
    web_search: hasHostedSearch(m.id)
      ? { supported: true }
      : { supported: false, note: 'Reads pages it is given (web_read) but cannot search.' },
    // Claude: Custard marks the prompt for caching. Responses providers
    // cache on their side without being asked (their prices list cached
    // input).
    prompt_caching: anthropic
      ? { supported: true }
      : { supported: true, note: 'Automatic, on the provider’s side.' },
    compaction: limitsFor(m.id).compaction
      ? { supported: true }
      : { supported: false, note: '“Continue in a new chat” takes over when it fills up.' },
    token_counting: anthropic
      ? { supported: true }
      : features.tokenCount
        ? { supported: true }
        : { supported: false, note: 'The context gauge is an estimate.' },
    fallbacks: { supported: m.fallbacks }
  }
}

// What a model can do. A model Custard has no profile for gets only plain
// text, which is all Custard could promise for it. Evidence is `live` only
// for what the profile records as tested live on that model.
export function capabilitiesOf(id: string): ModelCapabilities {
  const m = profileOf(id)
  const live = new Set(m?.live ?? [])
  const base = m ? derive(m) : null
  return Object.fromEntries(
    capabilities.map((c) => [
      c,
      {
        ...(base?.[c] ?? { supported: c === 'text', note: m ? undefined : 'Unknown model.' }),
        evidence: live.has(c) ? 'live' : 'docs'
      } satisfies CapabilityEntry
    ])
  ) as ModelCapabilities
}

// A model Custard offers, in the adapter schema.
export function modelInfo(id: string): ModelInfo | null {
  const m = profileOf(id)
  if (!m) return null
  const limits = limitsFor(m.id)
  return {
    id: m.id,
    label: m.label,
    provider: m.provider,
    api: providers[m.provider].api,
    contextWindow: limits.window,
    maxOutput: limits.maxOutput,
    priced: m.prices !== null,
    capabilities: capabilitiesOf(m.id),
    source: 'profile'
  }
}
