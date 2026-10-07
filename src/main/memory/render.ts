import type { ActionStatus } from '../../shared/chat'
import type { Evidence, EvidenceAction } from './evidence'
import type { Summary, WorkflowOutcome } from './summarize'
import { markerComment } from './notes'

// Turns a summary into note text. Everything here is code: the model's words
// fill in descriptions, but statuses come from Custard's own action records
// and the outcome is checked against them, so a tool accepting a request is
// never written down as it having worked.

export type Provenance = { title: string; date: string; chatId: string }

export type Entry = { text: string }

export type Rendered = {
  // Lines for the "Remembered by Custard" list in Memory.md.
  memory: string[]
  // Activity entries, by plugin id ('' for none).
  activity: { plugin: string; text: string }[]
}

const STATUS_WORDS: Record<ActionStatus, string> = {
  completed: 'the tool reported success',
  failed: 'the tool reported an error',
  'not-run': 'not run',
  unknown: 'outcome unknown',
  pending: 'outcome unknown',
  running: 'outcome unknown'
}

const OUTCOME_WORDS: Record<WorkflowOutcome, string> = {
  worked: 'Worked: a later check confirmed it',
  accepted: 'Accepted by the tool, not confirmed',
  failed: 'Failed',
  'not-run': 'Not run',
  unknown: 'Outcome unknown',
  mixed: 'Mixed results'
}

// Model text can't open or close Custard's markers, start a heading or break
// out of its line.
export const plain = (s: string): string =>
  s
    .replace(/<!--|-->/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[#>\s-]+/, '')
    .trim()

// The model's outcome, held to what the records allow.
export function checkedOutcome(
  claimed: WorkflowOutcome,
  actions: EvidenceAction[],
  observed: string
): WorkflowOutcome {
  if (actions.length === 0) return claimed === 'worked' && !observed ? 'accepted' : claimed
  const statuses = actions.map((a) => a.status)
  if (statuses.every((s) => s === 'not-run')) return 'not-run'
  const sent = statuses.filter((s) => s !== 'not-run')
  if (claimed === 'worked') {
    if (!observed) return sent.some((s) => s === 'completed') ? 'accepted' : 'unknown'
    if (!sent.some((s) => s === 'completed')) return 'mixed'
  }
  if (claimed === 'not-run') return sent.length ? 'mixed' : 'not-run'
  return claimed
}

export function render(
  summary: Summary,
  evidence: Evidence,
  marker: string,
  from: Provenance,
  pluginName: (id: string) => string
): Rendered {
  const mark = markerComment(marker)
  const source = `From chat "${plain(from.title)}" on ${from.date} (chat ${from.chatId.slice(0, 8)})`
  const memory = [
    ...summary.preferences.map(
      (p) =>
        `- ${from.date}: ${plain(p.text)}${p.replaces ? ` (changes an earlier preference: "${plain(p.replaces)}"; the earlier one is left as written)` : ''} ${mark}`
    ),
    ...summary.decisions.map((d) => `- ${from.date}: Decided: ${plain(d)} ${mark}`)
  ]
  const byId = new Map(evidence.actions.map((a) => [a.id, a]))
  const activity: Rendered['activity'] = []
  for (const w of summary.workflows) {
    const actions = [...new Set(w.actions)].flatMap((id) => byId.get(id) ?? [])
    const plugin = actions.find((a) => a.plugin)?.plugin ?? ''
    const outcome = checkedOutcome(w.outcome, actions, w.observed)
    activity.push({
      plugin,
      text: [
        `### ${from.date} · ${plain(w.title)}`,
        mark,
        plugin ? `- Plugin: ${plain(pluginName(plugin))}` : '',
        w.request ? `- Asked: ${plain(w.request)}` : '',
        actions.length ? "- Tried (Custard's record of each action):" : '',
        ...actions.map((a) => `  - ${plain(a.label)}: ${STATUS_WORDS[a.status]}`),
        `- Observed afterwards: ${w.observed ? plain(w.observed) : 'nothing checked it'}`,
        w.uncertain ? `- Still unsure: ${plain(w.uncertain)}` : '',
        `- Outcome: ${OUTCOME_WORDS[outcome]}`,
        `- ${source}`
      ]
        .filter(Boolean)
        .join('\n')
    })
  }
  for (const r of summary.resolutions)
    activity.push({
      plugin: '',
      text: [
        `### ${from.date} · Resolved: ${plain(r.issue)}`,
        mark,
        `- Resolution: ${plain(r.resolution)}`,
        '- Earlier entries about this are left as they were.',
        `- ${source}`
      ].join('\n')
    })
  for (const u of summary.unresolved)
    activity.push({
      plugin: '',
      text: [`### ${from.date} · Open: ${plain(u)}`, mark, `- ${source}`].join('\n')
    })
  return { memory, activity }
}
