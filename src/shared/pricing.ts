// What a model call costs, from the providers' published standard rates,
// checked on 2026-10-12:
//   Claude: https://platform.claude.com/docs/en/about-claude/pricing
//   OpenAI: https://developers.openai.com/api/docs/pricing (and
//           https://openai.com/api/pricing for the 270K long-context line)
// They are not looked up at run time, so a price change needs an update
// here. Everything Custard shows from this is an estimate: it doesn't know
// about discounts, credits, taxes or regional uplifts.

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
type Price = Rates & {
  // Higher rates for the whole request once its input passes `over` tokens.
  long?: Rates & { over: number }
}

const WEB_SEARCH_PER_1K = 10

export const PRICES: Record<string, Price> = {
  // Claude: the full 1M context at standard rates; cache reads at 0.05x on
  // Opus 5.5 and Sonnet 5.5, 0.1x on Haiku 4.5.
  'claude-opus-5-5': { input: 4, cacheWrite: 5, cacheRead: 0.2, output: 20 },
  'claude-sonnet-5-5': { input: 2, cacheWrite: 2.5, cacheRead: 0.1, output: 10 },
  'claude-haiku-4-5': { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 },
  // OpenAI: no cache-write charge. The pricing page gives long-context rates
  // without a threshold; openai.com says the standard rates are "for context
  // lengths under 270K", so 270,000 input tokens is used.
  'gpt-6-astra': {
    input: 10,
    cacheWrite: 10,
    cacheRead: 1,
    output: 50,
    long: { over: 270_000, input: 20, cacheWrite: 20, cacheRead: 2, output: 75 }
  },
  'gpt-6.1-sol': {
    input: 2,
    cacheWrite: 2,
    cacheRead: 0.1,
    output: 10,
    long: { over: 270_000, input: 4, cacheWrite: 4, cacheRead: 0.2, output: 15 }
  },
  'gpt-6-luna': {
    input: 0.1,
    cacheWrite: 0.1,
    cacheRead: 0.01,
    output: 0.5,
    long: { over: 270_000, input: 0.2, cacheWrite: 0.2, cacheRead: 0.02, output: 0.75 }
  }
}

// Claude's dated or suffixed ids (from a fallback, say) are priced as their
// base model.
function priceOf(model: string): Price | null {
  if (PRICES[model]) return PRICES[model]
  const base = Object.keys(PRICES).find((k) => model.startsWith(`${k}-`))
  return base ? PRICES[base] : null
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
