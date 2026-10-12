---
name: note-writing
description: Use whenever you create a new note in the vault, so it lands in the right folder with consistent naming, frontmatter and links.
---

# Writing notes in this vault

1. **Pick the folder.**
   - Has a goal and an end → `Projects/`
   - Ongoing responsibility → `Areas/`
   - Reference or topic knowledge → `Resources/`
   - Unsure, or a quick capture → `Inbox/`
   - About a specific day → `Daily/` (see the daily-note skill)
2. **Name it** in plain Title Case words, no dates unless it's a daily or review note: `Resources/Sourdough Bread.md`, not `resources/sourdough-bread-notes-2026.md`.
3. **Search first** with `vault_search`. If a note on the topic already exists, append to it with `vault_append` instead of creating a near-duplicate.
4. **Start with frontmatter** containing `tags` (lowercase, singular, e.g. `[recipe]`) and, where it fits, `status` or `source`.
5. **Write for future skimming:** a one-line summary under the title, then short sections with headings and bullets.
6. **Link generously** with `[[wikilinks]]` to notes you know exist (from search results or the folder listing). Don't invent links to notes that don't exist unless you're creating them too.
7. Tell the user the path of the note you created.
