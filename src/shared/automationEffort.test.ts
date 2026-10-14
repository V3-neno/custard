import { afterEach, describe, expect, it } from 'vitest'
import { effortControl, formEffort, runModelText } from './automationEffort'
import { builtInProfiles, profileOf, providerEffort, setProfiles } from './models'

// The effort control in Settings → Automations and the run list's model
// line (automation thinking, Phase 3).
afterEach(() => setProfiles(builtInProfiles))

const claude = providerEffort('claude')

describe('formEffort: what the form holds', () => {
  it('a new automation (nothing stored) gets the model’s otherwise level', () => {
    expect(formEffort('claude-opus-5-5', undefined)).toBe('medium')
    expect(formEffort('gpt-6-astra', undefined)).toBe('medium')
    expect(formEffort('deepseek-flash', undefined)).toBe('high')
  })

  it('a stored level the model lists is kept; one it does not becomes otherwise', () => {
    expect(formEffort('claude-opus-5-5', 'xhigh')).toBe('xhigh')
    expect(formEffort('deepseek-flash', 'max')).toBe('max')
    expect(formEffort('deepseek-flash', 'medium')).toBe('high')
    expect(formEffort('deepseek-flash', 'xhigh')).toBe('high')
  })

  it('changing the model re-maps as shownLevel does', () => {
    expect(formEffort('gpt-6-astra', 'xhigh')).toBe('xhigh')
    expect(formEffort('deepseek-v4-pro', 'xhigh')).toBe('high')
    expect(formEffort('claude-sonnet-5-5', 'high')).toBe('high')
  })

  it('a model with no effort holds none; one with no profile keeps what is stored', () => {
    expect(formEffort('claude-haiku-4-5', 'high')).toBeUndefined()
    expect(formEffort('claude-haiku-4-5', undefined)).toBeUndefined()
    expect(formEffort('claude-gone-1', 'high')).toBe('high')
    expect(formEffort('claude-gone-1', undefined)).toBeUndefined()
  })
})

describe('effortControl: what the control shows', () => {
  it('a new automation on Opus 5.5: Low to Max, Medium picked, the cost line, no note', () => {
    expect(effortControl('claude-opus-5-5', undefined, true, 'medium', claude)).toEqual({
      kind: 'levels',
      levels: [
        { value: 'low', label: 'Low' },
        { value: 'medium', label: 'Medium' },
        { value: 'high', label: 'High' },
        { value: 'xhigh', label: 'X-High' },
        { value: 'max', label: 'Max' }
      ],
      picked: 'medium',
      cost: 'Levels above Medium cost more.'
    })
  })

  it('DeepSeek: its own three labels, and the cost line names Balanced', () => {
    const c = effortControl('deepseek-flash', undefined, true, 'high', providerEffort('deepseek'))
    expect(c.kind === 'levels' && c.levels.map((l) => l.label)).toEqual([
      'Fast',
      'Balanced',
      'Thorough'
    ])
    expect(c.kind === 'levels' && c.cost).toBe('Levels above Balanced cost more.')
  })

  it('an old automation (nothing saved) says Not set and what saving sets', () => {
    const c = effortControl('claude-opus-5-5', undefined, false, 'medium', claude)
    expect(c.kind === 'levels' && c.note).toBe(
      "Not set (the provider's default). Saving sets Medium."
    )
    const picked = effortControl('claude-opus-5-5', undefined, false, 'max', claude)
    expect(picked.kind === 'levels' && picked.note).toBe(
      "Not set (the provider's default). Saving sets Max."
    )
  })

  it('a saved level the model lists: no note', () => {
    const c = effortControl('claude-opus-5-5', 'xhigh', false, 'xhigh', claude)
    expect(c).toMatchObject({ kind: 'levels', picked: 'xhigh' })
    expect('note' in c).toBe(false)
  })

  it('a saved level the model does not list: shown as sent, and said so', () => {
    const ds = providerEffort('deepseek')
    const c = effortControl('deepseek-flash', 'medium', false, 'high', ds)
    expect(c).toMatchObject({
      kind: 'levels',
      picked: 'high',
      note: "Saved as Medium, which DeepSeek Flash doesn't list, so it sends Balanced."
    })
    // Once another level is picked, the note no longer applies.
    expect('note' in effortControl('deepseek-flash', 'medium', false, 'max', ds)).toBe(false)
  })

  it('Haiku 4.5: greyed levels and its real name; a saved effort is named as removed', () => {
    expect(effortControl('claude-haiku-4-5', undefined, true, undefined, claude)).toEqual({
      kind: 'none',
      levels: claude!.levels.map((l) => ({ value: l.value, label: l.label })),
      note: 'Haiku 4.5 takes no effort level'
    })
    const c = effortControl('claude-haiku-4-5', 'high', false, undefined, claude)
    expect(c.kind === 'none' && c.note).toBe(
      'Haiku 4.5 takes no effort level. Saving removes the saved one (High)'
    )
  })

  it('a model with no profile: no levels, the saved effort kept', () => {
    expect(effortControl('claude-gone-1', 'high', false, 'high', claude)).toEqual({
      kind: 'no-profile',
      note: "claude-gone-1 has no profile, so its effort levels can't be shown. The saved effort (High) is kept."
    })
    expect(effortControl('claude-gone-1', undefined, false, undefined, claude)).toMatchObject({
      kind: 'no-profile',
      note: expect.stringMatching(/No effort is saved\.$/)
    })
  })

  it('a renamed model (models file) uses its label', () => {
    setProfiles(
      builtInProfiles.map((p) => (p.id === 'claude-opus-5-5' ? { ...p, label: 'Opus (mine)' } : p))
    )
    expect(profileOf('claude-opus-5-5')!.label).toBe('Opus (mine)')
    const c = effortControl('claude-opus-5-5', undefined, false, 'medium', claude)
    expect(c.kind === 'levels' && c.note).toMatch(/^Not set/)
    expect(runModelText({ model: 'claude-opus-5-5', effort: 'max' })).toBe('Opus (mine) · Max')
  })
})

describe('runModelText: the run list', () => {
  it('model and effort, by label', () => {
    expect(runModelText({ model: 'claude-opus-5-5', effort: 'high' })).toBe('Opus 5.5 · High')
    expect(runModelText({ model: 'gpt-6-astra', effort: 'xhigh' })).toBe('GPT-6 Astra · X-High')
    expect(runModelText({ model: 'deepseek-flash', effort: 'max' })).toBe(
      'DeepSeek Flash · Thorough'
    )
  })

  it('a DeepSeek record with an unlisted level shows what was sent', () => {
    expect(runModelText({ model: 'deepseek-flash', effort: 'medium' })).toBe(
      'DeepSeek Flash · Balanced'
    )
  })

  it('no effort, a model that takes none, and an unknown model', () => {
    expect(runModelText({ model: 'claude-opus-5-5' })).toBe('Opus 5.5 · effort not set')
    expect(runModelText({ model: 'claude-haiku-4-5' })).toBe('Haiku 4.5')
    expect(runModelText({ model: 'claude-haiku-4-5', effort: 'high' })).toBe('Haiku 4.5')
    expect(runModelText({ model: 'claude-gone-1', effort: 'high' })).toBe('claude-gone-1 · High')
    expect(runModelText({ model: 'claude-gone-1' })).toBe('claude-gone-1 · effort not set')
  })

  it('an older record without them shows nothing new', () => {
    expect(runModelText({})).toBeNull()
  })
})
