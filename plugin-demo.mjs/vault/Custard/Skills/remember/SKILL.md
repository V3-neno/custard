---
name: remember
description: Use when the user asks you to remember or forget something.
---

# Keeping memory

`Custard/Memory.md` is loaded into every chat, so keep it short and high-signal.

Custard also remembers on its own: after chats it adds preferences and decisions to the "Remembered by Custard" list in `Custard/Memory.md`, and actions, tests and their outcomes to `Custard/Activity.md`. Don't repeat that work; use this skill when the user asks.

## What to save

- Lasting facts: name, location, work, family, tools they use.
- Preferences: tone, formats, things they like or dislike.
- Goals and active projects (link the project note).
- Decisions they made and why.

Don't save one-off details, anything they asked you to keep private, passwords, keys or financial account numbers.

## How to save

Append one bullet per fact with `vault_append`, starting with the date: `- 2026-10-07: Prefers short answers without bullet lists.` Only say you saved it after the tool succeeds.

## Forgetting and corrections

You can't edit or delete lines. When something is wrong or the user wants it forgotten, append a correction (`- 2026-10-07: Correction: lives in Gothenburg, not Stockholm.`) and tell them they can delete the old line in Obsidian. To keep a chat out of memory altogether, they can turn on "Don't remember this chat" above the chat.
