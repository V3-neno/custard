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
