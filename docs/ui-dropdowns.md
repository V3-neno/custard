# Dropdowns and choices

How Custard lets you pick from a list. The look comes from the chat box's
model picker; the picker itself (`components/chat/ModelPicker.tsx`) is left as
it is and doesn't use these components.

## Which control

- **2 to 5 fixed choices with short labels:** a `PillGroup`
  (`components/ui/PillGroup.tsx`). Examples: effort, what Claude may do in a
  folder.
- **More than 5 choices, or a list that grows** (models, skills, providers,
  a plugin's options): a `Select` (`components/ui/Select.tsx`).
- **A large, searchable set with detail per row** (earlier chats): a popover
  with a search box and a list, like "Reference a chat".
- Never a bare `<select>` without `Select`. Never a new hand-made menu.

## Select

- A native `<select>` with the `select` class (`assets/main.css`), drawn with
  Chromium's customizable select (`appearance: base-select`). Keyboard,
  type-ahead, screen readers and Playwright's `selectOption` work as for any
  select.
- Closed: like an input (`rounded-lg`, `border-forge-700`, `bg-forge-900`,
  `text-sm`, `py-2`). Open: the picker's panel (`bg-forge-850`,
  `rounded-2xl`, rows `rounded-lg px-2 py-1.5`, hover `bg-forge-800`, picked
  `bg-forge-700 text-molten-200`).
- Group with `<optgroup>` when items have an owner (models by provider).
- An item that can't be used now is disabled and says why in its text
  ("Opus 5.5 · no key"). Don't hide it.
- A stored value that is no longer valid stays shown, disabled, until
  something else is picked.
- Options are plain text.

## PillGroup

- The model picker's effort row: `rounded-full border px-1.5 py-1 text-xs`,
  picked `border-molten-500/60 text-molten-200`, others `border-forge-700
text-ash-300`.
- A radio group: one Tab stop, the arrow keys move and pick, Home and End
  jump to the ends. Each pill has `data-value`.
- When the whole group can't be used, disable it and say why above it.
- Help for the picked choice is visible text under the group, not a tooltip.

## States

- **Focus:** a 2px outline in the accent at 60%, offset 2, on
  `:focus-visible` (`focus-ring`, or built into `select`). Never
  `outline-none` without something in its place.
- **Disabled:** 40% opacity and the reason in text nearby.
- **Error:** `ember-600` text under the control.

## Labels

- Every control has a visible label or legend and an accessible name
  (`aria-label` or `<label for>`). Never `title` alone.

## Keyboard

- Select: native. PillGroup: arrows. Popovers: focus goes in on open; Escape,
  a pick or tabbing out closes, and Escape or a pick puts focus back on the
  button that opened it.

## Don't

- Don't use colour tokens that aren't in `main.css`.
- Don't use a provider tint's colours directly; use the tokens.
- Don't put a choice's meaning only in a tooltip.
- Don't add search to lists under about 15 items.
