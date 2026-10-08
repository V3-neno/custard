import type { ActionRecord, Conversation } from '../../shared/chat'
import { filesNote } from '../../shared/attachments'

// What a capture is allowed to see: built in code from the saved chat and
// Step 1's action records, cut down and stripped of secrets before any model
// reads it. Raw tool inputs, note and file contents and fetched pages never go
// in; plugin read results do (shortened), because they are the observations
// that say whether an earlier action worked. Attached files appear only as a
// count and their types (see filesNote), never by name or content.

export const LIMITS = { total: 8000, request: 600, result: 300, answer: 800 }

export type EvidenceAction = {
  // A1, A2, … in the order they ran; the summary refers to actions by id.
  id: string
  label: string
  tool: string
  plugin: string | null
  write: boolean
  status: ActionRecord['status']
  // A content read (notes, files, pages, search results): its result is
  // never included, and it can't count as an observation.
  content: boolean
  // What the tool said, shortened and redacted. Empty for content reads.
  result: string
}

export type Evidence = {
  requests: string[]
  actions: EvidenceAction[]
  notices: string[]
  answer: string
  // The user asked for this not to be remembered: the words that said so.
  dontRemember: string | null
  // Those words asked to forget the whole chat, not just this part.
  forgetChat: boolean
}

// A backstop, not a guarantee: obvious credentials and long opaque strings.
export function redact(s: string): string {
  return s
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]')
    .replace(/\b(sk|pk|rk|ghp|gho|ghs|xox[abp]|AKIA|AIza)[-_A-Za-z0-9]{10,}/g, '[redacted]')
    .replace(
      /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|client[_-]?secret|code)(["']?\s*[:=]\s*["']?)[^\s"'&,}]+/gi,
      '$1$2[redacted]'
    )
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, '[redacted]')
    .replace(/\b[A-Za-z0-9+/_-]{40,}={0,2}/g, '[redacted]')
}

const cut = (s: string, n: number): string =>
  s.length > n ? `${s.slice(0, n).trimEnd()}… [shortened]` : s

// An explicit request, phrased as one, not to remember: "don't save this",
// "forget this chat", "off the record". Casual phrases ("forget it, play
// something else", "I don't remember that") don't count, so the request has
// to start a sentence or follow "please", "and", "but" or "so", and name
// what not to keep. A backstop to the switches in the app, not a classifier.
const DONT_REMEMBER = new RegExp(
  [
    String.raw`(?:^|[.!?;:,]\s*|\b(?:please|and|but|so)\s+)(?:please\s+)?(?:don['’]?t|do not|never)\s+(?:remember|save|store|record)\s+(?:this|that|it|any of (?:this|that)|what I (?:said|told you))\b`,
    String.raw`(?:^|[.!?;:,]\s*|\b(?:please|and|but|so)\s+)(?:please\s+)?forget\s+(?:this (?:chat|conversation)|what I (?:just )?(?:said|told you)|everything (?:I|we) (?:said|talked about))`,
    String.raw`\boff the record\b`,
    String.raw`\bkeep (?:this|that|it) out of (?:your |my )?memory\b`
  ].join('|'),
  'i'
)

// Tools whose results are content (notes, files, pages, search results), not
// observations about the world. Only their status goes in.
const CONTENT_TOOLS =
  /^(vault_(read|search|list)|fs_(read|list|search)|reference_(read|list)|web_read|web_search)$/

const textOf = (m: Conversation['messages'][number]): string =>
  typeof m.content === 'string'
    ? m.content
    : m.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n')

