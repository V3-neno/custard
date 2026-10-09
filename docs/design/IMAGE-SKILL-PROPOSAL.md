# Example image skill (create it yourself if you want it)

An optional skill for making images in Design. **Custard doesn't ship it:**
it isn't in the app or the starter vault, and Design works the same without
it (the approval card, the job rules and the no-resend rule are enforced in
code). Skills can't grant permissions ([SKILLS.md](SKILLS.md#permissions)),
so this one can't either.

Neno reviewed it on 2026-10-09 and decided to publish it as an example for
users to read, rather than bundle it.

## Using it

1. Read it, and change anything you'd do differently.
2. In your vault, create `Custard/Skills/image-making/SKILL.md` and paste the
   file contents below into it. Or open the **Skills** mode and ask Custard
   to create it from this page.
3. Delete the folder to stop using it.

## What can go stale

Lines marked **[provider fact, checked 2026-10-09]** come from OpenAI's
documentation and can change; the source for each is in
[IMAGES.md, Evidence](IMAGES.md#evidence-checked-2026-10-09). The example
keeps them few and general on purpose: model ids, rates and limits stay in
`models.ts` and the approval card, which are what the user actually sees, not
in the skill. Everything else is Custard behaviour, which only changes with
the code.

## File contents

```markdown
---
name: image-making
description: Use in Design when the user wants a generated image, or a change to one: deciding between a new image and an edit, writing the prompt, and handling paid requests safely.
modes: design
---

# Making images in Design

1. **New image or a change?** Ask yourself which the user wants.
   - A new image: `design_media` with `image.generate`.
   - A change to an image: it has to be attached in this chat. Use
     `image.edit` with that attachment and `relation: "revision"` on the
     existing output, or `"variation"` to keep both side by side.
   - Variations as a separate operation aren't offered. A variation is a
     generate or an edit kept beside the original.
2. **Edits redraw the whole image.** [provider fact, checked 2026-10-09]
   OpenAI's documentation doesn't promise that untouched areas stay the
   same. Tell the user to check the parts they wanted kept, and don't claim
   anything was preserved exactly.
3. **Write the prompt in full.** Describe the subject, composition, setting,
   style, lighting and colour, and any text that must appear (quote it
   exactly). There's no separate style option: style goes in the prompt.
   Use the user's own words for what matters to them.
4. **Every request is paid and needs its own approval.** Say what you're
   about to make before calling the tool. The approval card shows the
   provider, the operation, any files sent and the published rate. A rate
   is not the price of the request: never state or guess a total cost.
5. **Never resend on your own.** If a job's outcome is unknown, or a request
   failed, don't send it again without the user's word. A repeat may run
   and be charged twice, and Design will warn about that. Don't call a
   failed or refused request free.
6. **Refusals.** If the provider refuses a prompt, pass on its reason in
   plain words and ask how the user wants to change it. Don't reword the
   prompt to get around a safety refusal.
7. **Check jobs only when asked.** `design_jobs check` reads what's stored or
   asks the provider once; don't loop on it.
8. **Don't fake it.** Never draw an illustration in HTML or SVG and present
   it as a generated image. If image generation isn't available, say why
   (Design settings explain it) and offer an HTML or SVG mock-up only as
   what it is.
9. **Size and format.** Ask only if it matters. Square, landscape (3:2) and
   portrait (2:3) at about 1,000 to 1,500 px work on every model Custard
   offers [provider fact, checked 2026-10-09]; PNG unless the user wants
   JPEG or WebP.
10. **Say what you made.** Name the output and version, say whether it was a
    new image or an edit of an attached file, and point the user to the
    workspace to compare versions or export.
```

## Notes

- **Overlap with Design's own rules.** Points 4, 5 and 8 restate rules
  Design already enforces in code (the card, no automatic resend, the job
  tracker). They're in the skill so the model explains them well. Removing
  them changes the wording, not the safety.
- **Not included:** model recommendations, prices, size limits beyond the
  three standard sizes, or quality settings. Custard doesn't send `quality`,
  `background` or arbitrary sizes ([IMAGES.md](IMAGES.md#models)), and those
  facts go stale fastest.
- **Point 6** (don't reword a prompt to get around a refusal) is kept on
  purpose.
