import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { QUESTION_LIMITS as L } from '../../shared/automations'
import {
  addQuestion,
  closeQuestion,
  deleteQuestionsOf,
  loadQuestions,
  openQuestions
} from './questions'

let dir: string
let file: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'custard-q-'))
  file = join(dir, 'q.json')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const from = (runId = 'r1', automationId = 'a1'): Parameters<typeof addQuestion>[1] => ({
  automationId,
  automationName: 'Log',
  runId,
  slot: '2026-03-01T08:00'
})

describe('adding', () => {
  it('saves a clean question with its run', () => {
    const r = addQuestion(file, from(), {
      question: 'Which one?',
      context: 'Two match.',
      path: 'Notes/a.md',
      options: ['A', 'B']
    })
    expect(r.ok).toBe(true)
    expect(loadQuestions(file)[0]).toMatchObject({
      automationId: 'a1',
      runId: 'r1',
      slot: '2026-03-01T08:00',
      question: 'Which one?',
      context: 'Two match.',
      path: 'Notes/a.md',
      options: ['A', 'B'],
      status: 'open'
    })
  })
  it('cuts text to its limits and flattens whitespace', () => {
    addQuestion(file, from(), {
      question: 'q\n\n'.repeat(400),
      context: 'c'.repeat(2000),
      options: ['x'.repeat(200), 1, '', 'b', 'c', 'd', 'e']
    })
    const q = loadQuestions(file)[0]
    expect(q.question.length).toBeLessThanOrEqual(L.question)
    expect(q.question).not.toContain('\n')
    expect(q.context!.length).toBe(L.context)
    expect(q.options).toHaveLength(L.options)
    expect(q.options![0].length).toBe(L.option)
  })
  it('keeps a path only if it looks like a note path in the vault', () => {
    for (const bad of ['../x.md', '/etc/passwd', 'C:\\x.md', 'a/../b.md'])
      addQuestion(file, from(`r-${bad}`), { question: `q ${bad}`, path: bad })
    expect(loadQuestions(file).every((q) => q.path === undefined)).toBe(true)
  })
  it('refuses an empty question', () => {
    expect(addQuestion(file, from(), { question: '  ' }).ok).toBe(false)
    expect(addQuestion(file, from(), { question: 7 }).ok).toBe(false)
    expect(loadQuestions(file)).toEqual([])
  })
  it('allows a few per run and says so when it is over', () => {
    for (let i = 0; i < L.perRun; i++)
      expect(addQuestion(file, from('r1'), { question: `q${i}` }).ok).toBe(true)
    const r = addQuestion(file, from('r1'), { question: 'one more' })
    expect(r).toMatchObject({ ok: false, message: expect.stringMatching(/At most 3/) })
    expect(addQuestion(file, from('r2'), { question: 'other run' }).ok).toBe(true)
  })
  it('does not pile up the same open question', () => {
    const a = addQuestion(file, from('r1'), { question: 'Which one?' })
    const b = addQuestion(file, from('r2'), { question: 'which one?' })
    expect(a.ok && b.ok && a.id === b.id).toBe(true)
    expect(loadQuestions(file)).toHaveLength(1)
  })
  it('stops at the total of open questions', () => {
    for (let i = 0; i < L.open; i++) addQuestion(file, from(`r${i}`), { question: `question ${i}` })
    expect(addQuestion(file, from('rx'), { question: 'too many' })).toMatchObject({ ok: false })
  })
})

describe('closing', () => {
  it('answers once, keeping a short answer', () => {
    const r = addQuestion(file, from(), { question: 'Which?' })
    const id = r.ok ? r.id : ''
    const q = closeQuestion(file, id, { status: 'answered', answer: 'B '.repeat(400) })
    expect(q?.status).toBe('answered')
    expect(q?.answer!.length).toBeLessThanOrEqual(L.answer)
    expect(closeQuestion(file, id, { status: 'dismissed' })).toBeNull()
    expect(openQuestions(file)).toEqual([])
  })
  it('knows no question it was not given', () => {
    expect(closeQuestion(file, 'q-nope', { status: 'dismissed' })).toBeNull()
  })
  it('lists open ones oldest first', () => {
    addQuestion(file, from('r1'), { question: 'second' }, 2000)
    addQuestion(file, from('r2'), { question: 'first' }, 1000)
    expect(openQuestions(file).map((q) => q.question)).toEqual(['first', 'second'])
  })
  it('drops old closed ones past the total, never an open one', () => {
    const open = addQuestion(file, from('keep'), { question: 'still open' })
    for (let i = 0; i < L.kept + 20; i++) {
      const r = addQuestion(file, from(`r${i}`), { question: `closed ${i}` }, 10 + i)
      if (r.ok) closeQuestion(file, r.id, { status: 'dismissed' }, 10 + i)
    }
    const all = loadQuestions(file)
    expect(all.length).toBeLessThanOrEqual(L.kept)
    expect(all.some((q) => open.ok && q.id === open.id)).toBe(true)
  })
  it('goes with its automation', () => {
    addQuestion(file, from('r1', 'a1'), { question: 'mine' })
    addQuestion(file, from('r2', 'a2'), { question: 'other' })
    deleteQuestionsOf(file, 'a1')
    expect(loadQuestions(file).map((q) => q.question)).toEqual(['other'])
  })
})

describe('a damaged file', () => {
  it('reads as no questions', () => {
    expect(loadQuestions(join(dir, 'nope.json'))).toEqual([])
  })
})
