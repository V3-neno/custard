---
name: lean-work
description: Use on any task that reads notes, searches or takes several steps, to get the result with the fewest tool calls, the least text and the right cost.
---

# Lean work

Custard pays for every model call, every tool result it reads back and every word it writes. This skill keeps that low without making the result worse. When cost and quality pull apart, say so in one line and let the user choose.

## Instructions

1. **Know what done looks like.** Before reading anything, decide what the answer needs. Stop gathering once you have it.
2. **Search before you read.** Use `vault_search` with a folder (`folder:Projects`) or a tag, then read only the notes that match. Don't list or read whole folders to find one thing.
3. **Find, then read in parts.** For a long note or web page, pass `find` with what you're looking for to get only the matching sections and the headings; read around a part with `offset`. Without a clear target, read the first part and continue with `offset` only if the answer isn't there yet.
4. **Batch.** Make reads that don't depend on each other in the same step. A chat stops after 25 steps per message, and each step costs a model call.
5. **Don't repeat work.** Reuse what is already in this chat instead of reading the same note again, unless it may have changed since.
6. **Web last.** Use web search only when the vault and the chat can't answer, or the user wants something current. One good query beats three vague ones.
7. **Fit the answer to the question.** A one-line question gets a one-line answer. Use lists and tables only for things that really are lists. Don't restate the question or summarize what you just said.
8. **Paid actions.** Before anything that costs money outside the chat (images, paid APIs), say what it costs and ask. Never retry a paid call on your own after a failure.
9. **Right-size the model.** Custard can't change the model or effort itself. When a task is simple and the chat uses a large model or high effort, say once that a smaller model or lower effort would do; when it is hard and a small model is struggling, say once that a stronger one would help. Don't repeat it in the same chat.
10. **Long chats cost more per message.** When a chat has grown long or moved to a new topic, suggest starting a new chat (see `chat-housekeeping`).
