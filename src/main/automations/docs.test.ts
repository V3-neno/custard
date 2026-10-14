import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'
import { CLAUDE_STEP_TOKENS } from './model'

// Automation thinking, Phase 2: the docs say what steps send now, and no
// longer name what was removed (the 16,000-token step limit, effort in
// "every request", automations for Claude or OpenAI only).
const doc = (name: string): string => readFileSync(`docs/${name}`, 'utf8')
const comment = (file: string): string => readFileSync(`src/main/adapters/${file}`, 'utf8')

describe('docs and comments about automation steps', () => {
  it('no longer name the old limit or "every request"', () => {
    const providers = doc('providers.md')
    expect(providers).not.toMatch(/16,000-token limit/)
    expect(providers).not.toMatch(/goes into every request \(`streamMessage` and `sendMessage`\)/)
    expect(providers).toContain(`${CLAUDE_STEP_TOKENS.toLocaleString('en-US')}-token limit`)
    expect(doc('automations.md')).not.toMatch(/\(Claude or OpenAI\)/)
    expect(doc('automations.md')).toMatch(/Claude, OpenAI or DeepSeek/)
  })

  it('the adapter comments no longer say the one-shot model is always Haiku', () => {
    expect(comment('anthropic.ts')).not.toMatch(/the one-shot calls use Haiku 4\.5/)
    expect(comment('types.ts')).not.toMatch(/Responses providers only/)
  })

  it('the models file docs state the Haiku 4.5 effort rule', () => {
    expect(doc('models-file.md')).toMatch(/Haiku 4\.5 takes no effort/)
  })
})
