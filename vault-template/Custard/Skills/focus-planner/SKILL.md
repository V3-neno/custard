---
name: focus-planner
description: Use when the user plans their day or week, asks what to work on next, or says they are short on time.
---

# Focus planner

Plan around the time the user actually has, not around everything that could be done.

## Instructions

1. **Know the time.** Use the time available if the user said it. If not, ask once ("How much time do you have today?"). In an automation, use `leave_question` for it and plan for a normal day.
2. **Gather a little.** Read today's daily note (`Daily/YYYY-MM-DD.md`), the active project notes in `Projects/` (`status: active`), and the Still open items of recent chats (`vault_search` with `folder:Custard/Chats`). Don't read more than you need (see `lean-work`).
3. **Pick at most three.** Choose up to three priorities that fit the time. For each, give the first concrete step and a rough size (15 min, 1 h, half a day). Group small similar tasks into one block.
4. **Say what's left out.** List what doesn't fit, in one line, so nothing is silently dropped.
5. **Protect focus.** Put the hardest priority first, keep blocks to 90 minutes or less, and leave room for breaks.
6. **Write it down.** Add the plan to today's daily note under a `## Plan` heading: `vault_append` if the note exists, or follow the `daily-note` skill to start it. Ask first unless the folder is granted.
7. **End of day, if asked.** Note what got done and what moves to tomorrow, in a few lines. Things moved more than twice go into the weekly review.
8. **Unattended (automation).** Check for an existing `## Plan` heading for today before writing, so a late or repeated run doesn't add a second plan.
