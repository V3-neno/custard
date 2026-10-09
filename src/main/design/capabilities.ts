import {
  mediaOperations,
  type Availability,
  type CapabilityReport,
  type DesignOperation,
  type DesignSettings,
  type MediaCapability,
  type MediaOperation,
  type MediaProviderInfo,
  type Source
} from '../../shared/design'
import { providerNames, type Provider } from '../../shared/chat'

// What Design can do right now, and exactly why not when it can't, from
// configuration and what providers declare, never from what a model says
// about itself. Each operation is answered for the configured default
// source only; other capable sources are listed as alternatives for the
// user to choose, and nothing switches to them on its own.

// Image output from the chat connection itself. Neither of Custard's chat
// connections returns images today, so images always need an image provider.
const CHAT_IMAGE_OUTPUT: Record<Provider, { ok: false; reason: string }> = {
  // The Messages API returns text (and tool calls), not images.
  claude: { ok: false, reason: "Claude's API answers in text and can't return images." },
  // What the model could do elsewhere doesn't matter: Custard's OpenAI chat
  // connection only handles text output.
  openai: { ok: false, reason: "Custard's OpenAI chat connection handles text output only." }
}

export type Failure = {
  operation: DesignOperation
  source: Source
  reason: string
  temporary: boolean
}

export type DiscoverInput = {
  chat: { provider: Provider; model: string; hasKey: boolean }
  design: DesignSettings
  // Built-in image providers and plugin providers, as they describe themselves.
  providers: MediaProviderInfo[]
  // Failures seen this session, newest last.
  failures: Failure[]
}

const sameSource = (a: Source, b: Source): boolean => JSON.stringify(a) === JSON.stringify(b)

const lastFailure = (input: DiscoverInput, op: DesignOperation, via: Source): Failure | undefined =>
  [...input.failures].reverse().find((f) => f.operation === op && sameSource(f.source, via))

const failed = (f: Failure): Availability => ({
  status: 'unavailable',
  cause: 'failed',
  reason: f.reason,
  temporary: f.temporary,
  via: f.source
})

const NAMES: Record<MediaOperation, string> = {
  'image.generate': 'image generation',
  'image.edit': 'image editing',
  'image.variation': 'image variations',
  'video.text-to-video': 'video from text',
  'video.image-to-video': 'video from an image'
}

function limitsOf(cap: MediaCapability): string[] {
  return [
    ...(cap.durations ? [`${cap.durations.min}–${cap.durations.max} seconds`] : []),
    ...(cap.references
      ? [
          `up to ${cap.references.maxCount} reference ${cap.references.maxCount === 1 ? 'file' : 'files'}`
        ]
      : []),
    ...(cap.pricing
      ? [`pricing, not a quote: ${cap.pricing.text} (from ${cap.pricing.source})`]
      : []),
    ...(cap.cancel ? [] : ["can't be cancelled once submitted"]),
    ...(cap.constraints ?? [])
  ]
}

function htmlAvailability(input: DiscoverInput): Availability {
  const via: Source = { kind: 'chat-model', provider: input.chat.provider, model: input.chat.model }
  const name = providerNames[input.chat.provider]
  if (!input.chat.hasKey)
    return {
      status: 'unavailable',
      cause: 'unconfigured',
      reason: `No ${name} API key is set.`,
      fix: { place: 'ai-settings', text: `Add your ${name} API key in Settings.` }
    }
  const f = lastFailure(input, 'design.html', via)
  if (f) return failed(f)
  return {
    status: 'supported',
    via,
    limits: [
      "Previewed in Custard's sandbox: no network, backend, real sign-in or payments.",
      'Images in the page are drawn in markup (HTML, CSS or SVG), not generated.'
    ]
  }
}

