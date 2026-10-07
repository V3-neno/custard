import type { ActionStatus } from '../../shared/chat'
import type { Evidence, EvidenceAction } from './evidence'
import type { Requested, Summary } from './summarize'

// Turns a summary into note text. Everything here is code: the model's words
// fill in descriptions, but each action's status comes from Custard's own
// records, and only later read-only checks count as observations. Whether an
// action ran and whether the user's requested outcome was seen are written
// as separate lines, so a tool accepting a request is never written down as
// the request having worked, and a later check is never written down as the
// action having failed.

export type Provenance = { title: string; date: string; time: string; chatId: string }

export const SECTIONS = ['Preferences', 'Decisions', 'Activity', 'Resolved', 'Still open'] as const
export type Section = (typeof SECTIONS)[number]

// One piece of a capture note. `plugin` is the plugin it is about ('' for
// none), so plugin knowledge can give it a note in the plugin's folder.
export type Item = { plugin: string; section: Section; text: string }

// What an action itself did, from Custard's record. Never judged by the model.
export function executionWords(a: Pick<EvidenceAction, 'status' | 'write'>): string {
  const words: Record<ActionStatus, string> = {
    completed: a.write ? 'accepted: the tool reported success' : 'ran: the tool returned a result',
    failed: 'the tool reported an error',
    'not-run': 'not run',
    unknown: 'outcome unknown: it was sent, but no result came back',
    pending: 'outcome unknown: it was sent, but no result came back',
    running: 'outcome unknown: it was sent, but no result came back'
  }
  return words[a.status]
}

const REQUESTED_WORDS: Record<Requested, string> = {
  seen: 'seen at the later check',
  'not-seen': 'not seen at the later check; whether it happened before then is unknown',
  unclear: "the later check didn't settle it",
  unchecked: 'not checked: nothing looked afterwards'
}

// Model text can't start a heading, a list or a comment, or break out of
// its line.
export const plain = (s: string): string =>
  s
    .replace(/<!--|-->/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[#>\s-]+/, '')
    .trim()

const num = (id: string): number => Number(id.slice(1))

// The checks the model named that can actually show the state afterwards:
// read-only, completed, not a content read (notes, files, pages), and after
// the workflow's last action. Anything else is not an observation.
export function validChecks(
  checkIds: string[],
  actionIds: string[],
  evidence: Evidence
): EvidenceAction[] {
  const after = Math.max(0, ...actionIds.map(num))
  const byId = new Map(evidence.actions.map((a) => [a.id, a]))
  return [...new Set(checkIds)]
    .filter((id) => !actionIds.includes(id) && num(id) > after)
    .flatMap((id) => byId.get(id) ?? [])
    .filter((a) => !a.write && a.status === 'completed' && !a.content)
}

export function render(
  summary: Summary,
  evidence: Evidence,
  pluginName: (id: string) => string
): Item[] {
  // A preference goes with a plugin only when that plugin acted in this
  // part of the chat; the model's word alone doesn't pick a folder.
  const acted = [...new Set(evidence.actions.flatMap((a) => (a.plugin ? [a.plugin] : [])))]
  const pluginFor = (name: string): string => {
    const n = name.trim().toLowerCase()
    return (n && acted.find((id) => id === n || pluginName(id).toLowerCase() === n)) || ''
  }
  const items: Item[] = [
    ...summary.preferences.map((p) => ({
      plugin: pluginFor(p.plugin),
      section: 'Preferences' as const,
      text: `- ${plain(p.text)}${p.replaces ? ` (changes an earlier preference: "${plain(p.replaces)}"; the earlier note is left as written)` : ''}`
    })),
    ...summary.decisions.map((d) => ({
      plugin: '',
      section: 'Decisions' as const,
      text: `- ${plain(d)}`
    }))
  ]
  const byId = new Map(evidence.actions.map((a) => [a.id, a]))
  for (const w of summary.workflows) {
    const ids = [...new Set(w.actions)].filter((id) => byId.has(id))
    const actions = ids.map((id) => byId.get(id)!)
    const checks = validChecks(w.checks, ids, evidence)
    const plugin = actions.find((a) => a.plugin)?.plugin ?? ''
    const attempted = actions.some((a) => a.status !== 'not-run')
    // With no valid check there is no observation, whatever the model said.
    const requested: Requested = checks.length ? w.requested : 'unchecked'
    items.push({
      plugin,
      section: 'Activity',
      text: [
        `### ${plain(w.title)}`,
        plugin ? `- Plugin: ${plain(pluginName(plugin))}` : '',
        w.request ? `- Asked: ${plain(w.request)}` : '',
        actions.length ? "- Done (Custard's record of each action):" : '',
        ...actions.map((a) => `  - ${plain(a.label)}: ${executionWords(a)}`),
        checks.length
          ? `- Checked afterwards (${checks.map((a) => plain(a.label)).join(', ')}): ${w.observed ? plain(w.observed) : 'no summary of what it showed'}`
          : '- Checked afterwards: nothing checked it',
        `- Requested outcome: ${actions.length && !attempted ? 'not attempted' : REQUESTED_WORDS[requested]}`,
        w.uncertain ? `- Still unsure: ${plain(w.uncertain)}` : ''
      ]
        .filter(Boolean)
        .join('\n')
    })
  }
  for (const r of summary.resolutions)
    items.push({
      plugin: '',
      section: 'Resolved',
      text: `- ${plain(r.issue)}: ${plain(r.resolution)} (earlier notes about it are left as they were)`
    })
  for (const u of summary.unresolved)
    items.push({ plugin: '', section: 'Still open', text: `- ${plain(u)}` })
  return items
}

// A capture note's text. Written once and never changed by Custard.
export function noteText(
  items: Item[],
  from: Provenance,
  frontmatter: Record<string, string>
): string {
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join('\n')
  const body = SECTIONS.flatMap((s) => {
    const list = items.filter((i) => i.section === s).map((i) => i.text)
    if (!list.length) return []
    return [`## ${s}\n\n${list.join(s === 'Activity' ? '\n\n' : '\n')}`]
  })
  return [
    `---\n${fm}\n---`,
    `# ${plain(from.title) || 'Chat'}`,
    `_Saved by Custard from the chat "${plain(from.title)}" on ${from.date} at ${from.time}. Custard writes this note once and never changes it. Edit or delete it as you like; a deleted note is not written again._`,
    ...body
  ].join('\n\n')
}
