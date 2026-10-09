# Proposed live OpenAI image test (needs separate approval)

Stabilization item 3.4. **Nothing here has been run.** It is a plan for Neno
to approve, change or decline on its own, separate from merging anything.
Approving it covers exactly the two requests below and nothing else.

## What it would establish

What the mocks can't: that Neno's real OpenAI key can use Custard's default
image model, that the request Custard builds is accepted, that the image
comes back in the format Custard checks for, and how many tokens one image
actually used. Everything else (refusals, interruptions, timeouts, repeats,
restarts, video) is covered by the mocks first and is **not** part of this
approval.

## The requests: exactly two

| # | Operation | Endpoint | Model | Sent |
| - | --------- | -------- | ----- | ---- |
| 1 | `image.generate` | `POST https://api.openai.com/v1/images/generations` | `gpt-image-2.5-sunburst` (Custard's default) | `model`, `prompt`, `n: 1`, `output_format: "png"`, `size: "1024x1024"`, `stream: false` |
| 2 | `image.edit` | `POST https://api.openai.com/v1/images/edits` (multipart) | `gpt-image-2.5-sunburst` | the same fields plus one `image` file: the PNG from request 1 |

Request 2 runs only if request 1 completed and its image shows in the
workspace.

**Test inputs** (nothing private):

1. Prompt: `A plain white ceramic mug on a light wooden table, soft daylight, no text, no people.`
2. Attach the image from request 1 (Export it, then attach the exported
   file in the same Design chat). Prompt: `Make the mug dark blue. Keep everything else the same.`

## Billing basis

- OpenAI bills these models by tokens. Published standard rates, checked
  2026-10-09 ([IMAGES.md, E2b and E3](IMAGES.md#evidence-checked-2026-10-09)):
  text input $5.00, image input $8.00, image output $30.00 per 1M tokens.
- **No per-request estimate is available.** OpenAI publishes no per-image
  price, its cost calculator covers GPT Image 2 and says it doesn't estimate
  GPT Image 2.5 token use, and the API response reports token usage only for
  `gpt-image-1` (per the SDK). So this plan gives no dollar figure. The
  actual tokens and cost would be read from OpenAI's usage dashboard
  afterwards.
- Whether OpenAI bills a refused (4xx) request isn't documented.
- To bound the spend, Neno can set a project budget in the OpenAI dashboard
  first. Whether that budget blocks requests or only alerts wasn't checked
  here (unverified); don't rely on it as a hard cap.

## Prerequisites (Neno)

- The OpenAI API key already saved in Custard (Settings → General). It is
  never copied into Design files; the e2e tests check this.
- An account on a paid usage tier: OpenAI's model pages list the Free tier
  as "not supported" for these models.
- Possibly **API Organization Verification**: OpenAI's image guide says you
  "may need" it for GPT Image models. If it is missing, request 1 should fail
  with a 403, which Custard shows as "OpenAI refused access … may require
  organization verification". That counts as a result, not a reason to retry.
- A Custard build that talks to OpenAI itself: a packaged build (pinned to
  `https://api.openai.com/v1`), or a development build started **without**
  `OPENAI_BASE_URL`.
- Design settings: image provider OpenAI Images, model GPT Image 2.5 Sunburst.

## How it runs

1. New Design chat. Ask for the image with prompt 1. Read the approval card:
   it should show OpenAI Images, "Generate an image", "No files are sent",
   the rate line marked "not a quote for this request", and "can't be
   cancelled". Allow once.
2. Wait for the result. Record what the job and the workspace show.
3. If it completed: Export it, attach the exported PNG, ask for prompt 2,
   read the card (it should name the attached file and say edits may change
   other parts), Allow once.
4. Record the result, then stop.

## No retries

- Custard sends each request once: the OpenAI SDK's automatic retries are
  off (`maxRetries: 0`), and a request whose outcome is unknown is never
  resent automatically.
- The tester doesn't resend either. If Custard offers a repeat card, decline
  it.

## Stop conditions

Stop the whole test, and don't send anything else, when any of these happens:

- request 1 doesn't complete (any 4xx, 5xx, timeout, dropped connection,
  "unknown" outcome or a refusal);
- the card is missing the provider, operation, files or rate wording, or
  shows anything as the price of the request;
- a second card appears for the same request;
- the result isn't stored, isn't shown in the workspace, or isn't a PNG;
- after request 2, whatever its outcome. Two requests is the most this test
  sends.

On a stop after anything was sent, check the OpenAI usage dashboard for what
was recorded before deciding anything else.

## What to record

- The date, Custard commit and platform.
- For each request: the card text, the job state, whether a version was
  stored and drawn, the error text if any, and the time taken.
- From the OpenAI usage dashboard afterwards: requests and tokens per model
  for that time, and the cost shown.
- Whether the edit kept the parts it was asked to keep (expected: not
  exactly; Custard says so).

## Not in this approval

Refusal prompts, interrupting a request, quitting during a request,
repeating an unknown request, other models, other sizes or formats, video,
and any plugin provider. Each of those runs against mocks (see
[IMAGES.md, Tests](IMAGES.md#tests)) and would need its own approval to run
live.
