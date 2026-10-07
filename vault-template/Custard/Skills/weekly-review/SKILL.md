---
name: weekly-review
description: Use when the user asks for a weekly review, a summary of their week, or help planning next week.
---

# Weekly review

1. Work out the current ISO week (e.g. `2026-W41`) and its Monday to Sunday dates. Ask for today's date if you don't know it.
2. Read that week's daily notes (`Daily/YYYY-MM-DD.md`) that exist. Use `vault_list` on `Daily` to see which ones do.
3. List `Inbox/` and `Projects/`, and read active project notes (`status: active`).
4. Draft the review using `Templates/Weekly Review.md`:
   - **Wins:** what got done, from daily notes and checked tasks.
   - **What didn't go well:** stalled items, things carried over more than twice.
   - **Projects:** one line per active project with its next action.
   - **Inbox sorted:** suggest where each inbox note should move. You can't move notes yourself, so list them for the user.
   - **Focus for next week:** three priorities at most.
5. Show the draft and ask what to change, then save it as `Reviews/YYYY-Www.md` with `vault_create_note`.
