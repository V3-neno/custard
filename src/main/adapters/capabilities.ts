import {
  capabilities,
  type Capability,
  type CapabilityEntry,
  type ModelCapabilities,
  type ModelInfo
} from '../../shared/adapter'
import { chatModels } from '../../shared/chat'
import { PRICES } from '../../shared/pricing'
import { providers, responsesFeatures } from '../../shared/providers'
import { kindRefusal } from '../attachments/request'
import { CONTEXT_LIMITS, limitsFor } from '../context'
import { webTools } from '../web'

// What each model Custard offers can do, read from the same rules a request
// is built from: the attachment rules that refuse a file, the web tools a
// chat is given, the provider's Responses flags, the context limits. So the
// list can't say yes to something a chat would then refuse.

// Seen working in a live test, rather than only documented. Only what was
// recorded as tested on a known model is here (DeepSeek, by Neno on
// 2026-10-13): an image read by DeepSeek Flash, and a chat note written by
// DeepSeek Flash (the summary model for every DeepSeek chat). Which model ran
// the tool-call chat wasn't recorded, so text and tools stay 'docs'.
const LIVE: Partial<Record<string, Capability[]>> = {
  'deepseek-flash': ['vision', 'json_schema']
}

type Known = (typeof chatModels)[number]

function derive(m: Known): Record<Capability, Omit<CapabilityEntry, 'evidence'>> {
  const anthropic = providers[m.provider].api === 'anthropic'
  const features = responsesFeatures(m.provider)
  const refuses = (kind: 'image' | 'pdf'): Omit<CapabilityEntry, 'evidence'> => {
    const why = kindRefusal(m, kind)
    return why ? { supported: false, note: why } : { supported: true }
  }
  const search = webTools(m).tools.some((t) => t.name === 'web_search')
  return {
    text: { supported: true },
    streaming: { supported: true },
    // Every provider gets Custard's tools as function tools.
    tool_use: { supported: true },
    // Background summaries ask every provider for JSON by schema.
    json_schema: { supported: true },
    vision: refuses('image'),
    pdf: refuses('pdf'),
    // Claude thinks only on models that take effort; a Responses model
    // always reasons.
    reasoning: { supported: anthropic ? m.effort : true },
    reasoning_summary: anthropic
      ? { supported: m.effort }
      : features.reasoningSummary
        ? { supported: true }
        : { supported: false, note: 'Shows its raw reasoning instead.' },
    effort: { supported: m.effort },
    web_search: search
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

const known = (id: string): Known | undefined => chatModels.find((m) => m.id === id)

// What a model can do. A model Custard has no profile for gets only plain
// text, which is all Custard could promise for it.
export function capabilitiesOf(id: string): ModelCapabilities {
  const m = known(id)
  const live = new Set(LIVE[id] ?? [])
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
  const m = known(id)
  if (!m) return null
  const limits = CONTEXT_LIMITS[m.id] ?? limitsFor(m.id)
  return {
    id: m.id,
    label: m.label,
    provider: m.provider,
    api: providers[m.provider].api,
    contextWindow: limits.window,
    maxOutput: limits.maxOutput,
    priced: Object.hasOwn(PRICES, m.id),
    capabilities: capabilitiesOf(m.id),
    source: 'profile'
  }
}