// `skipPlugins`: plugins the user asked not to remember; their actions are
// left out entirely.
export function buildEvidence(
  c: Conversation,
  from: number,
  to: number,
  skipPlugins: string[] = []
): Evidence {
  const msgs = c.messages.slice(from, to)
  const isResults = (m: (typeof msgs)[number]): boolean =>
    typeof m.content !== 'string' && m.content.some((b) => b.type === 'tool_result')
  const files = (i: number): string =>
    filesNote((c.attachments ?? []).filter((a) => a.message === from + i))
  const asked = msgs.flatMap((m, i) =>
    m.role === 'user' && !isResults(m) ? [{ text: textOf(m).trim(), files: files(i) }] : []
  )
  const requests = asked.map((r) => r.text).filter(Boolean)
  const actions: EvidenceAction[] = []
  for (const m of msgs)
    if (m.role === 'assistant' && typeof m.content !== 'string')
      for (const b of m.content)
        if (b.type === 'tool_use') {
          const a = c.actions?.[b.id]
          const plugin = /^([a-z][a-z0-9-]*)__/.exec(b.name)?.[1] ?? null
          if (plugin && skipPlugins.includes(plugin)) continue
          actions.push({
            id: `A${actions.length + 1}`,
            label: a?.label || b.name,
            tool: b.name,
            plugin,
            write: a?.write ?? false,
            status: a?.status ?? 'unknown',
            content: CONTENT_TOOLS.test(b.name),
            result: CONTENT_TOOLS.test(b.name) ? '' : redact(cut(a?.result ?? '', LIMITS.result))
          })
        }
  const answerMsg = [...msgs].reverse().find((m) => m.role === 'assistant' && textOf(m).trim())
  const dontRemember =
    requests
      .map((r) =>
        DONT_REMEMBER.exec(r)?.[0]
          .replace(/^[.!?;:,\s]+/, '')
          .trim()
      )
      .find(Boolean) ?? null
  const notices = (c.notices ?? [])
    .filter((n) => n.after > from && n.after <= to)
    .map((n) => n.text)
  return {
    requests: asked
      .filter((r) => r.text || r.files)
      .map((r) => [redact(cut(r.text, LIMITS.request)), r.files].filter(Boolean).join(' ')),
    actions,
    notices,
    answer: answerMsg ? redact(cut(textOf(answerMsg).trim(), LIMITS.answer)) : '',
    dontRemember,
    forgetChat: !!dontRemember && /^(?:please\s+)?forget\b/i.test(dontRemember)
  }
}

// The evidence as the summarizer reads it, within the size limit. Older
// requests and actions are dropped first.
export function evidenceText(e: Evidence): string {
  const lines = (ev: Evidence): string =>
    [
      'User requests (oldest first):',
      ...ev.requests.map((r, n) => `${n + 1}. ${r}`),
      '',
      "Actions, in order, with Custard's own record of each outcome:",
      ...ev.actions.map(
        (a) =>
          `- ${a.id}: ${a.label} [${a.tool}${a.plugin ? `, plugin ${a.plugin}` : ''}, ${a.write ? 'changes something' : 'read-only'}] → ${a.status}${a.result ? `: ${a.result}` : ''}`
      ),
      ev.notices.length ? `\nHow turns ended: ${ev.notices.join(' | ')}` : '',
      ev.answer
        ? `\nAssistant's last answer (its own words; not evidence of what happened):\n${ev.answer}`
        : ''
    ].join('\n')
  const e2 = { ...e, requests: [...e.requests], actions: [...e.actions] }
  let text = lines(e2)
  while (text.length > LIMITS.total && (e2.requests.length > 1 || e2.actions.length > 1)) {
    if (e2.actions.length > 1) e2.actions.shift()
    if (text.length > LIMITS.total && e2.requests.length > 1) e2.requests.shift()
    text = lines(e2)
  }
  return text.slice(0, LIMITS.total)
}

// Words that often come with something lasting: a preference, a decision,
// a fact about the user, a request to remember. Only a reason to ask the
// summarizer, which decides whether anything is worth saving; it never
// saves anything by itself.
const DURABLE = new RegExp(
  [
    String.raw`\b(?:I|we)(?:['’]d|\s+(?:really|usually|always|generally|mostly|would))?\s+(?:prefer|like|love|hate|dislike|want you to|always|never|usually)\b`,
    String.raw`\bfrom now on\b`,
    String.raw`\b(?:going forward|in future|next time)\b`,
    String.raw`\bremember\b`,
    String.raw`\b(?:I|we)(?:['’]ve| have)?\s+decided\b`,
    String.raw`\blet['’]?s (?:go with|use|stick with)\b`,
    String.raw`\bwe['’]?ll (?:use|go with)\b`,
    String.raw`\bmy (?:name|role|job|stack|pronouns|timezone|time zone) (?:is|are)\b`,
    String.raw`\bcall me\b`
  ].join('|'),
  'i'
)

// Whether a range is worth asking the summarizer about, decided without a
// model: something happened (a plugin action, a change, an outcome other
// than success, an interrupted turn), the user said something that may
// last, or a long stretch of chat built up. Small talk makes no call.
export function eligible(e: Evidence): boolean {
  if (e.dontRemember) return false
  if (e.actions.some((a) => a.plugin || a.write || a.status !== 'completed')) return true
  if (e.notices.length) return true
  if (e.requests.some((r) => DURABLE.test(r))) return true
  return e.requests.length >= 10
}
