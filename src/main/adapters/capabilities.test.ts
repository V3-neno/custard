import { describe, expect, it } from 'vitest'
import { capabilities } from '../../shared/adapter'
import { chatModels } from '../../shared/chat'
import { capabilitiesOf, modelInfo } from './capabilities'

const yes = (model: string): string[] =>
  capabilities.filter((c) => capabilitiesOf(model)[c].supported)

describe('model capabilities', () => {
  it('describes every model Custard offers', () => {
    for (const m of chatModels) {
      const info = modelInfo(m.id)!
      expect(info).toMatchObject({
        id: m.id,
        provider: m.provider,
        source: 'profile',
        priced: true
      })
      expect(info.contextWindow).toBeGreaterThan(0)
      expect(Object.keys(info.capabilities).sort()).toEqual([...capabilities].sort())
    }
  })

  it('matches what a request actually does', () => {
    expect(yes('claude-opus-5-5')).toEqual([...capabilities])
    // Haiku: no effort, so no thinking, no compaction, no fallbacks.
    expect(yes('claude-haiku-4-5')).not.toContain('reasoning')
    expect(yes('claude-haiku-4-5')).not.toContain('compaction')
    expect(yes('claude-haiku-4-5')).toContain('web_search')
    expect(yes('gpt-6-astra')).not.toContain('fallbacks')
    expect(yes('gpt-6-astra')).toEqual(expect.arrayContaining(['web_search', 'pdf', 'compaction']))
    for (const d of ['deepseek-flash', 'deepseek-v4-pro']) {
      const c = capabilitiesOf(d)
      expect(c.pdf.supported).toBe(false)
      expect(c.web_search.supported).toBe(false)
      expect(c.token_counting.supported).toBe(false)
      expect(c.reasoning_summary.supported).toBe(false)
      expect(c.compaction.supported).toBe(false)
    }
    expect(capabilitiesOf('deepseek-flash').vision.supported).toBe(true)
    expect(capabilitiesOf('deepseek-v4-pro').vision).toMatchObject({
      supported: false,
      note: "DeepSeek V4 Pro doesn't take images."
    })
  })

  it('marks only recorded live tests as live', () => {
    expect(capabilitiesOf('deepseek-flash').vision.evidence).toBe('live')
    expect(capabilitiesOf('deepseek-flash').json_schema.evidence).toBe('live')
    expect(capabilitiesOf('deepseek-v4-pro').vision.evidence).toBe('docs')
    // The tool-call chat's model wasn't recorded.
    for (const d of ['deepseek-flash', 'deepseek-v4-pro'])
      for (const c of ['text', 'streaming', 'tool_use'] as const)
        expect(capabilitiesOf(d)[c].evidence).toBe('docs')
    expect(capabilitiesOf('claude-opus-5-5').text.evidence).toBe('docs')
  })

  it('promises only text for a model it does not know', () => {
    expect(yes('some-new-model')).toEqual(['text'])
    expect(modelInfo('some-new-model')).toBeNull()
  })
})
