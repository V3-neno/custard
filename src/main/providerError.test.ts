import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { describe, expect, it } from 'vitest'
import { describeError, errorKind, toProviderError } from './providerError'

const h = (extra: Record<string, string> = {}): Headers => new Headers(extra)
const a = (status: number, message: string, headers = h()): Error =>
  Anthropic.APIError.generate(status, { error: { message } }, message, headers)
const o = (status: number, message: string, headers = h()): Error =>
  OpenAI.APIError.generate(status, { error: { message } }, message, headers)

describe('provider error kinds', () => {
  it('reads the same kind from either SDK', () => {
    for (const make of [a, o]) {
      expect(errorKind(make(401, 'bad key'))).toBe('auth')
      expect(errorKind(make(403, 'no access'))).toBe('permission')
      expect(errorKind(make(404, 'no such model'))).toBe('model_not_found')
      expect(errorKind(make(429, 'slow'))).toBe('rate_limit')
      expect(errorKind(make(503, 'busy'))).toBe('overloaded')
      expect(errorKind(make(500, 'oops'))).toBe('server')
      expect(errorKind(make(400, 'parameter foo is not supported'))).toBe('unsupported')
      expect(errorKind(make(422, 'bad'))).toBe('bad_request')
    }
    expect(errorKind(a(529, 'overloaded'))).toBe('overloaded')
    expect(errorKind(a(400, 'prompt is too long: 1200000 tokens'))).toBe('too_long')
    expect(errorKind(o(400, 'maximum context length exceeded'))).toBe('too_long')
    expect(errorKind(new Anthropic.APIConnectionError({ message: 'x' }))).toBe('network')
    expect(errorKind(new OpenAI.APIConnectionTimeoutError())).toBe('timeout')
    expect(errorKind(new OpenAI.APIUserAbortError())).toBe('aborted')
    expect(errorKind(new Error('plain'))).toBe('unknown')
  })

  it('keeps the sentences Custard has always shown', () => {
    expect(describeError(a(401, 'x'), 'Claude')).toBe(
      'Your Claude API key was rejected. Check it in Settings.'
    )
    expect(describeError(o(429, 'x', h({ 'retry-after': '12' })), 'DeepSeek')).toBe(
      'DeepSeek is limiting requests right now. Try again in 12 seconds.'
    )
    expect(describeError(o(429, 'x'), 'OpenAI')).toBe(
      'OpenAI is limiting requests right now. Try again shortly.'
    )
    expect(describeError(new OpenAI.APIConnectionTimeoutError(), 'OpenAI')).toBe(
      'OpenAI took too long to answer.'
    )
    expect(describeError(new Anthropic.APIConnectionError({ message: 'x' }), 'Claude')).toBe(
      "Couldn't reach Claude. Check your internet connection."
    )
    expect(describeError(a(529, 'x'), 'Claude')).toBe(
      'Claude is overloaded right now. Try again shortly.'
    )
    expect(describeError(o(404, 'The model `gpt-x` does not exist'), 'OpenAI')).toMatch(
      /^OpenAI returned an error \(404\): /
    )
    expect(describeError(new Error('plain'), 'Claude')).toBe('plain')
  })

  it('keeps the status and retry time', () => {
    const e = toProviderError(a(429, 'x', h({ 'retry-after': '3' })), 'Claude')
    expect(e).toMatchObject({ kind: 'rate_limit', status: 429, retryAfter: 3, provider: 'Claude' })
    expect(toProviderError(e, 'Other')).toBe(e)
  })
})
