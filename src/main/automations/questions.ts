import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { dirname } from 'path'
import { writeReplaceSync } from '../fsafe'
import { QUESTION_LIMITS as L, type PendingQuestion } from '../../shared/automations'

// All questions in one file in app data. Written whole with an atomic replace.

export function loadQuestions(file: string): PendingQuestion[] {
  if (!existsSync(file)) return []
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    return Array.isArray(raw)
      ? raw.filter(
          (q): q is PendingQuestion =>
            q &&
            typeof q.id === 'string' &&
            typeof q.question === 'string' &&
            typeof q.status === 'string'
        )
      : []
  } catch {
    return []
  }
}

function save(file: string, all: PendingQuestion[]): void {
  mkdirSync(dirname(file), { recursive: true })
  // Open ones are never dropped to make room; the oldest closed ones are.
  const open = all.filter((q) => q.status === 'open')
  const closed = all
    .filter((q) => q.status !== 'open')
    .sort((a, b) => (b.closed ?? b.created) - (a.closed ?? a.created))
    .slice(0, Math.max(0, L.kept - open.length))
  const keep = new Set([...open, ...closed].map((q) => q.id))
  writeReplaceSync(file, JSON.stringify(all.filter((q) => keep.has(q.id))))
}

export const openQuestions = (file: string): PendingQuestion[] =>
  loadQuestions(file)
    .filter((q) => q.status === 'open')
    .sort((a, b) => a.created - b.created)

const clip = (v: unknown, n: number): string =>
  typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : ''

export type NewQuestion = {
  question: unknown
  context?: unknown
  path?: unknown
  options?: unknown
}
export type AddResult = { ok: true; id: string } | { ok: false; message: string }

// Adds a question left by a run. Text is cut to its limits; a path must look
// like a note path (it is only a hint to the chat, and is checked again when
// anything is written).
export function addQuestion(
  file: string,
  from: Pick<PendingQuestion, 'automationId' | 'automationName' | 'runId' | 'slot'>,
  q: NewQuestion,
  now = Date.now()
): AddResult {
  const question = clip(q.question, L.question)
  if (!question) return { ok: false, message: 'A question needs some text, so nothing was saved.' }
  const all = loadQuestions(file)
  const open = all.filter((x) => x.status === 'open')
  if (open.filter((x) => x.runId === from.runId).length >= L.perRun)
    return {
      ok: false,
      message: `At most ${L.perRun} questions per run, so nothing was saved. Put the rest in your final message.`
    }
  if (open.length >= L.open)
    return {
      ok: false,
      message: 'There are too many unanswered questions already, so nothing was saved.'
    }
  const dup = open.find(
    (x) =>
      x.automationId === from.automationId && x.question.toLowerCase() === question.toLowerCase()
  )
  if (dup) return { ok: true, id: dup.id }
  const path = clip(q.path, 300)
  const options = (Array.isArray(q.options) ? q.options : [])
    .map((o) => clip(o, L.option))
    .filter(Boolean)
    .slice(0, L.options)
  const entry: PendingQuestion = {
    id: `q-${randomUUID().slice(0, 8)}`,
    ...from,
    created: now,
    question,
    ...(clip(q.context, L.context) ? { context: clip(q.context, L.context) } : {}),
    ...(path && !/(^|[\\/])\.\.([\\/]|$)|^[\\/]|^[a-zA-Z]:|\0/.test(path) ? { path } : {}),
    ...(options.length ? { options } : {}),
    status: 'open'
  }
  save(file, [...all, entry])
  return { ok: true, id: entry.id }
}

export function closeQuestion(
  file: string,
  id: string,
  how: { status: 'answered'; answer: string } | { status: 'dismissed' },
  now = Date.now()
): PendingQuestion | null {
  const all = loadQuestions(file)
  const q = all.find((x) => x.id === id)
  if (!q || q.status !== 'open') return null
  q.status = how.status
  q.closed = now
  if (how.status === 'answered') q.answer = clip(how.answer, L.answer)
  save(file, all)
  return q
}

export function deleteQuestionsOf(file: string, automationId: string): void {
  const all = loadQuestions(file)
  if (all.some((q) => q.automationId === automationId))
    save(
      file,
      all.filter((q) => q.automationId !== automationId)
    )
}
