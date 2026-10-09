import {
  mediaOperations,
  type MediaCapability,
  type MediaOperation,
  type MediaRequest,
  type ReferenceKind
} from '../../shared/design'

// Checks what a media provider says it can do (a plugin's declaration, or a
// built-in provider's table) before Design relies on it, and checks a
// request against it before anything is sent. Whatever isn't declared, or is
// declared wrongly, is unavailable rather than half-working.

export const MEDIA_LIMITS = {
  capabilities: 10,
  formats: 10,
  sizes: 20,
  constraints: 10,
  text: 300,
  // Seconds.
  maxDuration: 600,
  minPoll: 1
}

const MIME = /^(image|video)\/[a-z0-9.+-]{1,40}$/
const isOp = (x: unknown): x is MediaOperation => mediaOperations.includes(x as MediaOperation)
const posInt = (x: unknown, max = Number.MAX_SAFE_INTEGER): x is number =>
  Number.isInteger(x) && (x as number) > 0 && (x as number) <= max
const text = (x: unknown): x is string =>
  typeof x === 'string' && x.trim().length > 0 && x.length <= MEDIA_LIMITS.text

const isVideo = (op: MediaOperation): boolean => op.startsWith('video.')
// Operations that need a reference to work from.
const NEEDS_REFERENCE: ReadonlySet<MediaOperation> = new Set([
  'image.edit',
  'image.variation',
  'video.image-to-video'
])

export function validateCapabilities(raw: unknown): {
  capabilities: MediaCapability[]
  errors: string[]
} {
  const errors: string[] = []
  if (!Array.isArray(raw)) return { capabilities: [], errors: ['capabilities must be a list'] }
  if (raw.length > MEDIA_LIMITS.capabilities)
    errors.push(`at most ${MEDIA_LIMITS.capabilities} capabilities`)
  const seen = new Set<MediaOperation>()
  const capabilities: MediaCapability[] = []
  for (const [i, c] of raw.slice(0, MEDIA_LIMITS.capabilities).entries()) {
    const at = `capabilities[${i}]`
    const bad = (m: string): void => void errors.push(`${at}: ${m}`)
    const before = errors.length
    if (!c || typeof c !== 'object') {
      bad('must be an object')
      continue
    }
    const x = c as Record<string, unknown>
    if (!isOp(x.operation)) {
      bad(`unknown operation ${JSON.stringify(x.operation)}`)
      continue
    }
    const op = x.operation
    if (seen.has(op)) bad(`${op} is declared twice`)
    seen.add(op)
    const formats = x.formats
    const kind = isVideo(op) ? 'video/' : 'image/'
    if (
      !Array.isArray(formats) ||
      !formats.length ||
      formats.length > MEDIA_LIMITS.formats ||
      !formats.every((f) => typeof f === 'string' && MIME.test(f) && f.startsWith(kind))
    )
      bad(`formats must list ${kind}* types`)
    for (const k of ['progress', 'cancel', 'idempotency'] as const)
      if (typeof x[k] !== 'boolean') bad(`${k} must be true or false`)
    let references: MediaCapability['references']
    if (x.references !== undefined) {
      const r = x.references as Record<string, unknown>
      const kinds = r?.kinds
      if (
        !Array.isArray(kinds) ||
        !kinds.length ||
        !kinds.every((k) => k === 'image' || k === 'video') ||
        !posInt(r.maxCount, 20) ||
        !posInt(r.maxBytes, 500 * 1024 * 1024) ||
        !Array.isArray(r.formats) ||
        !r.formats.length ||
        !r.formats.every((f) => typeof f === 'string' && MIME.test(f))
      )
        bad('references needs kinds, maxCount, maxBytes and formats')
      else
        references = {
          kinds: kinds as ReferenceKind[],
          maxCount: r.maxCount as number,
          maxBytes: r.maxBytes as number,
          formats: r.formats as string[]
        }
    }
    if (NEEDS_REFERENCE.has(op) && !references) bad(`${op} must say which references it takes`)
    let sizes: MediaCapability['sizes']
    if (x.sizes !== undefined) {
      const s = x.sizes
      if (
        !Array.isArray(s) ||
        !s.length ||
        s.length > MEDIA_LIMITS.sizes ||
        !s.every((z) => posInt(z?.width, 16384) && posInt(z?.height, 16384))
      )
        bad('sizes must be width and height pairs')
      else sizes = s.map((z) => ({ width: z.width, height: z.height }))
    }
    let durations: MediaCapability['durations']
    if (x.durations !== undefined || isVideo(op)) {
      const d = x.durations as Record<string, unknown> | undefined
      if (!isVideo(op)) bad('durations are for video only')
      else if (
        typeof d?.min !== 'number' ||
        typeof d?.max !== 'number' ||
        d.min <= 0 ||
        d.max < d.min ||
        d.max > MEDIA_LIMITS.maxDuration
      )
        bad(`video needs durations between 0 and ${MEDIA_LIMITS.maxDuration} seconds`)
      else durations = { min: d.min, max: d.max }
    }
    let pricing: MediaCapability['pricing']
    if (x.pricing !== undefined) {
      const p = x.pricing as Record<string, unknown>
      if (!text(p?.text) || !text(p?.source)) bad('pricing needs text and its source')
      else pricing = { text: p.text, source: p.source }
    }
    if (x.preservesUnchanged !== undefined && typeof x.preservesUnchanged !== 'boolean')
      bad('preservesUnchanged must be true or false')
    if (x.uncertainty !== undefined && !text(x.uncertainty)) bad('uncertainty must be short text')
    const constraints = x.constraints
    if (
      constraints !== undefined &&
      (!Array.isArray(constraints) ||
        constraints.length > MEDIA_LIMITS.constraints ||
        !constraints.every(text))
    )
      bad('constraints must be a short list of text')
    if (
      x.minPollSeconds !== undefined &&
      !(typeof x.minPollSeconds === 'number' && x.minPollSeconds >= MEDIA_LIMITS.minPoll)
    )
      bad(`minPollSeconds must be at least ${MEDIA_LIMITS.minPoll}`)
    if (errors.length > before) continue
    capabilities.push({
      operation: op,
      ...(references ? { references } : {}),
      formats: formats as string[],
      ...(sizes ? { sizes } : {}),
      ...(durations ? { durations } : {}),
      progress: x.progress as boolean,
      cancel: x.cancel as boolean,
      idempotency: x.idempotency as boolean,
      ...(pricing ? { pricing } : {}),
      ...(typeof x.preservesUnchanged === 'boolean'
        ? { preservesUnchanged: x.preservesUnchanged }
        : {}),
      ...(typeof x.uncertainty === 'string' ? { uncertainty: x.uncertainty } : {}),
      ...(constraints ? { constraints: constraints as string[] } : {}),
      ...(typeof x.minPollSeconds === 'number' ? { minPollSeconds: x.minPollSeconds } : {})
    })
  }
  return { capabilities, errors }
}

