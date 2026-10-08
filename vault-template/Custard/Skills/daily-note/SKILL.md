---
name: daily-note
description: Use when the user wants to start, add to or review a daily note, journal entry or today's plan.
---

# Daily notes

Daily notes live at `Daily/YYYY-MM-DD.md`, using today's date in the user's local time. If you don't know today's date, ask.

## Starting today's note

1. Try `vault_read` on today's path. If it exists, don't recreate it; append to it instead.
2. Otherwise read `Templates/Daily.md`, replace `{{date}}` with today's date, fill in **Focus** from what the user said (ask for their top one to three things if they gave none), and create the note with `vault_create_note`.
3. Look at yesterday's note if it exists and carry over anything under **Tomorrow** that isn't done.

## Adding to today's note

Append a bullet under the right heading's spirit using `vault_append`. Since appends go to the end of the note, start the addition with a short bold label, e.g. `- **Notes:** Called the bank about the mortgage.`

## Reviewing

When asked how the day went, read the note and summarize what's done and what's still open.
