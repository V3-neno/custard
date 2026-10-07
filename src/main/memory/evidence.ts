import type { ActionRecord, Conversation } from '../../shared/chat'

// What a capture is allowed to see: built in code from the saved chat and
// Step 1's action records, cut down and stripped of secrets before any model
// reads it. Raw tool inputs, note and file contents and fetched pages never go
// in; plugin read results do (shortened), because they are the observations
// that say whether an earlier action worked.

export const LIMITS = { total: 8000, request: 600, result: 300, answer: 800 }

export type EvidenceAction = {
  // A1, A2, … in the order they ran; the summary refers to actions by id.
  id: string
  label: string
  tool: string
  plugin: string | null
  write: boolean
  status: ActionRecord['status']
  // What the tool said, shortened and redacted. Empty for content reads.
  result: string
}

export type Evidence = {
  requests: string[]
  actions: EvidenceAction[]
  notices: string[]
  answer: string
  // The user asked for this not to be remembered.
  dontRemember: boolean
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

const DONT_REMEMBER =
  /\b(don'?t|do not|never)\s+(remember|save|store|keep|record)\b|\bforget\s+(this|that|it|what i)\b|\boff the record\b/i

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
  const requests = msgs
    .filter((m) => m.role === 'user' && !isResults(m))
    .map((m) => textOf(m).trim())
    .filter(Boolean)
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
            result: CONTENT_TOOLS.test(b.name) ? '' : redact(cut(a?.result ?? '', LIMITS.result))
          })
        }
  const answerMsg = [...msgs].reverse().find((m) => m.role === 'assistant' && textOf(m).trim())
  const notices = (c.notices ?? [])
    .filter((n) => n.after > from && n.after <= to)
    .map((n) => n.text)
  return {
    requests: requests.map((r) => redact(cut(r, LIMITS.request))),
    actions,
    notices,
    answer: answerMsg ? redact(cut(textOf(answerMsg).trim(), LIMITS.answer)) : '',
    dontRemember: requests.some((r) => DONT_REMEMBER.test(r))
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
      ev.answer ? `\nAssistant's last answer:\n${ev.answer}` : ''
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

// Whether a range is worth a capture without asking a model: something
// happened (a plugin action, a change, an outcome other than success, an
// interrupted turn), or enough conversation has built up.
export function eligible(e: Evidence): boolean {
  if (e.dontRemember) return false
  if (e.actions.some((a) => a.plugin || a.write || a.status !== 'completed')) return true
  if (e.notices.length) return true
  return e.requests.length >= 4
}
