import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import type { ProviderErrorKind } from '../shared/adapter'
import { isContextError } from './context'

// A provider failure, the same shape whichever SDK threw it. `message` is
// the plain-language sentence for the user; `status` and `retryAfter` come
// from the response when there was one. Keys never appear in it: SDK error
// messages are the provider's own text, and Custard adds only its name.
export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    readonly provider: string,
    message: string,
    readonly status?: number,
    readonly retryAfter?: number,
    readonly cause?: unknown
  ) {
    super(message)
    this.name = 'ProviderError'
  }
}

const UNSUPPORTED =
  /not supported|unsupported|does not support|unknown parameter|unrecognized|not available/i

// What kind of failure an SDK error is. Anything that isn't an SDK error is
// 'unknown'.
export function errorKind(err: unknown): ProviderErrorKind {
  if (err instanceof ProviderError) return err.kind
  if (err instanceof Anthropic.APIUserAbortError || err instanceof OpenAI.APIUserAbortError)
    return 'aborted'
  if (err instanceof Anthropic.AuthenticationError || err instanceof OpenAI.AuthenticationError)
    return 'auth'
  if (err instanceof Anthropic.RateLimitError || err instanceof OpenAI.RateLimitError)
    return 'rate_limit'
  if (
    err instanceof Anthropic.APIConnectionTimeoutError ||
    err instanceof OpenAI.APIConnectionTimeoutError
  )
    return 'timeout'
  if (err instanceof Anthropic.APIConnectionError || err instanceof OpenAI.APIConnectionError)
    return 'network'
  if (err instanceof Anthropic.APIError || err instanceof OpenAI.APIError) {
    const s = err.status
    if (s === 529 || s === 503) return 'overloaded'
    if (isContextError(err)) return 'too_long'
    if (s === 403) return 'permission'
    if (s === 404) return 'model_not_found'
    if (s === 400 && UNSUPPORTED.test(err.message)) return 'unsupported'
    if (s && s >= 500) return 'server'
    if (s && s >= 400) return 'bad_request'
  }
  return 'unknown'
}

// Any error from a provider call as a ProviderError. The sentences are the
// ones Custard has always shown; only auth, rate limits, timeouts, network
// and overload have their own.
export function toProviderError(err: unknown, provider: string): ProviderError {
  if (err instanceof ProviderError) return err
  const kind = errorKind(err)
  const api = err instanceof Anthropic.APIError || err instanceof OpenAI.APIError ? err : null
  const status = api?.status
  const after = Number(api?.headers?.get?.('retry-after'))
  const retryAfter = after > 0 ? after : undefined
  const message = ((): string => {
    switch (kind) {
      case 'auth':
        return `Your ${provider} API key was rejected. Check it in Settings.`
      case 'rate_limit':
        return `${provider} is limiting requests right now.${retryAfter ? ` Try again in ${Math.ceil(retryAfter)} seconds.` : ' Try again shortly.'}`
      case 'timeout':
        return `${provider} took too long to answer.`
      case 'network':
        return `Couldn't reach ${provider}. Check your internet connection.`
      case 'overloaded':
        return `${provider} is overloaded right now. Try again shortly.`
    }
    if (api) return `${provider} returned an error${status ? ` (${status})` : ''}: ${api.message}`
    return err instanceof Error ? err.message : String(err)
  })()
  return new ProviderError(kind, provider, message, status, retryAfter, err)
}

// Plain-language provider errors.
export function describeError(err: unknown, provider: string): string {
  return toProviderError(err, provider).message
}