// Why a request doesn't fit the declared capability, or null when it does.
export function checkRequest(request: MediaRequest, cap: MediaCapability): string | null {
  if (request.operation !== cap.operation) return `This provider can't do ${request.operation}.`
  if (!request.prompt.trim() && !request.references.length) return 'Describe what to make.'
  const refs = request.references
  if (refs.length && !cap.references) return 'This operation takes no reference files.'
  if (NEEDS_REFERENCE.has(cap.operation) && !refs.length)
    return 'This operation needs a reference to work from.'
  if (cap.references) {
    if (refs.length > cap.references.maxCount)
      return `At most ${cap.references.maxCount} reference files.`
    for (const r of refs) {
      if (!cap.references.kinds.includes(r.kind))
        return `${r.name}: ${r.kind} references aren't accepted.`
      if (!cap.references.formats.includes(r.mime)) return `${r.name}: ${r.mime} isn't accepted.`
      if (r.bytes > cap.references.maxBytes) return `${r.name} is larger than the provider takes.`
    }
  }
  if (request.format && !cap.formats.includes(request.format))
    return `${request.format} isn't an available format.`
  if (
    request.size &&
    !cap.sizes?.some((s) => s.width === request.size!.width && s.height === request.size!.height)
  )
    return `${request.size.width}×${request.size.height} isn't an available size.`
  if (request.durationSeconds !== undefined) {
    const d = cap.durations
    if (!d || request.durationSeconds < d.min || request.durationSeconds > d.max)
      return d
        ? `Duration must be between ${d.min} and ${d.max} seconds.`
        : 'This operation takes no duration.'
  }
  return null
}
