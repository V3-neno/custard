import { afterEach, describe, expect, it } from 'vitest'
import { anthropicEndpoint, endpointFor, openaiEndpoint, pinProviderEndpoints } from './endpoints'

// L13: a packaged build never takes provider URLs from the environment.

afterEach(() => {
  pinProviderEndpoints(false)
  delete process.env.DEEPSEEK_BASE_URL
})

describe('provider endpoints', () => {
  it('pins the official endpoints in a packaged build', () => {
    pinProviderEndpoints(true)
    expect(anthropicEndpoint()).toEqual({ baseURL: 'https://api.anthropic.com' })
    expect(openaiEndpoint()).toEqual({ baseURL: 'https://api.openai.com/v1' })
    process.env.DEEPSEEK_BASE_URL = 'http://elsewhere'
    expect(endpointFor('deepseek')).toEqual({ baseURL: 'https://api.deepseek.com' })
  })

  it("never leaves DeepSeek to the OpenAI SDK's own address (its key would go to OpenAI)", () => {
    expect(endpointFor('deepseek')).toEqual({ baseURL: 'https://api.deepseek.com' })
    process.env.DEEPSEEK_BASE_URL = 'http://127.0.0.1:9'
    expect(endpointFor('deepseek')).toEqual({ baseURL: 'http://127.0.0.1:9' })
  })

  it('leaves development builds to the environment (used by the e2e mock)', () => {
    expect(anthropicEndpoint()).toEqual({})
    expect(openaiEndpoint()).toEqual({})
  })
})
