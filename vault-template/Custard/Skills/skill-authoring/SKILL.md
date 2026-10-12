---
name: skill-authoring
description: Use when writing or improving a Custard skill (a SKILL.md in Custard/Skills), so it loads when it should and does what it says.
---

# Skill authoring

This skill is guidance, not a security mechanism. What a skill may touch is decided by Custard's folder grants and approvals, whatever a skill says. The full reference is `Resources/Custard Skill Authoring.md`; read it when a detail below isn't enough.

## Instructions

1. **List first.** List `Custard/Skills` and read related skills so you extend rather than duplicate. You can add to existing notes, so improve a skill by adding a clearly headed section.
2. **One folder, one file.** A skill is `Custard/Skills/<kebab-case-name>/SKILL.md`. Use the folder name as the skill's `name:` so the two never differ.
3. **Frontmatter.** `name`, `description` and, optionally, `modes: plugins, design` (leave it out to load in every mode). Keep `description` to one sentence that says *when* to use the skill: it is all the model sees until a request matches, and it decides whether the skill is read.
4. **Write the body as steps.** Concrete, numbered, with the conventions and a short example. Say what to read, what to write, where, and what to report. Don't explain what the model already knows.
5. **Keep it short.** Only the name and description go in every prompt, and only about 60 skills are listed. A skill read in full is cut at 20,000 characters, so put what matters first.
6. **Name real places.** Use exact folder and note names. Notes you read come back with `&`, `<` and `>` escaped; write real characters when you edit.
7. **Don't promise what Custard can't do.** It has no clock in chat beyond the date and time zone, no background work while closed, and can write only in folders the user has allowed. Protected places (`Memory.md`, `Custard/Skills`, `Custard/Captures`, plugin `Activity` and `Overview.md`) can't be granted.
8. **Memory facts.** If the skill records a time or place, record a time zone name (`Europe/Stockholm`), not an offset (`UTC+2`).
9. **Say what to do when something is missing.** A skill that finds no note or no data should report that, not invent it.
10. **Test it.** Ask for something that should trigger it and for something that shouldn't. Check the description is what made it match.
