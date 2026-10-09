import type { MediaCapability } from '../../../shared/design'

// The OpenAI image models Custard offers, and what each can do through
// OpenAI's Image API. Checked against OpenAI's documentation on 2026-10-08
// (see docs/design/IMAGES.md for what was read and what wasn't confirmed):
//   - generations and edits only: the variations endpoint is retired, so
//     image.variation isn't declared (a variation of an output is still
//     made with generate or edit);
//   - output png, jpeg or webp; the standard sizes 1024x1024, 1536x1024 and
//     1024x1536 work on every GPT image model;
//   - edits take up to 16 png, webp or jpg images under 50 MB each;
//   - no idempotency keys, no cancellation, no progress: a request either
//     returns the image or fails.
// Models OpenAI has scheduled for shutdown (gpt-image-1, gpt-image-1-mini,
// gpt-image-1.5, chatgpt-image-latest) and the retired DALL·E models are
// left out. Nothing here is a chat model: Custard never asks its chat
// connection for images.

export const OPENAI_IMAGES_ID = 'openai-images'

const PRICING_SOURCE = 'OpenAI API pricing page, standard tier, read 2026-10-08'

export type OpenAIImageModel = {
  id: string
  name: string
  note: string
  // Per-token rates as the pricing page lists them. OpenAI doesn't publish a
  // per-image price there, so none is computed. Absent where the page's
  // standard tier didn't list the model.
  pricing?: { text: string; source: string }
}

export const OPENAI_IMAGE_MODELS: OpenAIImageModel[] = [
  {
    id: 'gpt-image-2.5-sunburst',
    name: 'GPT Image 2.5 Sunburst',
    note: "OpenAI's most capable image model; best when edits must be precise.",
    pricing: {
      text: 'Per token: image input $8.00, image output $30.00, text input $5.00 per 1M tokens',
      source: PRICING_SOURCE
    }
  },
  {
    id: 'gpt-image-2.5-flare',
    name: 'GPT Image 2.5 Flare',
    note: 'Fast everyday image generation.',
    pricing: {
      text: 'Per token: image input $8.00, image output $30.00, text input $5.00 per 1M tokens',
      source: PRICING_SOURCE
    }
  },
  {
    id: 'gpt-image-2',
    name: 'GPT Image 2',
    note: 'The previous generation.'
  }
]

export const DEFAULT_IMAGE_MODEL = OPENAI_IMAGE_MODELS[0].id

export const imageModel = (id: string | null): OpenAIImageModel | undefined =>
  OPENAI_IMAGE_MODELS.find((m) => m.id === id)

export const OUTPUT_FORMATS = ['image/png', 'image/jpeg', 'image/webp']
const SIZES = [
  { width: 1024, height: 1024 },
  { width: 1536, height: 1024 },
  { width: 1024, height: 1536 }
]

// Bytes OpenAI returns for one image are capped well above any standard size.
export const MAX_RESULT_BYTES = 64 * 1024 * 1024

export function capabilitiesOf(model: OpenAIImageModel): MediaCapability[] {
  const common = {
    formats: OUTPUT_FORMATS,
    sizes: SIZES,
    progress: false,
    cancel: false,
    idempotency: false,
    ...(model.pricing ? { pricing: model.pricing } : {}),
    constraints: [
      'One image per request.',
      "OpenAI's usage policies apply and it may refuse a prompt or reference."
    ]
  }
  return [
    { operation: 'image.generate', ...common },
    {
      operation: 'image.edit',
      ...common,
      references: {
        kinds: ['image'],
        maxCount: 16,
        maxBytes: 50 * 1024 * 1024,
        formats: ['image/png', 'image/jpeg', 'image/webp']
      },
      // OpenAI redraws the whole image from the references and the prompt;
      // nothing documents that untouched regions stay pixel-identical.
      preservesUnchanged: false
    }
  ]
}
