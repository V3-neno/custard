# Design: built-in images (OpenAI)

Workstream B, Phase 3. Code in `src/main/design/images/`, the viewer in
`src/renderer/src/components/design/viewers/ImageViewer.tsx`, settings in
`src/renderer/src/components/settings/DesignTab.tsx`.

**Everything here is mock-tested only.** No request has been sent to OpenAI.
Model names, limits and prices come from OpenAI's documentation and the
OpenAI Node SDK as read on 2026-10-08; whether a given key can use them
(organization verification, quota) is unverified.

## What it does

| Operation         | Status in Custard                  | How                                    |
| ----------------- | ---------------------------------- | -------------------------------------- |
| `image.generate`  | supported                          | `POST /v1/images/generations`          |
| `image.edit`      | quality-uncertain                  | `POST /v1/images/edits`, multipart     |
| `image.variation` | unsupported                        | OpenAI retired its variations endpoint |
| video             | not offered by B (plugins only, C) |                                        |

A _variation_ of an output (Design's `relation: 'variation'`) still works:
it is a generate or an edit whose result is kept beside the original.

### Edits versus new images

OpenAI's edit endpoint redraws the whole image from the reference(s) and the
prompt. Nothing in its documentation says untouched areas stay
pixel-identical, so the provider declares `preservesUnchanged: false` and
Design marks editing as quality-uncertain ("may change parts of the image you
didn't ask to change"), on the approval card and in Design settings.

The viewer says which it was:

- "Change to v1: an edit of an attached image": an `image.edit` of files
  attached in the chat.
- "Change to v1: a new image from the prompt, not an edit": an
  `image.generate` that was filed as a revision.

References come only from files the user attached in the same chat
(`MediaReference.attachmentId`); Custard reads them, checks the hash taken
at attach time and that the bytes really are the declared PNG, JPEG or WebP
before anything is sent. A mismatch fails with nothing sent.

## Models

Offered in Design settings, from `models.ts`:

| Model                    | Note                     | Price on the card              |
| ------------------------ | ------------------------ | ------------------------------ |
| `gpt-image-2.5-sunburst` | most capable; default    | per-token rates, standard tier |
| `gpt-image-2.5-flare`    | fast everyday generation | per-token rates, standard tier |
| `gpt-image-2`            | previous generation      | none shown (see Pricing)       |

Left out on purpose: `dall-e-2` and `dall-e-3` (retired 2026-05-12),
`gpt-image-1` (shutdown 2026-10-23), `gpt-image-1-mini`, `gpt-image-1.5` and
`chatgpt-image-latest` (shutdown 2026-12-01), per OpenAI's deprecations page.
Chat models are never used for images.

Options sent: `model`, `prompt`, `n: 1`, `output_format` (png, jpeg or webp)
and, when asked, one of the standard sizes `1024x1024`, `1536x1024`,
`1024x1536`. Nothing else (quality, background, moderation, input fidelity,
masks, arbitrary sizes) is sent, because the media contract doesn't carry it
and per-model support differs. Edits take up to 16 images of up to 50 MB.

Choosing an unsupported model id makes the provider "needs setup"; it never
falls back to another model or provider.

## Credentials and endpoint

- The key is the one saved under General (`getApiKey('openai')`), read when a
  request is made. It is never copied: Design settings store only the
  provider and model ids (`settings.ts` drops anything else), and the e2e test
  checks that no file under `design/` contains it.
- Requests go to `openaiEndpoint()`: `https://api.openai.com/v1` in a
  packaged build; development builds honour `OPENAI_BASE_URL` (the e2e mock).

## Paid requests: sent once

- The SDK's automatic retries are off (`maxRetries: 0`, client and request).
- Outcome mapping (`openai.ts` `mapError`):
  - 4xx answered by OpenAI → refused, did not run → job **failed**
    (401/403 → unconfigured, 404 → unsupported, 429 → temporary, others
    rejected);
  - 5xx, dropped connection, timeout (10 minutes) or stopping the turn → it
    may have run → job **unknown**; it is never resent, and the model is told
    to ask the user first.
- OpenAI keeps no copy to fetch later, so the provider writes the image to
  `userData/design/openai-images/<remoteId>/` (exclusive create, mode 0600,
  fsync, meta written last) before reporting success. `status()` and
  `result()` only read that copy: checking a job never contacts OpenAI.
- Design saves the image on its version in the same call (contract B1). If
  Custard stops in between, the next check of that job collects it without
  sending anything.
- At startup a stored image is deleted once its version is no longer pending
  (it is on the version) or its job is gone (chat deleted).

### Residual risks

- If Custard stops after OpenAI answered but before the image is written to
  disk, the image is lost and the job is unknown; OpenAI may still charge it.
- If it stops after the image is written but before the job records its id,
  the job is unknown with no reference, and the stored image is deleted at
  the next start. Recovering it would need a contract change.
- A chat deleted while its image waits to be collected leaves the stored copy
  until the next start.

## Pricing

Shown only as OpenAI's pricing page gives it, with the source:
"Per token: image input $8.00, image output $30.00, text input $5.00 per 1M
tokens (from OpenAI API pricing page, standard tier, read 2026-10-08)" for
both GPT Image 2.5 models. The page publishes no per-image price, so none is
computed. For `gpt-image-2` the page's standard-tier table had no row (it
appeared only in a table that looked like the Batch tier), so no price is
shown. The page was read through a summarising fetch tool, not directly;
re-check these figures before relying on them.

## Design settings tab

Image provider and model, default video provider (C's plugins), and "What
Design can do now" from the capability report, each line with its reason.
Nothing is switched automatically: with no provider chosen, Design says so.

## Skill guidance (for the image skill)

Suggested guidance for a Design skill about images (the vault template is
not B's to change):

- Say whether you need a new image or a change to an existing one. A change
  needs the image attached in this chat; it is redrawn, so ask the user to
  check the parts they wanted kept.
- Describe subject, composition, style, lighting and any text in the image
  explicitly; OpenAI's image models don't take a separate style option.
- Ask before each image: every request is a paid call, shown on its own card.
- Never resend a request whose outcome is unknown without the user's word.
- Don't draw an illustration in HTML or SVG and call it a generated image.

## Tests

- Unit (`src/main/design/images/openai.test.ts`, fake client): declarations
  validate; no variations; edit marked uncertain; price only with source;
  no deprecated or chat models; no key / unknown model → not ready, nothing
  sent; one request with `maxRetries: 0`; output type checked; references
  checked before sending; 4xx → failed, 5xx/connection/timeout → unknown and
  never resent; made-but-not-saved reported; key not stored; store pruning
  and id checks; `design_media` saves the image on its version in one call;
  restart recovery without a second request.
- End to end (`test/e2e/design-images.mjs` with `mocks/b-images.mjs`, Linux
  xvfb, mock OpenAI): settings tab, approval card text, the request OpenAI
  would get, the saved version, the image shown through `custard-media://`,
  an edit with an attached file, variation refused, 500 → unknown with no
  retry, decline, 400 → failed with the last good image kept, the key absent
  from Design files.

### Not verified

- Any live OpenAI request, model availability for a real key, real latency,
  real prices.
- The image viewer inside the workspace: it needs Workstream A's pane, which
  isn't on this branch. Its zoom and labels are typechecked and linted only.
- Windows and macOS.
