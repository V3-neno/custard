import { allProfiles, builtInProfiles, profileOf, type ModelProfile } from './models'

// What a model call costs, from the providers' published standard rates,
// checked on 2026-10-12:
//   Claude: https://platform.claude.com/docs/en/about-claude/pricing
//   OpenAI: https://developers.openai.com/api/docs/pricing (and
//           https://openai.com/api/pricing for the 270K long-context line)
//   DeepSeek: https://api-docs.deepseek.com/quick_start/pricing
// They are not looked up at run time, so a price change needs an update to
// the model's profile (shared/models.ts). Everything Custard shows from this
// is an estimate: it doesn't know about discounts, credits, taxes or regional
// uplifts.

// Tokens one model call used, as the provider reported them.
export type TokenUsage = {
  // Input billed at the normal rate (not read from or written to a cache).
  input: number
  // Input written to Claude's prompt cache (5-minute writes).
  cacheWrite: number
  // Input read from a cache.
  cacheRead: number
  // Output, thinking included.
  output: number
  // Server-side web searches.
  webSearches: number
}

// Told what one model call used.
export type OnUsage = (model: string, u: TokenUsage) => void

export const noUsage = (): TokenUsage => ({
  input: 0,
  cacheWrite: 0,
  cacheRead: 0,
  output: 0,
  webSearches: 0
})

// Dollars per million tokens.
type Rates = { input: number; cacheWrite: number; cacheRead: number; output: number }
export type Price = Rates & {
  // Higher rates for the whole request once its input passes `over` tokens.
  long?: Rates & { over: number }
}

const WEB_SEARCH_PER_1K = 10

// The built-in models' prices, as the table they used to be (tests compare
// them with it).
export const PRICES: Record<string, Price> = Object.fromEntries(
  (builtInProfiles as readonly ModelProfile[]).flatMap((m) => (m.prices ? [[m.id, m.prices]] : []))
)

// A model's prices, from its profile in the registry (shared/models.ts).
// Claude's dated or suffixed ids (from a fallback, say) are priced as their
// base model.
function priceOf(model: string): Price | null {
  const own = profileOf(model)?.prices
  if (own) return own
  const base = allProfiles().find((m) => m.prices && model.startsWith(`${m.id}-`))
  return base?.prices ?? null
}

// Dollars, or null for a model with no known price.
export function costOf(model: string, u: TokenUsage): number | null {
  const p = priceOf(model)
  if (!p) return null
  const prompt = u.input + u.cacheWrite + u.cacheRead
  const r: Rates = p.long && prompt > p.long.over ? p.long : p
  return (
    (u.input * r.input +
      u.cacheWrite * r.cacheWrite +
      u.cacheRead * r.cacheRead +
      u.output * r.output) /
      1_000_000 +
    (u.webSearches * WEB_SEARCH_PER_1K) / 1000
  )
}

// "$0.03", "<$0.01", "$12.40".
export function formatCost(dollars: number): string {
  if (dollars === 0) return '$0.00'
  if (dollars < 0.01) return '<$0.01'
  return `$${dollars.toFixed(2)}`
}

// "950", "12.4k", "1.2M".
export function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}
