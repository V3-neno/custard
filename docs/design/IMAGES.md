# Design: built-in images (OpenAI)

Workstream B, Phase 3. Code in `src/main/design/images/`, the viewer in
`src/renderer/src/components/design/viewers/ImageViewer.tsx`, settings in
`src/renderer/src/components/settings/DesignTab.tsx`.

**Everything here is mock-tested only.** No request has been sent to OpenAI.
Model names, endpoints, parameters, limits, deprecations and rates were
re-checked against OpenAI's own sources on 2026-10-09; see
[Evidence](#evidence-checked-2026-10-09) for each URL and what it does and
doesn't establish. Whether a given key can use these models (organization
verification, usage tier) is unverified until a live test is approved
([LIVE-TEST-PROPOSAL.md](LIVE-TEST-PROPOSAL.md)).

## What it does

| Operation         | Status in Custard                  | How                                  |
| ----------------- | ---------------------------------- | ------------------------------------ |
| `image.generate`  | supported                          | `POST /v1/images/generations`        |
| `image.edit`      | quality-uncertain                  | `POST /v1/images/edits`, multipart   |
| `image.variation` | unsupported                        | variations endpoint retired (see E4) |
| video             | not offered by B (plugins only, C) |                                      |

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

| Model                    | Note (OpenAI's own wording)                            | Pricing on the card                 | Evidence        |
| ------------------------ | ------------------------------------------------------ | ----------------------------------- | --------------- |
| `gpt-image-2.5-sunburst` | most capable for image generation and editing; default | published per-token rates, standard | E1, E2, E2b, E3 |
| `gpt-image-2.5-flare`    | fast, high-quality everyday generation                 | published per-token rates, standard | E1, E2, E2b, E3 |
| `gpt-image-2`            | previous generation                                    | none ("No price information")       | E1, E2a, E3     |

All three ids are accepted by the SDK's `ImageModel` type and listed as valid
for both `/v1/images/generations` and `/v1/images/edits` (E1). The 2.5 models
also have dated snapshots (`…-2026-09-08`) and `gpt-image-2` has
`gpt-image-2-2026-04-21`; Custard uses the undated aliases, which OpenAI may
move to a newer snapshot. `gpt-image-2` has no deprecation notice (E4) but is
no longer on OpenAI's models overview, which lists only the two 2.5 models
(E2); it stays offered because the API and SDK still accept it, and it is
**not** the default.

Left out on purpose (E4, deprecations page, rows copied 2026-10-09):
`dall-e-2` and `dall-e-3` (shut down 2026-05-12), `gpt-image-1` (shutdown
October 23, 2026), `gpt-image-1-mini`, `gpt-image-1.5` and
`chatgpt-image-latest` (shutdown Dec 1, 2026; replacement
`gpt-image-2.5-sunburst` or `gpt-image-2.5-flare`). Chat models are never
used for images.

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
  - refused by Custard before calling OpenAI (no key, no model, a bad
    reference, stopped first) → job **failed**, dispatch `not-dispatched`,
    repeat `safe`;
  - 4xx answered by OpenAI → job **failed**, dispatch `rejected` (it was
    sent; OpenAI refused it and made no image), repeat risk `unknown`:
    OpenAI doesn't document whether a refused request is billed (E7), so a
    repeat still warns. 401/403 → unconfigured, 404 → unsupported, 429 →
    temporary, others rejected;
  - 5xx, dropped connection, timeout (10 minutes) or stopping the turn → it
    may have run → job **unknown**, repeat risk `unknown`; it is never resent,
    and the model is told to ask the user first;
  - OpenAI returned an image Custard couldn't save → job **unknown**, repeat
    risk `may-duplicate` (it ran and was probably charged).
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

(Thread 2 of the stabilization batch owns the recovery items below.)

- If Custard stops after OpenAI answered but before the image is written to
  disk, the image is lost and the job is unknown; OpenAI may still charge it.
- If it stops after the image is written but before the job records its id,
  the job is unknown with no reference, and the stored image is deleted at
  the next start. Recovering it would need a contract change.
- A chat deleted while its image waits to be collected leaves the stored copy
  until the next start.

## Pricing

OpenAI bills GPT Image models by tokens and publishes **rates, not
per-request prices** (E2b, E3). How many tokens one image uses isn't known
before it is made, the SDK reports `usage` in the response only for
`gpt-image-1` (E1), and OpenAI says its GPT Image 2 cost calculator doesn't
estimate GPT Image 2.5 token use (E2b). So Custard computes no total.

- The approval card says: "Pricing, not a quote for this request: image
  output $30.00, image input $8.00, text input $5.00 per 1M tokens; the total
  depends on how many tokens the image uses (from OpenAI API pricing page and
  model page, standard tier, checked 2026-10-09). Custard doesn't know the
  total before it runs." Design settings use the same wording.
- `gpt-image-2`: the pricing page's only `gpt-image-2` rows sit in a table
  whose rates are exactly half the 2.5 standard rates and match the Batch
  rates stated on the 2.5 model pages; the 2.5 Sunburst page says its token
  rates "match GPT Image 2". That suggests $8/$30/$5 standard, but no page
  states it for `gpt-image-2` directly, so **no price is shown** ("No price
  information from the provider.").
- A plugin's pricing text is shown with the same "not a quote" wording; it
  is the plugin's claim, with the source it gives.
- Rates go stale. They are in `models.ts` with the date checked; re-check E3
  and E2b before relying on them.

## Design settings tab

Image provider and model, default video provider (C's plugins), and "What
Design can do now" from the capability report, each line with its reason.
Nothing is switched automatically: with no provider chosen, Design says so.

## Skill guidance (for the image skill)

The image skill ships in the starter vault
(`vault-template/Custard/Skills/image-making/SKILL.md`); see
[IMAGE-SKILL-PROPOSAL.md](IMAGE-SKILL-PROPOSAL.md). Design doesn't depend on
it.

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

- Integrated workspace (`test/e2e/design-image-workspace.mjs` with
  `mocks/s3-image-workspace.mjs`, stabilization 3.3): request → card →
  stored result → the image **drawn** in the workspace pane (the centre pixel
  the window composited is sampled through `webContents.capturePage`, not
  just the element found) → an edit as v2, drawn → selecting v1 draws v1
  again and is saved → restart and reopen draws the selected v1 → Export and
  Save a copy write the stored bytes (sha-256). Also the repeat card after an
  unknown edit (provider, operation, files, rate wording, warning), and plugin
  video in the same pane: a finished video loads and plays in the workspace's
  own `<video>`; a video still in progress should show its job state and
  Check now / Cancel job / Stop tracking (needs request stab-3 R2).

### Not verified

- Any live OpenAI request, model availability for a real key, organization
  verification, real latency, real token use and cost.
- Whether OpenAI bills a refused (4xx) request.
- Windows and macOS.

## Evidence (checked 2026-10-09)

Only public, unauthenticated sources. `developers.openai.com`,
`platform.openai.com` and `api.openai.com` are blocked by this container's
proxy for direct downloads (the one unauthenticated `curl` attempt, a GET of
`/v1/models`, was refused by the proxy and never reached OpenAI). Pages were
read through a fetch tool that summarises; where that matters it says so
below. The SDK source is the raw text of OpenAI's own published package.

| #   | Source                                                                                             | Establishes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Doesn't establish                                                                                                                                     |
| --- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1  | OpenAI Node SDK `openai@7.30.0`, `resources/images.d.ts` (installed from npm; raw text)            | `ImageModel` ids incl. `gpt-image-2`, `gpt-image-2.5-sunburst`, `gpt-image-2.5-flare` and dated snapshots; generate and edit take all three; edit: up to 16 png/webp/jpg images, each < 50 MB; `output_format` png/jpeg/webp; standard sizes `1024x1024`, `1536x1024`, `1024x1536` on every GPT image model; `n` 1–10; `response_format` unsupported for GPT image models (always base64); `createVariation` "retired and no longer available"; `usage` returned "for `gpt-image-1` only"; `input_fidelity` must be omitted for `gpt-image-2` | Availability for a given key; prices                                                                                                                  |
| E2  | https://developers.openai.com/api/docs/models (summarised)                                         | The models overview lists only `gpt-image-2.5-sunburst` ("most capable model for image generation and editing") and `gpt-image-2.5-flare` ("fast, high-quality everyday image generation") under Image                                                                                                                                                                                                                                                                                                                                        | Anything about `gpt-image-2`                                                                                                                          |
| E2a | https://developers.openai.com/api/docs/models/gpt-image-2 (summarised)                             | `gpt-image-2` exists, snapshot `gpt-image-2-2026-04-21`, endpoints include generations and edits (not variations), no deprecation note; rate limits Free not supported, Build 20 IPM                                                                                                                                                                                                                                                                                                                                                          | Its price                                                                                                                                             |
| E2b | …/models/gpt-image-2.5-sunburst and …/models/gpt-image-2.5-flare (summarised)                      | Snapshots `-2026-09-08`; endpoints generations, edits, Responses (not variations); standard rates text $5.00, image input $8.00, image output $30.00 per 1M tokens (Batch output $15); "Token rates match GPT Image 2"; the GPT Image 2 calculator doesn't estimate 2.5 token use; Free tier not supported                                                                                                                                                                                                                                    | A per-image price                                                                                                                                     |
| E3  | https://developers.openai.com/api/docs/pricing (summarised, twice)                                 | Standard table: both 2.5 models image $8.00 / cached $2.00 / output $30.00, text $5.00 / cached $1.25. A second table with half those rates contains `gpt-image-2` and both 2.5 models; its tab label is lost in extraction                                                                                                                                                                                                                                                                                                                   | Whether that second table is Batch (likely, from E2b); any per-image price ("use the calculator")                                                     |
| E4  | https://developers.openai.com/api/docs/deprecations (rows copied verbatim)                         | Shutdowns listed under Models above; `gpt-image-2` not deprecated                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Anything about the variations endpoint (not listed); see E4a                                                                                          |
| E4a | https://developers.openai.com/api/reference/resources/images/methods/create_variation (summarised) | Still documents the endpoint as "only supports `dall-e-2`"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Contradicts E1's "retired" note. Either way it can't run: its only model, `dall-e-2`, was shut down 2026-05-12 (E4). Custard doesn't offer variations |
| E6  | https://developers.openai.com/api/docs/guides/image-generation (summarised)                        | Image API = generations and edits; "you may need to complete the API Organization Verification … before using GPT Image models" (the 403 message's hint)                                                                                                                                                                                                                                                                                                                                                                                      | Whether edits keep untouched regions (not stated: Custard keeps `preservesUnchanged: false`); refusal billing                                         |
| E7  | https://developers.openai.com/api/docs/guides/error-codes (summarised)                             | Error causes for 401/403/429/500/503; retry advice for 500/503/timeouts (Custard deliberately doesn't retry paid requests)                                                                                                                                                                                                                                                                                                                                                                                                                    | Whether any failed or refused request is billed: **not stated**                                                                                       |
