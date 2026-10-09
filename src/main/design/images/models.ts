import type { MediaCapability } from '../../../shared/design'

// The OpenAI image models Custard offers, and what each can do through
// OpenAI's Image API. Re-checked on 2026-10-09 against OpenAI's own sources;
// docs/design/IMAGES.md ("Evidence") lists each URL and what it establishes:
//   - model ids, endpoints, parameters and limits: the OpenAI Node SDK
//     7.30.0 (generated from OpenAI's API spec; resources/images.d.ts) and
//     the model pages on developers.openai.com;
//   - generations and edits only: the SDK marks the variations endpoint as
//     retired, and the only model it ever took (dall-e-2) was shut down on
//     2026-05-12, so image.variation isn't declared (a variation of an
//     output is still made with generate or edit);
//   - output png, jpeg or webp; the standard sizes 1024x1024, 1536x1024 and
//     1024x1536 work on every GPT image model;
//   - edits take up to 16 png, webp or jpg images under 50 MB each;
//   - no idempotency keys, no cancellation, no progress: a request either
//     returns the image or fails.
// Models OpenAI has scheduled for shutdown (gpt-image-1 on 2026-10-23;
// gpt-image-1-mini, gpt-image-1.5 and chatgpt-image-latest on 2026-12-01)
// and the retired DALL·E models are left out. Nothing here is a chat model:
// Custard never asks its chat connection for images.

export const OPENAI_IMAGES_ID = 'openai-images'

const PRICING_SOURCE = 'OpenAI API pricing page and model page, standard tier, checked 2026-10-09'

// A published rate, not a price: OpenAI bills image tokens, and how many
// tokens an image uses isn't known before it is made (the response reports
// usage only for gpt-image-1, per the SDK), so Custard can't say what one
// request will cost.
const RATES_2_5 =
  'image output $30.00, image input $8.00, text input $5.00 per 1M tokens; the total depends on how many tokens the image uses'

export type OpenAIImageModel = {
  id: string
  name: string
  note: string
  // Per-token rates as OpenAI publishes them. OpenAI publishes no per-image
  // price, so none is computed. Absent where the standard-tier table has no
  // row for the model.
  pricing?: { text: string; source: string }
}

export const OPENAI_IMAGE_MODELS: OpenAIImageModel[] = [
  {
    id: 'gpt-image-2.5-sunburst',
    name: 'GPT Image 2.5 Sunburst',
    note: "OpenAI's most capable model for image generation and editing.",
    pricing: { text: RATES_2_5, source: PRICING_SOURCE }
  },
  {
    id: 'gpt-image-2.5-flare',
    name: 'GPT Image 2.5 Flare',
    note: 'Fast, high-quality everyday image generation.',
    pricing: { text: RATES_2_5, source: PRICING_SOURCE }
  },
  {
    id: 'gpt-image-2',
    name: 'GPT Image 2',
    // Current (no deprecation notice) but no longer on OpenAI's models
    // overview, and its standard-tier price row is missing: no price shown.
    note: 'The previous generation. No standard-tier price published.'
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
