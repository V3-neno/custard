# Dropdown redesign, Phase D1: investigation and design rules

Investigation only. No app code changed. This file is the only file added.

## Base branch

**`automation-thinking-p3` (draft PR #58, head `cb8fd15`).** I branched `dropdown-redesign-8lcr5u` from it, and the draft PR for this review goes into it.

Why: it is the tip of the only live stack. I checked on 2026-10-14 at about 14:45 UTC:

- `main` is `a2c934b` (merge of #35). Its tree is identical to `a8ec2e7`, the base of the model-profiles stack (`git diff a8ec2e7 origin/main` is empty).
- The open chain on top of that is #52 → #53 → #54 → #55 → #56 → #57 → #58. Each branch is an ancestor of the next (checked with `git merge-base --is-ancestor`), none of them is in `main`, and no branch on the remote was pushed after `automation-thinking-p3` (14:35 UTC).
- PRs #3 to #14 are still open as drafts, but they are from 2026-10-07/08 and their work reached `main` by other merges. They are not candidates.

So nothing new has been merged since the coordinator's note. If you merge part of the stack later, this branch only needs rebasing; it touches no code.

**Folder permissions.** The only folder-permission control that exists is **Settings → General → Editable folders** (`src/renderer/src/components/settings/EditableFolders.tsx`, built in PR #35, now in `main`). Its "What Claude may do there" control **is a native `<select>`** with three options (Create, Append, Edit). I found no newer folder-permission change on any branch: `git log --all -i --grep=folder` shows nothing after the Editable folders commits, and no remote branch name mentions folders or permissions.

## 1. Inventory

**Read in full:** `ModelPicker.tsx`, `SettingsDialog.tsx`, `settings/Automations.tsx`, `settings/DesignTab.tsx`, `settings/EditableFolders.tsx`, `chat/References.tsx`, `ModeBubbles.tsx`, `assets/main.css`, `settings/ui.ts`, `design/devices.ts`.
**Read in part:** `hubs/PluginDetail.tsx` (lines 100 to 200, the config form), `HistoryDrawer.tsx` (44 to 185), `design/Workspace.tsx` (15 to 25, 90 to 225), `settings/CapabilitiesTab.tsx` (130 to 170), `chat/Composer.tsx` (46, 100 to 180), `design/SkillsUsed.tsx` (15 to 131).
**Only grepped:** the rest of `src/renderer/src` (for `<select`, `role=`, `aria-haspopup`, `aria-expanded`, `aria-pressed`, `popover`, `datalist`, `Escape`, open/close state), and `plugin/`, `src/main`, `src/plugin-sdk` for selects in plugin or widget HTML (none found).

### A. Native `<select>` (9 elements in 5 files)

| # | Control | File:line | Chooses | Options | Label | Look |
|---|---|---|---|---|---|---|
| 1 | Settings → Default model | `SettingsDialog.tsx:241` | model for new chats | 8 built-in, grouped by provider (`<optgroup>`), plus models.json entries, plus a disabled "(no profile)" entry when needed | `title` only | local `select` string (`:216`): `rounded-lg border-forge-700 bg-forge-900 px-2 py-1.5 text-sm`, focus `border-molten-500/60` |
| 2 | Settings → Default effort | `SettingsDialog.tsx:270` | effort for new chats | 5 (Claude, OpenAI), 3 (DeepSeek), hidden for Haiku 4.5 | `title` only | same as 1 |
| 3 | Automation form → Skill to run | `Automations.tsx:371` | vault skill | one per skill in the vault, plus "Pick a skill" when none matches | `aria-label` | inline: `px-2 py-2`, `outline-none`, **no focus style** |
| 4 | Automation form → Model | `Automations.tsx:386` | model for runs | profiled models, grouped; unusable ones disabled with the reason in the text; plus a "no profile" entry | `aria-label` | inline: `px-2`, **no vertical padding**, `outline-none`, **no focus style** |
| 5 | Editable folders → What Claude may do there | `EditableFolders.tsx:106` | grant mode | 3: Create, Append, Edit | `aria-label`; help only in `title` | inline: `px-2`, no vertical padding, `outline-none`, **no focus style** |
| 6 | Design → Image provider | `DesignTab.tsx:105` | image provider | "None" + providers with state ("OpenAI · ready") | `<label for>` | shared `input` from `settings/ui.ts` |
| 7 | Design → Model | `DesignTab.tsx:134` | image model | the provider's models | `<label for>` | `input` |
| 8 | Design → Default video provider | `DesignTab.tsx:168` | video plugin | empty entry + plugins | `<label for>` | `input` |
| 9 | Plugin → Configuration (enum field) | `PluginDetail.tsx:138` | a manifest `enum` value | "Choose…" + the manifest's values | wrapping `<label>` **and** `aria-label` | `input` |

Keyboard for all nine: the platform's native select (arrows, type-ahead, Enter/Space opens, Escape closes, focus stays on the select). I did not test it on Windows or macOS.

### B. Custom popovers (2)

| # | Control | File:line | What it is | Keyboard today |
|---|---|---|---|---|
| 10 | Model picker (chip under the message box) | `ModelPicker.tsx:73` (chip class `Composer.tsx:46`) | chip opens a `role="dialog"` panel: provider tabs, model list (3 per provider), effort pills (5 or 3) | Tab reaches the chip; Enter opens. Focus does **not** move into the panel. Escape and outside click close (document listeners, `:47-58`). Focus is **not** returned. No arrow keys in tabs or list. |
| 11 | Reference an earlier chat | `References.tsx:68` | round icon button opens a `role="dialog"` with a search box (autofocused) and a list of chats (can be long) | Escape and outside click close. No arrow keys in the list (Tab only). Focus is not returned to the button. Tabbing out leaves the panel open. |

### C. Pill and segmented groups (the "short list" pattern, 10)

Not dropdowns, but they are what the redesign would use for short lists, and they already disagree with each other.

| # | Group | File:line | Selected style | State for screen readers |
|---|---|---|---|---|
| 12 | Model picker effort row | `ModelPicker.tsx:156` | `border-molten-500/60 text-molten-200` | `aria-pressed` |
| 13 | Automation effort row | `Automations.tsx:441` | same as 12 (copied) | `aria-pressed`, in a `fieldset` |
| 14 | Model picker provider tabs | `ModelPicker.tsx:99` | `bg-forge-700 text-ash-100` in a `rounded-full border p-0.5` track | `role="tab"`, no tabpanel |
| 15 | Settings tabs | `SettingsDialog.tsx:449` | same as 14 | `role="tab"`, no tabpanel |
| 16 | History filter (All, Chat, …) | `HistoryDrawer.tsx:80` | same as 14 (`filterChip`, `:44`) | **none** (`role="group"` only) |
| 17 | Capabilities: By provider / By model | `CapabilitiesTab.tsx:144` | same as 14 | `aria-pressed` |
| 18 | Design: Preview / Code, Desktop / Tablet / Phone | `Workspace.tsx:180`, `:189` | `molten-fill text-forge-950` (`pill`, `:15`) | **none** |
| 19 | Design: Versions | `Workspace.tsx:143` | `bg-molten-400/20 ring-1 ring-molten-400/50` | `aria-pressed` |
| 20 | Design: Outputs | `Workspace.tsx:107` | `molten-fill` | `aria-current` |
| 21 | Mode bubbles | `ModeBubbles.tsx:10` | `molten-fill` + glow | **none** |

### D. Looked at and not dropdowns

- Automation **times, days of the month and time zone** are free-text inputs (`Automations.tsx:473-494`), not selects. Runs per day and catch-up runs are number inputs. Your brief lists them as selects; the code disagrees.
- There is no "skills" or "modes" select in Settings. Skills are picked only in the automation form (#3); modes only in the mode bubbles (#21).
- `SkillsUsed.tsx:50`, code blocks' Show more (`Markdown.tsx:62`), `LongChat.tsx:169`, `<details>` lists in Automations and Editable folders, and the widget Expand/Compact pill (`WidgetSlot.tsx:148`) are disclosures or toggles, not choices from a list.
- No plugin or widget HTML in the repo contains a select.

## 2. The UI system as found

Tokens (`src/renderer/src/assets/main.css`, Tailwind 4 `@theme`):

- Surfaces: `forge-950` `#0a0705`, `forge-900`, `forge-850`, `forge-800`, `forge-700` (borders), `forge-600`.
- Text: `ash-100` (main), `ash-300`, `ash-400`, `ash-500` (muted).
- Accent: `molten-200`, `molten-300`, `molten-400`, `molten-500`; warning/danger: `ember-600`, `ember-700`; supported: `patina-300`, `patina-800`.
- Glow as RGB channels: `--glow`, `--glow-deep`, `--glow-ember`, used as `rgb(var(--glow) / 0.3)`.
- Provider tints: `:root[data-provider='openai']` and `'deepseek'` redefine the same tokens, so anything built from tokens follows the tint for free.
- Fonts: `Space Grotesk Variable` (sans), `JetBrains Mono Variable` (mono).
- Helpers: `.molten-fill` (amber gradient), `.forge-line` (hairline), checkbox/radio `accent-color: rgb(var(--glow))`.

Shared classes (`settings/ui.ts`): `button`, `primary` (`molten-fill text-forge-950`), `secondary` (`border border-forge-700 text-ash-300 hover:text-molten-200`), `danger`, `input` (`w-full rounded-lg border border-forge-700 bg-forge-900 px-3 py-2 text-sm outline-none focus:border-molten-500/60`).

Patterns used in several places but never named:

- Segmented track: `rounded-full border border-forge-700 p-0.5`, picked item `bg-forge-700 text-ash-100`, others `text-ash-400 hover:text-ash-100`.
- Effort pill: `flex-1 rounded-full border px-1.5 py-1 text-xs`, picked `border-molten-500/60 text-molten-200`, others `border-forge-700 text-ash-300`, `disabled:opacity-40`.
- Chip (`Composer.tsx:46`): `rounded-full border border-forge-700 bg-forge-900 px-3 py-1 text-xs text-ash-400`.
- Popover panel: `rounded-2xl border border-forge-700 bg-forge-850 p-3 shadow-xl` (model picker); the References panel uses `bg-forge-900` and a different shadow.
- List row: `rounded-lg px-2 py-1.5 text-sm`, hover `bg-forge-800`, picked `bg-forge-700 text-molten-200`, unusable `text-ash-500` with a reason line in `text-xs text-ash-500`.

Gaps:

- No written UI guide anywhere (`docs/` has none) and no UI tests beyond e2e behaviour checks.
- No select, menu, popover or pill-group component. Each one is hand-written.
- Four different "selected" treatments for pills (14, 12, 18, 19).
- No focus convention. Only 12 focus styles in the whole renderer and two `focus-visible` rings (`PluginsHub.tsx:199`, `SkillsHub.tsx:163`). Many controls set `outline-none` with nothing in its place.
- No `color-scheme` anywhere in the app (only inside widget frames, `src/main/widgets/surface.ts:18`), and no `nativeTheme.themeSource`. Native popups, scrollbars and spinners follow the operating system's theme, not Custard's dark theme.
- **`ash-200` is not a token** but is used 12 times (for example `ModelPicker.tsx:129`, `SettingsDialog.tsx:166`, `References.tsx:167`, `PluginDetail.tsx:120`). Tailwind generates nothing for it: the built CSS has `text-ash-100/300/400/500` and no `text-ash-200`. Those texts just inherit their parent's colour.
- No z-index scale (popovers use `z-20` and `z-30`, the Settings overlay `z-10`).

## 3. What is wrong today

By group, with the controls it applies to.

- **Look (1 to 9).** The closed selects are dark boxes with the platform's own arrow and font metrics. The open list is drawn by the platform, not by Custard: no amber picked row, no forge surface, no rounded panel. In the automation form shot (`custard/automations/phase-3-shots/effort-01-new-opus.png`) the selects sit next to Custard pills and inputs and look like a different app.
- **Size (3, 4, 5).** Three selects have no vertical padding or different padding (`px-2`, `px-2 py-2`), so their height comes from flex stretch and differs from the `input` next to them. Settings selects (1, 2) use `py-1.5`, Design selects (6 to 9) `py-2`.
- **Focus (3, 4, 5, 10, and the pills).** `outline-none` with no replacement on the three automation/folder selects and on the model picker chip. Keyboard users can't see where they are. Pills have no focus style either.
- **Dark theme and contrast (1 to 9).** With no `color-scheme: dark`, the open list may be light on a light-themed OS. Disabled options and optgroup labels are drawn by the platform, so their contrast is not ours. `ash-500` on `forge-850` reason lines is low contrast (not measured).
- **Long lists (3, 1, 4, 11).** The skill list grows with the vault, the model lists with models.json. Only type-ahead helps in selects. The References list has a search box but no arrow keys.
- **Keyboard (10, 11).** Popovers don't move focus in, don't trap or close on Tab-out, don't return focus, and have no arrow-key navigation.
- **Screen reader labels and roles.** Selects 1 and 2 are named only by `title`. Select 9 is named twice (label and `aria-label`). In the model picker, `role="option"` buttons are not inside a `listbox`, and tabs have no tabpanels. Pill groups 16, 18 and 21 expose no picked state at all.
- **Consistency of meaning.** Default model (1) lets you pick a model whose key is missing or rejected; the picker (10) greys it with a reason; the automation form (4) disables it with the reason in the text. Settings effort labels read "xhigh effort" while the picker says "X-High" (you chose to keep Settings labels in A1; noted, not proposed for change).
- **Electron/platform rendering.** Native select popups are drawn by the OS on macOS (Custard styling ignored) and partly styled on Windows and Linux. I could only see Linux under xvfb.
- **Grant mode help (5).** What Create/Append/Edit mean is only in a tooltip on the select (`title`), which keyboard and touch users never see.

## 4. Options

| Option | What it is | Cost | What could break |
|---|---|---|---|
| A. Restyle the native select | `appearance: none`, our chevron, `color-scheme: dark` | smallest | the open list stays platform-drawn (macOS ignores it); no reason lines; no consistent picked row |
| B. Customizable native select | the same `<select>`, styled with Chromium's `appearance: base-select` (button, `::picker(select)`, `option:checked`, `::picker-icon`) | small: one wrapper component and CSS | newer Chromium feature; React's handling of non-text option content not checked; needs a pilot on Windows |
| C. One custom React Select | button + `listbox` popover | large: arrows, Home/End, type-ahead, Escape, focus return, scrolling, clipping inside the Settings dialog's scroll box, screen reader checks, and every e2e `selectOption` call rewritten | everything we hand-write; about 33 e2e call sites in 16 suites |
| D. Pills for short lists | one `PillGroup` for 2 to 5 short fixed choices | small | e2e that drive those selects must click instead |

Custard ships only in Electron, so Chromium is known. Electron 39.8.10 bundles **Chromium 142.0.7444.265** (checked with `process.versions.chrome`). `appearance: base-select` shipped in Chrome 135, so B is available. I checked it in a throwaway probe outside the repo (a bare Electron window from this repo's `node_modules`, Linux under xvfb, not the Custard app): `CSS.supports('appearance', 'base-select')` is true, Space opens it, and the open list renders in the page with forge colours, a styled picked row, provider group labels and a disabled row. Screenshot: `custard/ui/d1-base-select-probe.png` (the "Â·" in it is the probe page's missing charset, not a Chromium bug; the white ring is Chromium's default option focus, which we would style).

**Recommendation: B + D.** One `Select` that is still a native `<select>`, styled with `base-select` to match the forge (panel, rows, picked row, focus ring), plus one `PillGroup` for short fixed lists. B keeps native keyboard behaviour, type-ahead, form semantics, screen reader roles, and Playwright's `selectOption`, so most e2e suites don't change. Its picker renders in the top layer, so the Settings dialog's scroll box won't clip it (a custom C would need a portal). If the pilot shows B misbehaving on Windows, fall back to C for `Select` only.

**The model picker in the chat box is out of scope** (your decision, 2026-10-14: don't change it). It stays as it is: no restyle, no behaviour change. Its keyboard and role findings above are reported only. The new rules and components are not applied to it, and its effort row stays the reference for the PillGroup look.

**Search and grouping.** Keep provider groups for models (base-select styles `optgroup` labels). Add no search for now: the longest lists today are 8 models and the vault's skills, and type-ahead covers them. The References panel keeps its search box and gains arrow keys. Time zone stays a text box; turning it into a list of `Intl.supportedValuesOf('timeZone')` (about 400 zones) would need search and is a behaviour change, so it is your call, not part of this plan.

## 5. Accessibility, platforms and e2e

Behaviour every control should end up with:

- Select (B): native. Tab focuses; Enter, Space or Alt+Down opens; arrows move; type-ahead jumps; Enter picks; Escape closes and focus stays on the select.
- PillGroup: `role="radiogroup"` with `role="radio"` and `aria-checked`, one Tab stop, arrows move and pick, as WAI-ARIA's radio group pattern. Or keep buttons with `aria-pressed` if you prefer one Tab stop per pill; pick one (I recommend radiogroup).
- Popovers (model picker, References): focus moves into the panel on open, Escape or picking closes and returns focus to the trigger, Tab out closes, arrows move in lists.
- High contrast: Windows forced colours not checked. Focus rings must use `outline` (kept in forced colours), not only `box-shadow`.

E2E suites that drive native selects (all keep working under B, since `selectOption` still works on a styled `<select>`):

| Select | Suites (call sites) |
|---|---|
| Default model | model-profile (2), model-picker (1), models-file (1), claude-turn (1) |
| Default effort | model-picker (1, reads option texts) |
| Skill to run | automations (2), catchup, hostile, questions, skills-hub, automation-effort |
| Model for the automation | automation-effort (7), model-picker (3, includes a screenshot) |
| What Claude may do there | automations, catchup, hostile, questions, vault-edit |
| Image provider | design-images, design-attachments, design-image-workspace, design-security, media-sizes |

Under D, converting **What Claude may do there** to pills changes 5 suites (one line each, best through a shared helper), and **Default effort** to pills changes `model-picker.mjs:443`. Nine suites drive the custom model picker through `data-pick`, `data-effort` and `aria-pressed` (model-picker, deepseek, model-profile, models-file, model-check, provider-matrix, provider-requests, responses-turn, round-trip). Keep those attributes; if pills move to `aria-checked`, the `aria-pressed` selectors in model-picker and automation-effort must change too. `plugins-hub.mjs:149` and `model-picker.mjs:195/298` check that old selects are absent; unaffected.

## 6. Proposed `docs/ui-dropdowns.md`

Proposed text only; not committed to `docs/`.

```markdown
# Dropdowns and choices

## Which control
- 2 to 5 fixed choices with short labels (one or two words): a PillGroup.
  Examples: effort, grant mode, Preview/Code, device width.
- More than 5 choices, or a list that grows (models, skills, plugins,
  providers): a Select.
- Choosing from a large, searchable set with extra detail per row (earlier
  chats): a popover with a search box and a list.
- Never a native <select> without the Select wrapper. Never a new
  hand-made menu.

## Select
- Use Select (a native <select> styled with base-select). Same height
  as `input` (py-2, text-sm), rounded-lg, border-forge-700, bg-forge-900.
- Open list: bg-forge-850, border-forge-700, rounded-xl, rows px-2 py-1.5,
  hover bg-forge-800, picked row bg-forge-700 text-molten-200.
- Group with optgroup when items have an owner (models by provider).
- An item that can't be used now is disabled and says why in its text
  ("Opus 5.5 · no key"). Don't hide it.
- A stored value that is no longer valid stays shown, disabled, with
  "(no profile)" or similar, until something else is picked.

## PillGroup
- One style: track `rounded-full border border-forge-700 p-0.5`;
  picked `border-molten-500/60 text-molten-200`; others
  `border-forge-700 text-ash-300 hover:text-molten-200`; text-xs.
- radiogroup: one Tab stop, arrows move and pick.
- When the whole group can't be used, disable it and say why above it.
- Help for each choice is visible text under the group, not a tooltip.

## States (all three)
- Focus: 2px outline in molten-500 at 60%, offset 2, on :focus-visible.
  Never `outline-none` without this.
- Disabled: opacity-40 and the reason in text nearby.
- Error: ember-600 text under the control.

## Labels
- Every control has a visible label or a legend. aria-label only when
  the label really can't be visible (the composer chip). Never `title`
  alone. Never both a label and an aria-label.

## Keyboard
- Select: native. PillGroup: arrows. Popovers: focus in on open; Escape,
  a pick or Tab-out closes and returns focus to the trigger.

## Don't
- Don't use colour tokens that aren't in main.css (there is no ash-200).
- Don't pick a provider tint colour directly; use the tokens.
- Don't put a choice's meaning only in a tooltip.
- Don't add search to lists under about 15 items.
```

## 7. Phased plan

Each phase is one draft PR, behaviour-preserving, with e2e updates, and a stop for your review.

1. **D2: foundation and pilot.** Add `docs/ui-dropdowns.md`; `color-scheme: dark` on `:root`; a focus-ring utility; decide `ash-200` (add the token or replace the 12 uses; your call); `Select` and `PillGroup` components; convert the **pilot**.
2. **D3: Settings.** Default effort, Editable folders grant mode (to pills, help shown), automation Skill and Model (Select), automation effort (PillGroup), Design tab's three selects.
3. **D4: Chat.** References keyboard and focus return only. The model picker is not touched.
4. **D5: Plugins.** Plugin config enum (Select), and the "Choose…" placeholder (see Other findings).
5. **D6: Other pill groups.** History filter, Capabilities view, Design view/width/versions/outputs, mode bubbles: same PillGroup states (look can stay where it's a deliberate accent, such as mode bubbles).

**Pilot: Settings → Default model.** It is the most visible native select, it has provider groups and a disabled "(no profile)" entry (the hardest cases for base-select), it changes no saved data, and four suites drive it with `selectOption` (including claude-turn with its golden), which proves the "e2e unchanged" claim. If the pilot passes on Linux and you confirm it on Windows, the rest is mostly mechanical.

## 8. Risks and other findings

Risks:

- `base-select` is new. I rendered it only in the Linux probe above, not inside Custard. Windows and macOS behaviour need your eyes.
- React and rich `<option>` content: not checked. Start with text-only options.
- `color-scheme: dark` also changes number spinners and any remaining native widget; intended, but visible.
- Fixing `ash-200` changes text colour in 12 places slightly.
- Moving pills to `radiogroup` changes Tab order (one stop per group) and some e2e selectors.

Other things I found (reported, not fixed):

- Settings is not a dialog to assistive tech: no `role="dialog"`, `aria-modal`, Escape or focus trap (`SettingsDialog.tsx:434`).
- Default model (1) lists unusable models as pickable, unlike the picker and the automation form.
- Plugin enum field (9): "Choose…" is a pickable empty value; saving it is refused by the main-side check (`src/main/plugins/schema.ts:100`). Not tried in the UI.
- Model picker: `role="option"` outside a `listbox`; tabs without tabpanels; its Escape listener is on `document`, so Escape anywhere closes it.
- The chip class still has `appearance-none cursor-pointer` from when it was a select (`Composer.tsx:46`).
- Grant mode help is tooltip-only (5).

## 9. Baselines on `automation-thinking-p3` (`cb8fd15`)

Container set up with `npm ci --ignore-scripts` then `node node_modules/electron/install.js`, and `npx electron-vite build` for e2e.

| Check | Result |
|---|---|
| Unit (`npx vitest run`) | 82 files, **1,304 passed**, 0 failed |
| Typecheck (`npm run typecheck`) | clean |
| ESLint `src` and `test` | clean (0 problems) |
| ESLint whole repo | 545 problems (14 errors, 531 warnings), all in `plugin/spotify` (known, out of scope) |
| e2e (one suite at a time, counting ✓/✕ lines) | 48 suites, 1,528 checks: 1,527 passed, 1 failed (see below) |

The one failure was in `media-sizes`: "the app window never stalled for a second" (1,082 ms against a 1,000 ms limit). That is a timing check. Rerun alone, it failed again (1,648 ms); a third run alone passed 41/41, with the slowest case at 590 ms. Nothing else was running during those runs. I read it as this container being slow at times, not a product fault, but it is not proven. The 1,528 total matches the Phase 3 review's count for this commit. No golden file changed.

## 10. Not verified

- Windows and macOS: how native selects and their open lists look, and whether `base-select` renders and behaves the same there.
- `base-select` inside Custard (with Tailwind, the provider tints and the Settings dialog): only the bare Linux probe was run.
- A screen reader (NVDA, VoiceOver) and Windows high-contrast mode.
- The packaged build.
- Screenshots of the current controls: I took none. The only new screenshot is the base-select probe. The descriptions of the automation form and the model picker come from the earlier shots `custard/automations/phase-3-shots/effort-01-new-opus.png` and `custard/providers/phase-6/picker-01-claude-tab.png` (the latter predates the effort row moving into the panel), plus the code.
- Contrast ratios were not measured.
