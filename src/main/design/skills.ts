import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import type { SkillUse } from '../../shared/design'
import { resolveInVault } from '../memory/paths'

// Skill precedence and provenance for Design, on top of the existing skill
// system (Custard/Skills/<name>/SKILL.md, listed by vault.ts). Matching a
// request to a skill is the model's judgment from the descriptions and the
// instructions it reads; what happens with its judgment is decided here, the
// same way every time. Skills only shape output: nothing here touches tools
// or permissions (see modes/policy).

// Guidance kept with a version, so it can be shown even if the skill changes
// or goes away. A fingerprint alone can't bring back old instructions.
export const GUIDANCE_LIMIT = 2000

export const fingerprint = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex')

// Records a skill as read for a version.
export function skillUse(
  vault: string,
  s: { path: string; name: string; how: SkillUse['how']; guidance: string }
): SkillUse {
  const text = readFileSync(resolveInVault(vault, s.path), 'utf8')
  return {
    path: s.path,
    name: s.name,
    fingerprint: fingerprint(text),
    how: s.how,
    guidance: s.guidance.slice(0, GUIDANCE_LIMIT)
  }
}

export type SkillChange = { path: string; name: string; state: 'same' | 'changed' | 'missing' }

// Whether the skills behind a version are as they were. A change is only
// reported: the user is offered the new guidance; nothing is restyled.
export function skillChanges(vault: string, uses: SkillUse[]): SkillChange[] {
  return uses.map((u) => {
    let text: string
    try {
      text = readFileSync(resolveInVault(vault, u.path), 'utf8')
    } catch {
      return { path: u.path, name: u.name, state: 'missing' }
    }
    return {
      path: u.path,
      name: u.name,
      state: fingerprint(text) === u.fingerprint ? 'same' : 'changed'
    }
  })
}

// One skill the model considered for a request.
export type Candidate = {
  path: string
  name: string
  // explicit: the user named it. clear: its description and instructions
  // fit the request. similar: related, but not a clear fit.
  strength: 'explicit' | 'clear' | 'similar'
  // It exists, and this mode lists it.
  available: boolean
  // Paths of other candidates it contradicts on something material.
  conflicts: string[]
  // similar only: using it or not would noticeably change the result.
  material?: boolean
}

export type SkillPlan = {
  apply: { path: string; name: string; how: SkillUse['how'] }[]
  // Said briefly with the answer ("Used: brand guide").
  notes: string[]
  // A question to settle before generating; null to go ahead.
  ask: string | null
}

// Explicit beats a match, a clear match is applied with a note, a similar
// one is explained, and asked about only when it would matter, but not applied, conflicting matches
// are asked about rather than blended, and no match means defaults.
export function planSkills(candidates: Candidate[]): SkillPlan {
  const plan: SkillPlan = { apply: [], notes: [], ask: null }
  const questions: string[] = []
  const explicit = candidates.filter((c) => c.strength === 'explicit')
  for (const c of explicit) {
    if (!c.available) {
      plan.notes.push(`The skill "${c.name}" isn't available here, so it wasn't used.`)
      continue
    }
    plan.apply.push({ path: c.path, name: c.name, how: 'explicit' })
  }
  const chosen = new Set(plan.apply.map((a) => a.path))
  // Two named skills that contradict each other: ask which wins.
  for (const c of explicit)
    for (const other of c.conflicts)
      if (chosen.has(c.path) && chosen.has(other) && c.path < other)
        questions.push(
          `"${c.name}" and "${explicit.find((e) => e.path === other)?.name ?? other}" disagree; which should win?`
        )
  const clear = candidates.filter((c) => c.strength === 'clear' && c.available)
  for (const c of clear) {
    const againstChosen = c.conflicts.some((p) => chosen.has(p))
    if (againstChosen) {
      plan.notes.push(`Not used "${c.name}": it conflicts with the skill you named.`)
      continue
    }
    const rivals = clear.filter(
      (o) => o !== c && (c.conflicts.includes(o.path) || o.conflicts.includes(c.path))
    )
    if (rivals.length) {
      if (rivals.every((r) => c.path < r.path))
        questions.push(
          `"${c.name}" and ${rivals.map((r) => `"${r.name}"`).join(', ')} both fit but disagree; which should I follow?`
        )
      continue
    }
    plan.apply.push({ path: c.path, name: c.name, how: 'matched' })
    chosen.add(c.path)
  }
  for (const c of candidates.filter((x) => x.strength === 'similar' && x.available))
    if (c.material) questions.push(`"${c.name}" is related but not a clear fit; should I use it?`)
    else plan.notes.push(`"${c.name}" is related but not a clear fit, so it wasn't used.`)
  if (plan.apply.length) plan.notes.unshift(`Used: ${plan.apply.map((a) => a.name).join(', ')}.`)
  plan.ask = questions.length ? questions.join(' ') : null
  return plan
}
