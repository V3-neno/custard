import { describe, expect, it } from 'vitest'
import type { Conversation } from '../../shared/chat'
import { answerProposal, runProposeTool, type AcceptDeps } from './propose'

const chat = (): Conversation =>
  ({ id: 'c1', mode: 'code', title: 't', createdAt: 0, updatedAt: 0, messages: [] }) as Conversation
const plugins = [{ id: 'spotify', name: 'Spotify' }]

describe('workspace_propose', () => {
  it('records an offer to open an existing plugin, changing nothing else', () => {
    const c = chat()
    const r = runProposeTool(
      c,
      { action: 'open', plugin: 'spotify', request: 'Add shuffle' },
      0,
      'plugin',
      plugins
    )
    expect(r.isError).toBe(false)
    expect(c.proposals).toMatchObject([
      { kind: 'open', pluginId: 'spotify', request: 'Add shuffle', status: 'pending', turn: 0 }
    ])
  })
  it('refuses an unknown plugin, naming the real ones', () => {
    const r = runProposeTool(
      chat(),
      { action: 'open', plugin: 'nope', request: 'x' },
      0,
      'plugin',
      plugins
    )
    expect(r.isError).toBe(true)
    expect(r.content).toContain('spotify (Spotify)')
  })
  it('refuses a create without a usable name, an empty request, and a second offer', () => {
    const c = chat()
    expect(
      runProposeTool(c, { action: 'create', name: '!!!', request: 'x' }, 0, 'plugin', plugins)
        .isError
    ).toBe(true)
    expect(
      runProposeTool(c, { action: 'create', name: 'SEO', request: ' ' }, 0, 'plugin', plugins)
        .isError
    ).toBe(true)
    expect(
      runProposeTool(c, { action: 'create', name: 'SEO', request: 'x' }, 0, 'plugin', plugins)
        .isError
    ).toBe(false)
    expect(
      runProposeTool(c, { action: 'open', plugin: 'spotify', request: 'y' }, 0, 'plugin', plugins)
        .isError
    ).toBe(true)
    expect(
      runProposeTool(c, { action: 'open', plugin: 'spotify', request: 'y' }, 2, 'plugin', plugins)
        .isError
    ).toBe(false)
  })
})

describe('answering an offer', () => {
  const deps = (made: string[] = []): AcceptDeps => ({
    pluginExists: (id: string) => id === 'spotify',
    create: (name: string) => {
      made.push(name)
      return 'seo-check'
    },
    skillExists: (folder: string) => folder === 'weekly-review',
    createSkill: (name: string) => {
      made.push(`skill:${name}`)
      return 'meeting-notes'
    }
  })
  it('creates the plugin only on Yes, once', () => {
    const c = chat()
    runProposeTool(
      c,
      { action: 'create', name: 'SEO Check', request: 'Build it' },
      0,
      'plugin',
      plugins
    )
    const id = c.proposals![0].id
    const made: string[] = []
    expect(answerProposal(c, id, true, deps(made))).toEqual({
      pluginId: 'seo-check',
      request: 'Build it'
    })
    expect(made).toEqual(['SEO Check'])
    expect(c.proposals![0]).toMatchObject({ status: 'accepted', pluginId: 'seo-check' })
    expect(() => answerProposal(c, id, true, deps(made))).toThrow(/already answered/)
    expect(made).toHaveLength(1)
  })
  it('Not now does nothing but mark it', () => {
    const c = chat()
    runProposeTool(
      c,
      { action: 'create', name: 'SEO Check', request: 'Build it' },
      0,
      'plugin',
      plugins
    )
    const made: string[] = []
    expect(answerProposal(c, c.proposals![0].id, false, deps(made))).toBeNull()
    expect(made).toEqual([])
    expect(c.proposals![0].status).toBe('declined')
  })
  it("won't open a plugin that has gone", () => {
    const c = chat()
    runProposeTool(c, { action: 'open', plugin: 'spotify', request: 'x' }, 0, 'plugin', plugins)
    expect(() =>
      answerProposal(c, c.proposals![0].id, true, { ...deps(), pluginExists: () => false })
    ).toThrow(/isn't there/)
    expect(c.proposals![0].status).toBe('pending')
  })
})

describe('the Skills hub', () => {
  const skills = [{ id: 'weekly-review', name: 'Weekly review' }]
  const deps = (made: string[]): AcceptDeps => ({
    pluginExists: () => false,
    create: () => {
      throw new Error('no plugins here')
    },
    skillExists: (f) => f === 'weekly-review',
    createSkill: (name) => {
      made.push(name)
      return 'meeting-notes'
    }
  })
  it('offers a skill by its folder and enters it on Yes', () => {
    const c = chat()
    const r = runProposeTool(
      c,
      { action: 'open', skill: 'weekly-review', request: 'Add a section' },
      0,
      'skill',
      skills
    )
    expect(r.isError).toBe(false)
    expect(c.proposals![0]).toMatchObject({ target: 'skill', skill: 'weekly-review' })
    expect(answerProposal(c, c.proposals![0].id, true, deps([]))).toEqual({
      skill: 'weekly-review',
      request: 'Add a section'
    })
  })
  it('refuses an unknown skill, and creates a new one only on Yes', () => {
    const c = chat()
    expect(
      runProposeTool(c, { action: 'open', skill: 'nope', request: 'x' }, 0, 'skill', skills).content
    ).toContain('weekly-review (Weekly review)')
    runProposeTool(
      c,
      { action: 'create', name: 'Meeting notes', request: 'Write it' },
      1,
      'skill',
      skills
    )
    const made: string[] = []
    expect(made).toEqual([])
    expect(answerProposal(c, c.proposals![0].id, true, deps(made))).toEqual({
      skill: 'meeting-notes',
      request: 'Write it'
    })
    expect(made).toEqual(['Meeting notes'])
  })
})
