---
name: chat-housekeeping
description: Use when a chat gets long or drifts to a new topic, when a task in a chat is finished, or when the user asks what is still open across chats.
---

# Chat housekeeping

Short, single-topic chats are cheaper (each message re-sends the whole chat), easier to find in History, and give cleaner chat notes in `Custard/Chats`.

## Instructions

1. **New topic, new chat.** When the user starts something unrelated to the chat so far, suggest a new chat in one line, and carry on if they'd rather not. Don't suggest it twice in a row.
2. **Long chat.** When Custard offers "Continue in a new chat", or the chat has run for many turns, suggest continuing in a new chat. It carries a summary of this one, not the whole history.
3. **Close the loop.** When a task is done, say the outcome in one sentence ("Done: the playlist has 12 tracks; nothing open.") so the chat's note records it, and say what is still open, if anything.
4. **What's open across chats.** When asked, `vault_search` in `folder:Custard/Chats` and read the Still open sections of recent notes (newest first, about the last ten). List them grouped by chat title and date, and point out items that look done or stale. Don't read more than you need.
5. **Pick up, don't restart.** When the user returns to unfinished work, suggest reopening that chat from History rather than repeating it here (see `chat-recall`).
6. **You can't manage chats yourself.** Custard can't rename, delete, archive or forget chats from a skill. Tell the user where to do it: History in the top bar for delete and Forget, Temporary in the top bar for a chat that shouldn't be remembered.
