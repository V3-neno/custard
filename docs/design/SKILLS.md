# Skills in Design: matching, precedence, provenance

Design uses the existing skill system: `Custard/Skills/<name>/SKILL.md` in
the vault, listed by `listSkills` with `name`, `description` and `modes`,
read with `vault_read`. No second skill store.

## Matching

The model matches using each skill's description and, before applying it,
the instructions it reads; never the title alone. It reports each skill it
considered as a `Candidate`: `explicit` (the user named it), `clear` (it
fits), or `similar` (related, not a clear fit), with any material conflicts
between candidates and, for similar ones, whether using it would noticeably
change the result.

## Precedence (`planSkills`, `src/main/design/skills.ts`)

1. Explicit and available: used. Named but unavailable: said, not used.
2. Clear match: used, with a short note ("Used: brand guide").
3. Similar: explained; asked about only when it would materially steer the
   result; not used unless the user says so.
4. Conflicting matches: asked about, never blended. A match that conflicts
   with an explicitly named skill is dropped with a note.
5. No match: sensible defaults.

The user's own words override skill defaults. Compatible skills combine
(say, a brand guide and an accessibility workflow).

## Provenance

Each version keeps a `SkillUse` per skill: path, name, how it was chosen,
the SHA-256 fingerprint of the SKILL.md as read, and up to 2,000 characters
of the guidance relied on. `skillChanges` compares a version's skills with
the vault: `same`, `changed` or `missing`. A changed skill is reported and
the user is offered the new guidance; nothing is restyled on its own. The
fingerprint proves a change, not the old text: the kept guidance is what can
be shown later.

Applying a skill doesn't mean its checks ran. Only checks that actually ran
are reported.

## Permissions

Skills never change what a mode can do. The mode policy takes the chat's
mode and workspace and nothing else, `listSkills` reads only name,
description and modes, and Chat and Design can't write into the skills
folder by any route (`src/main/modes/extensions.ts`). Tests:
`src/main/modes/policy.test.ts` and `test/e2e/modes.mjs` (a skill claiming
`allowed-tools` and `permissions` leaves Design's tools exactly Chat's).

## In the workspace (Phase 2)

`design_html` takes every skill the model considered (`strength`,
`conflicts`, `material`, `guidance`) and runs `planSkills` on them before
anything is generated: a question stops it with nothing saved. Applied
skills are recorded on the version with `skillUse`. The workspace's
"Skills used" shows them, checks `skillChanges` when the window regains
focus, and offers a changed skill ("Use the updated skill") or the
explicit override ("Without this skill") by filling in the message box,
never by sending or restyling. Details: [WORKSPACE.md](WORKSPACE.md#skills).

## Example skills

- [Image making](IMAGE-SKILL-PROPOSAL.md): an optional skill for generated
  images in Design. It isn't shipped; create it in your vault if you want it.
