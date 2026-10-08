import { describe, expect, it } from 'vitest'
import { filesNote, type Attachment } from '../../shared/attachments'
import type { Conversation } from '../../shared/chat'
import { buildEvidence, evidenceText } from '../memory/evidence'
import { SUMMARY_SYSTEM } from '../memory/summarize'
import {
  carriedFiles,
  continuationPrompt,
  handoffEvidence,
  HANDOFF_SYSTEM,
  MAX_CARRIED_NAMES
} from '../handoff'

// Memory capture and "Continue in a new chat" with attached files: memory
// sees only how many files of which types; a continued chat gets the names,
// told it can't see the files.

const file = (message: number, name: string, kind: Attachment['kind']): Attachment => ({
  id: `id-${name.replace(/\W/g, '')}-0000`,
  message,
  name,
  kind,
  mime: kind === 'pdf' ? 'application/pdf' : kind === 'image' ? 'image/png' : 'text/plain',
  ext: kind === 'pdf' ? 'pdf' : kind === 'image' ? 'png' : 'md',
  bytes: 100,
  sha256: 'x'
})

const SECRET_NAME = 'Divorce settlement draft.pdf'
const chat = (): Conversation => ({
  id: 'c1',
  mode: 'chat',
  title: 'Files',
  createdAt: 0,
  updatedAt: 0,
  messages: [
    { role: 'user', content: 'Summarize these for me' },
    { role: 'assistant', content: 'The PDF covers the agreement.' },
    { role: 'user', content: '' },
    { role: 'assistant', content: 'Got the screenshot.' }
  ],
  attachments: [
    file(0, SECRET_NAME, 'pdf'),
    file(0, 'notes.md', 'text'),
    file(0, 'other.md', 'text'),
    file(2, 'shot.png', 'image')
  ]
})

describe('what memory capture sees of files', () => {
  it('counts files by type, without names', () => {
    expect(filesNote([])).toBe('')
    expect(filesNote([{ kind: 'pdf' }, { kind: 'text' }, { kind: 'text' }])).toBe(
      '[3 files attached (1 PDF, 2 text files); names and contents not shown]'
    )
    expect(filesNote([{ kind: 'image' }])).toBe(
      '[1 file attached (1 image); names and contents not shown]'
    )
  })

  it('adds the count and types to each request, and nothing else about the files', () => {
    const e = buildEvidence(chat(), 0, 4)
    expect(e.requests).toEqual([
      'Summarize these for me [3 files attached (1 PDF, 2 text files); names and contents not shown]',
      '[1 file attached (1 image); names and contents not shown]'
    ])
    const text = evidenceText(e)
    for (const name of [SECRET_NAME, 'notes.md', 'shot.png']) expect(text).not.toContain(name)
    expect(SUMMARY_SYSTEM).toMatch(/never guess what they contained/)
  })

  it('looks only at files on messages in the range being captured', () => {
    const e = buildEvidence(chat(), 2, 4)
    expect(e.requests).toEqual(['[1 file attached (1 image); names and contents not shown]'])
  })
})

describe('continuing a chat with files', () => {
  it("gives the handoff summarizer counts and types only, and says the files don't carry", () => {
    const ev = handoffEvidence(chat(), 'No actions ran in the earlier chat.')
    expect(ev).toContain('User: Summarize these for me [3 files attached (1 PDF, 2 text files)')
    expect(ev).toContain('2. User: [1 file attached (1 image)')
    expect(ev).not.toContain(SECRET_NAME)
    expect(HANDOFF_SYSTEM).toMatch(/not carried over, and the new chat can't see them/)
  })

  it('lists the names in the new chat, saying it cannot see them', () => {
    const files = carriedFiles(chat())
    expect(files.files?.map((f) => f.name)).toEqual([
      SECRET_NAME,
      'notes.md',
      'other.md',
      'shot.png'
    ])
    const prompt = continuationPrompt({
      from: { id: 'c1', title: 'Files' },
      summary: null,
      ledger: 'No actions ran in the earlier chat.',
      counts: {},
      unknown: [],
      at: 0,
      ...files
    })
    expect(prompt).toContain(
      `not carried over, and you cannot see them: ${JSON.stringify(SECRET_NAME)}, "notes.md", "other.md", "shot.png".`
    )
    expect(prompt).toMatch(/ask the user to attach it again/)
  })

  it('passes on names from the chat before, within a cap', () => {
    const c = chat()
    c.continuedFrom = {
      from: { id: 'c0', title: 'Before' },
      summary: null,
      ledger: '',
      counts: {},
      unknown: [],
      at: 0,
      files: Array.from({ length: MAX_CARRIED_NAMES }, (_, i) => ({
        name: `old-${i}.png`,
        kind: 'image' as const
      })),
      moreFiles: 3
    }
    const f = carriedFiles(c)
    expect(f.files).toHaveLength(MAX_CARRIED_NAMES)
    expect(f.files?.[0].name).toBe(SECRET_NAME)
    expect(f.moreFiles).toBe(4 + 3)
    expect(carriedFiles({ ...chat(), attachments: [] })).toEqual({})
  })
})
