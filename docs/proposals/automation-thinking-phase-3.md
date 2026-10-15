# Automations that think: Phase 3 review (the form)

**Base branch: `automation-thinking-p2` (a1e43ea).** Nothing in the chain is merged (main is still a2c934b). The chain is A1 → A2 → A3 → A4 → `automation-thinking` (#56) → `automation-thinking-p2` (#57), all open drafts. p2 is the tip and the only branch with the Phase 2 work, so this branch, `automation-thinking-p3`, starts there and its draft PR goes into it. Nothing was merged.

**Where your brief and the reviews differ, or where I had to choose:**

- Decision 3 says an old automation shows "Not set (the provider's default)" and that saving it gives it a level. The form can't do both with "Not set" as the selection, so it shows the note **and** pre-selects the model's `otherwise` level, and the note says what saving sets: "Not set (the provider's default). Saving sets Medium." You can't save an automation back to "not set" from the form.
- Decision 2's wording ("Haiku 4.5 takes no effort level") differs from the picker's ("Haiku 4.5 doesn't take an effort level"). I used yours.
- Decision 5 says "levels above Medium". DeepSeek has no Medium, so its line says "Levels above Balanced cost more." Claude and OpenAI say "Levels above Medium cost more."
- The Phase 2 review said a hand-set effort survives an edit because `save()` spreads the stored automation. The form now sets the effort itself, so that is no longer how it survives: the form shows the stored level and saves it. On Haiku 4.5, a hand-set effort is removed on save, because decision 2 says no effort is saved.

## 1. What changed

- **Effort control** under the model select in Settings → Automations (decisions 1 to 5 and 8). See section 2.
- **Run list:** each run that has a model shows a line with the model and effort it used (decision 6).
- **models.json:** a customisation of `claude-haiku-4-5` (provider `claude`) with `"thinking": true` is rejected (decision 7). The reason given is: `Haiku 4.5 can't think the way Custard asks: Anthropic's API rejects adaptive thinking on it. Leave "thinking" out.` It is identified by id and provider, the same way as the effort rule. `"thinking": false` still loads.
- **Bug fix:** the model select showed the first listed model when the saved model had no profile, while the form kept the saved one. It now lists the saved model as "claude-gone-1 · Its profile is missing.", using the same pattern as the skill select's missing skill.
- **Docs:** docs/automations.md (the effort control, the run list line), docs/models-file.md (the Haiku thinking rule).

Requests didn't change: nothing under `src/main/adapters` or `src/main/automations` changed apart from a docs test.

**Files:**

- `src/shared/automationEffort.ts` (new): `formEffort`, `effortControl`, `runModelText`. Pure logic, used by the form.
- `src/renderer/src/components/settings/Automations.tsx`: form state, the control, save, the model select, the run line.
- `src/shared/models.ts`: `EFFORT_LABELS` is exported (to name a stored level the model doesn't list).
- `src/main/modelsFile.ts`: the Haiku thinking rule.
- Tests: `src/shared/automationEffort.test.ts` (new), `src/main/modelsFile.test.ts`, `src/main/automations/docs.test.ts`, `test/e2e/automation-effort.mjs` (new).

## 2. What the form and run list look like

The screenshots are in `/mnt/project-files/custard/automations/phase-3-shots/`.

- **New on Opus 5.5** (`effort-01-new-opus.png`): under the skill and model selects, "Effort for Opus 5.5", then five pill buttons Low, Medium, High, X-High, Max with Medium picked (amber border). Under them in small grey text: "Levels above Medium cost more." Saved as `medium`.
- **Old automation** (`effort-04-old.png`): the same, with Medium picked and an extra line "Not set (the provider's default). Saving sets Medium." The line follows whichever button you pick.
- **Haiku 4.5** (`effort-03-haiku.png`): "Haiku 4.5 takes no effort level", with the five Claude buttons greyed out and no cost line. Saved with no effort.
- **DeepSeek** (`effort-02-deepseek.png`): Fast, Balanced, Thorough, with Balanced picked and "Levels above Balanced cost more."
- **A stored level DeepSeek doesn't list** (`effort-05-unlisted.png`): Balanced picked, and "Saved as Medium, which DeepSeek Flash doesn't list, so it sends Balanced." Saving stores `high`.
- **No profile** (`effort-06-no-profile.png`): no buttons, just "claude-gone-1 has no profile, so its effort levels can't be shown. The saved effort (High) is kept." Saving keeps the model and `high`.
- **Changing the model:** the picked level is re-mapped with `shownLevel` (X-High stays X-High on GPT-6 Astra and becomes Balanced on DeepSeek Flash). Haiku clears it. Coming back from Haiku starts at the model's `otherwise` level.
- **Run list** (`effort-08-run-list.png`): a line under the status line reads "Opus 5.5 · High", "Opus 5.5 · effort not set", "Haiku 4.5" or "DeepSeek Flash · Balanced". A record without a model (older ones, skipped slots) has no line and looks as before.

**Reused UI pieces:**

- The buttons copy the model picker's effort row exactly (`ModelPicker.tsx`): `flex gap-1`, each button `flex-1 rounded-full border px-1.5 py-1 text-xs`, picked `border-molten-500/60 text-molten-200`, unpicked `border-forge-700 text-ash-300`, greyed with `disabled:opacity-40`. The labels come from the profile's `label`, like the picker.
- The heading uses the form's existing legend style (`mb-1 text-xs text-ash-400`, like "Folders it may change"). The notes use the existing small-text styles (`text-xs text-ash-500` / `text-ash-400`).
- The row is kept to `max-w-sm` so the buttons are about the picker's width.
- No new component and no dropdown. Settings → Default model uses a `<select>` for effort; I didn't copy that, per your note about the dropdown redesign.

## 3. Other places that show automations

None needs effort, and none was changed.

- **Skills hub card** (`SkillsHub.tsx`): only counts the automations that run a skill.
- **Skill panel** (`SkillPanel.tsx`, `SkillWorkspace.tsx`): only lists names, with "(off)".
- **Recent changes** (`EditableFolders.tsx`): marks a change "(automation)".
- **Questions flow:**
  - Settings shows each open question with the automation's name and time.
  - Chat (`chat.ts`, `automations/chatTool.ts`) gets the question text only.
  - No model is shown anywhere in this flow.
- **Editing:** the Settings form is the only place that edits an automation. The other way to set one is the `automations.save` IPC, which `checkAutomation` checks as before.

## 4. Tests and results

Every run below was against local stand-ins. Suites ran one at a time, and never alongside the unit tests. One exception: while the base e2e run was 8 suites in, I ran one unit file (`modelsFile.test.ts`, 23 tests) once. The base run still finished with 0 failures.

| Check                       | Base (p2, a1e43ea)                  | After                                                                                                                                                                           |
| --------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit (vitest)               | 1,284 passed, 81 files              | 1,304 passed, 82 files (+20, 0 failed)                                                                                                                                          |
| Typecheck (node + web)      | clean                               | clean                                                                                                                                                                           |
| eslint `src test`           | clean                               | clean                                                                                                                                                                           |
| e2e (my counter, ✓/✕ lines) | 47 suites, 1,480 checks, 0 failures | 48 suites, 1,528 checks (+48), 0 failures                                                                                                                                       |
| Goldens                     | —                                   | identical: no golden file changed; provider-requests and the claude-turn/responses-turn suites compare against them and passed; the unit goldens (`src/main/__golden__`) passed |

**New unit tests (20):**

- `automationEffort.test.ts` (16):
  - what the form holds for new, stored, unlisted, Haiku and no-profile cases, and for model changes;
  - what the control shows in each case, including DeepSeek labels and the cost line;
  - the run list text, with and without model and effort, Haiku, an unknown model, a renamed model.
- `modelsFile.test.ts` (3), for the Haiku thinking rule:
  - rejected, including alongside another change;
  - `false` or left out still loads;
  - Sonnet and a Haiku alias under another id keep `thinking: true`.
- `docs.test.ts` (1): the docs no longer say the form or run list lacks this.

**New e2e suite `automation-effort` (48 checks):**

- creating on Opus (Medium picked and saved);
- picking a level, then changing the model (X-High re-mapped on GPT-6 Astra and on DeepSeek, Haiku cleared and greyed, back to Medium on Opus);
- a Haiku automation saved with no effort;
- DeepSeek labels, with Thorough saved as `max`;
- an old automation (shows Not set, saved with `medium`);
- a hand-set `xhigh` (shown, still `xhigh` after a save);
- an unlisted `medium` on DeepSeek (Balanced, said so, saved as `high`);
- a missing profile (no page error, kept model and effort);
- the run list, on a real Run now against the mock ("Opus 5.5 · Medium") and on five written records (with model and effort, model only, Haiku, DeepSeek medium, and an old record with neither).

## 5. Live check (uses the form; costs a few cents; not run here)

1. Build this branch on your machine. In the vault, make a skill `thinking-probe` whose SKILL.md says: "List the vault, read the newest note in Notes, then write three sentences about it."
2. Settings → Automations → **New automation**. Pick `thinking-probe` and **Opus 5.5**, and leave the effort at **Medium**. Give it any time, tick no folders, and save. Note the month's Claude total in the cost meter, press **Run now**, and wait for the run to finish. Note the new total. Do this twice.
3. **Edit** it, pick **Low**, save, and press **Run now** twice, noting the totals each time. Then do the same with **High**.
4. Open the automation's **Runs**. Each run should show "Opus 5.5 · Medium", "· Low" or "· High", matching what you picked.
5. **Compare:**
   - The cost per run at Low, Medium and High.
   - The output tokens per run, from the Anthropic Console usage page for the key, filtered to Opus 5.5.
   - If the output tokens are far above the run's visible text, the model is thinking. If they rise from Low to High, effort is reaching the model.
   - "Not set" can't be made from the form any more. Opus 5.5's documented default is medium, so Medium stands in for it.
6. Optional: pick **Sonnet 5.5** in the form and repeat step 2. Switch to **Haiku 4.5** and check that the buttons grey out, then run once: the run should succeed and show "Haiku 4.5".

## 6. Surprises

- The model select showed the wrong model when the saved model had no profile (fixed, see section 1).
- The existing suites that create automations through the form (automations, catchup, hostile, questions, skills-hub, model-picker) now save `medium`. Their mock runs therefore now carry an effort. None of them checks request bodies, and all passed. The golden suite (provider-requests) saves through the IPC, so it is unaffected.
- My e2e counter still gives 1,480 for the base, not A4's reported numbers (see the Phase 2 review).

## 7. What I chose not to do

- No way to save "not set" from the form (decision 3 says editing gives a level).
- No effort shown in the automations list rows, the skills hub or the questions flow (see section 3).
- No e2e check for the Haiku thinking rule in Settings → Models file. Unit tests cover it.
- Nothing out of scope: keeping thinking between steps, summaries, web search, prompt caching or fallbacks for automations, folder permissions, plugin/spotify. Request code is unchanged.

## 8. Not verified

- Anything live: that effort or thinking reaches the real APIs, what it costs, and that Haiku 4.5 rejects adaptive thinking (taken from Anthropic's reference, not tried).
- Windows, the packaged build, and how the form looks there. The screenshots are from Linux under xvfb.
- The "no profile" case was tested with a model id that never had a profile, not with a models.json entry that was added and then removed. The result should be the same, since both mean no profile.
