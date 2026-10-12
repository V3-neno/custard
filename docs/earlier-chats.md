# Earlier chats as reference

New chats can draw on earlier ones through their summary notes in
`Custard/Chats` (one per chat, written by `src/main/chatNotes.ts`). The code is
in `src/main/earlierChats.ts`. The full earlier chat is never sent, only its
note.

## Three ways in

- **Listed in every chat.** When automatic memory is on for the chat, the
  prompt lists the newest 5 earlier chats with their title, mode, date, id,
  goal and where each stands, in up to 2,500 characters. The chat's own note is
  never listed.
- **Looked up by the model.** `chats_search` finds chats by words in their
  title and note, up to 8 at a time. `chats_read` returns one note by chat id
  (the first 8 characters are enough), up to 12,000 characters. Both are vault
  reads, offered whenever the vault is connected, and change nothing.
- **Referenced by the user.** The chat-bubble button beside the paperclip lists
  chats that have a note. Up to 3 can go with a message and up to 8 in one
  chat. The note is kept on the chat as it was when sent, so later messages
  see the same text, and the sent message shows what it referenced. Clicking a
  reference opens that chat.

## What is never used

Temporary and forgotten chats have no note, so they never appear anywhere
here. A temporary chat, or a chat with memory off, gets no list (the same rule
as captures), but it can still use the tools and references. A note the user
deleted is gone. An edited note is read as it is now, except a reference,
which keeps the text it had when sent.

## Outside text

A note says whether its chat held text from the web or a plugin
(`outside: "true"`), and a note that doesn't say counts as if it did. A chat
counts as holding outside text once it sees what such a note says: by
`chats_search`, by `chats_read`, or by a reference. It then shows the "Outside
text" pill, and changes to notes ask first.

The list in every prompt shows only the title of such a chat. The title comes
from the user's first message. Without this, one chat with web text would
make every chat after it hold outside text, and their notes would pass that
on.

## Tests

`src/main/earlierChats.test.ts` covers the rules above.
`test/e2e/earlier-chats.mjs` (31 checks, with `test/e2e/mocks/e-earlier.mjs`)
covers the built app.