function mediaAvailability(
  input: DiscoverInput,
  op: MediaOperation
): { availability: Availability; alternatives: Source[] } {
  const video = op.startsWith('video.')
  const capable = input.providers.filter((p) => p.capabilities.some((c) => c.operation === op))
  const ready = capable.filter((p) => p.state === 'ready')
  const chosenId = video ? input.design.video.provider : input.design.image.provider
  const chosen = chosenId ? input.providers.find((p) => p.id === chosenId) : undefined
  const alternatives = ready.filter((p) => p !== chosen).map((p) => p.source)
  const out = (availability: Availability): ReturnType<typeof mediaAvailability> => ({
    availability,
    alternatives
  })

  // Video defaults to the one enabled plugin that offers it, if there's
  // exactly one; with several, the user picks.
  const fallbackVideo = video && !chosenId && ready.length === 1 ? ready[0] : undefined
  const provider = chosen ?? fallbackVideo
  if (!provider) {
    if (chosenId)
      return out({
        status: 'unavailable',
        cause: 'unconfigured',
        reason: `The ${video ? 'video' : 'image'} provider chosen in Design settings isn't available any more.`,
        fix: { place: 'design-settings', text: 'Choose another provider in Design settings.' }
      })
    if (!capable.length)
      return out({
        status: 'unavailable',
        cause: 'unsupported',
        reason: video
          ? `Custard has no video generator of its own; ${NAMES[op]} needs an enabled plugin that offers it, and none is installed.`
          : `No installed image provider offers ${NAMES[op]}. ${CHAT_IMAGE_OUTPUT[input.chat.provider].reason}`,
        fix: video
          ? { place: 'plugins', text: 'Install a plugin that offers video generation.' }
          : undefined
      })
    if (!ready.length) {
      const p = capable[0]
      return out({
        status: 'unavailable',
        cause: 'unconfigured',
        reason: `${p.name} offers ${NAMES[op]} but isn't ready${p.needs ? `: ${p.needs}` : '.'}`,
        fix: {
          place: p.source.kind === 'plugin' ? 'plugins' : 'design-settings',
          text: p.source.kind === 'plugin' ? `Set up ${p.name} in Plugins.` : `Set up ${p.name}.`
        }
      })
    }
    return out({
      status: 'unavailable',
      cause: 'unconfigured',
      reason: `No default ${video ? 'video' : 'image'} provider is chosen.`,
      fix: { place: 'design-settings', text: 'Choose one in Design settings.' }
    })
  }
  const cap = provider.capabilities.find((c) => c.operation === op)
  if (!cap)
    return out({
      status: 'unavailable',
      cause: 'unsupported',
      reason: `${provider.name} doesn't offer ${NAMES[op]}.`,
      via: provider.source
    })
  if (provider.state !== 'ready')
    return out({
      status: 'unavailable',
      cause: 'unconfigured',
      reason: `${provider.name} isn't ready${provider.needs ? `: ${provider.needs}` : '.'}`,
      fix: {
        place: provider.source.kind === 'plugin' ? 'plugins' : 'design-settings',
        text: `Set up ${provider.name}${provider.source.kind === 'plugin' ? ' in Plugins' : ''}.`
      },
      via: provider.source
    })
  const f = lastFailure(input, op, provider.source)
  if (f) return out(failed(f))
  const uncertainty =
    cap.uncertainty ??
    (op === 'image.edit' && cap.preservesUnchanged === false
      ? `${provider.name} may change parts of the image you didn't ask to change.`
      : undefined)
  return out(
    uncertainty
      ? { status: 'quality-uncertain', via: provider.source, uncertainty, limits: limitsOf(cap) }
      : { status: 'supported', via: provider.source, limits: limitsOf(cap) }
  )
}

export function discoverCapabilities(input: DiscoverInput): CapabilityReport {
  const media = Object.fromEntries(
    mediaOperations.map((op) => [op, mediaAvailability(input, op)])
  ) as Record<MediaOperation, ReturnType<typeof mediaAvailability>>
  return { 'design.html': { availability: htmlAvailability(input), alternatives: [] }, ...media }
}
