# Custard

This folder belongs to Claude in Custard.

- [[Custard/Memory|Memory]] is what Claude remembers about you. It's loaded into every chat. Edit it freely: fix anything wrong, delete anything you don't want remembered.
- `Skills/` holds skills: instructions that teach Claude how to do a specific task in this vault. Each skill is a folder with a `SKILL.md` file. Claude sees every skill's name and description and reads the full skill when a request matches.

## Writing your own skill

Create `Custard/Skills/<skill-name>/SKILL.md`:

```markdown
---
name: skill-name
description: One sentence saying when Claude should use this skill.
modes: code, design
---

# Skill name

Step-by-step instructions for Claude.
```

The description matters most, because it's how Claude decides when to use the skill. `modes` is optional: list the Custard modes the skill is for (chat, code, design), or leave it out to use the skill everywhere.

You can also open the **Skills** mode in Custard and ask it to write skills for you, or to look over the vault and suggest improvements.
