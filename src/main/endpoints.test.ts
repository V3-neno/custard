import { afterEach, describe, expect, it } from 'vitest'
import { anthropicEndpoint, openaiEndpoint, pinProviderEndpoints } from './endpoints'

// L13: a packaged build never takes provider URLs from the environment.

afterEach(() => pinProviderEndpoints(false))

describe('provider endpoints', () => {
  it('pins the official endpoints in a packaged build', () => {
    pinProviderEndpoints(true)
    expect(anthropicEndpoint()).toEqual({ baseURL: 'https://api.anthropic.com' })
    expect(openaiEndpoint()).toEqual({ baseURL: 'https://api.openai.com/v1' })
  })

  it('leaves development builds to the environment (used by the e2e mock)', () => {
    expect(anthropicEndpoint()).toEqual({})
    expect(openaiEndpoint()).toEqual({})
  })
})
