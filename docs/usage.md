# Usage, cost and the monthly budget

Custard shows what each chat costs and how full its context is, and keeps a
monthly total that a budget in Settings warns against. Every figure is an
estimate from the providers' published standard prices; the provider's bill is
what counts.

## What is counted

Every model call Custard makes is counted from the `usage` the provider returns:

- chat turns (each model call in a turn, tool rounds and compaction included);
- the separate web-search call behind `web_search`;
- Custard's background summaries of a chat: memory captures, chat notes and
  "Continue in a new chat" (charged to that chat);
- automation runs (counted for the month only; they belong to no chat).

Not counted: image generation in Design (OpenAI bills image tokens and Custard
can't price a request in advance), token-counting requests (free), and calls
that fail before the provider reports usage (for example a turn you stop while
it is streaming).

Prices live in `src/shared/pricing.ts`, checked on 2026-10-12 against
platform.claude.com/docs/en/about-claude/pricing and
developers.openai.com/api/docs/pricing. They are not fetched at run time. A
model with no known price is counted as a call but not in the cost, and the
meter's tooltip says how many such calls there were.

- Claude: input, 5-minute cache writes, cache reads and output at each model's
  rate; web search at $10 per 1,000. The full 1M context is at standard rates.
- OpenAI: input minus its cached part, cached input, and output (reasoning
  included); web search at $10 per 1,000 calls. Requests over 270,000 input
  tokens use the long-context rates: openai.com gives the standard rates as
  "for context lengths under 270K", and the developer pricing page lists
  long-context rates without a threshold.

## Where it shows

- **Meter** beside the model pills: a small gauge of how full the chat's context
  is (the same estimate that makes Custard say a chat is getting long; it turns
  amber at that point) and the chat's cost so far. The tooltip has the token
  figures. It updates after each turn; a background summary's cost shows after
  the next turn.
- **Settings → Spending**: this month's estimated spend and an optional monthly
  budget in dollars.
- **Budget line** under the mode bubbles: from 80% of the budget, and again once
  it is passed. Custard never stops a chat because of the budget.

## Where it is kept

- Each chat's totals are on the chat (`usage` in its saved file).
- Monthly totals are in `usage.json` in Custard's app data, for the last 24
  months. Deleting a chat doesn't change the month.
